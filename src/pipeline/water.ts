/**
 * 段3「水系」: 主河川・湖・岸線・湿地/砂洲・外周の閉じ方を確定する。
 * データの正は docs/internal/contracts/ground-water.md(Water 節)、
 * 設計は implementation-spec 1.3節・1.6節・PHASE 2。
 *
 * - 主河川: derived.riverCount 本(0〜2)。外縁の外側の一点から箱庭を横断して
 *   別点へ抜けるスプライン。低周波ノイズで有機的に蛇行させる
 *   (乱数は makeRng(seed, "water/river/<i>") のサブストリーム。
 *   蛇行の形は格子ノイズで作り、点数の増減が乱数消費に波及しない)
 * - 湖: derived.lakeChance / lakeArea 駆動。川があれば経路上に置き、
 *   スプラインが湖を貫通することで流入・流出接続を持つ
 * - 水域合計面積は ground 面積 × derived.waterAreaCap を上限にクリップ
 *   (超過時は湖面積・川幅を縮小する決定論的な反復。乱数は消費しない)
 * - 湿地・砂洲を岸辺周辺の zoneMask チャネルへ書き込む(commit 7 で予約済み)
 * - edgeStyle: 選択確率を Water Presence に連動させ、Water 15 未満は "fog" 固定
 * - Water 0(水域なし)でも乾いた土地として破綻しない
 */
import { makeRng } from "../rng";
import type {
  Polygon,
  ShoreLoop,
  Spline,
  Vec2,
  WorldModel,
} from "../model/worldmodel";
import { zoneCellIndex } from "../model/zonemask";
import {
  GRID_SPAN_RATIO,
  createBoundaryRadius,
  createWaterField,
  estimateWaterArea,
  fieldGradient,
  gridCellCount,
  marchPositiveRegion,
  polygonArea,
  type WaterField,
} from "../model/waterfield";
import { fbm2D, noiseSeed } from "./noise";

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

function smoothstep(edge0: number, edge1: number, v: number): number {
  const t = clamp((v - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** 河口を境界の外へ張り出させる量(境界半径比)。切れ目を霧・外縁水面の中へ隠す */
const MOUTH_OVERHANG = 1.18;
/** 蛇行の振幅(ワールド一辺比)。低周波ノイズで有機的に曲げる */
const MEANDER_RATIO = 0.1;
/** 川スプラインの隣接点間隔(川幅比)。契約の「隣接間隔 ≤ 川幅×1.5」を満たす */
const RIVER_SAMPLE_RATIO = 0.7;
/** 面積クリップの最大反復(決定論的。乱数は消費しない) */
const AREA_CLIP_ITERATIONS = 6;
/** クリップ後も残す川幅の下限(見た目の破綻防止。面積は湖の縮小が受け持つ) */
const RIVER_WIDTH_FLOOR = 3;

/** 河川の生成パラメータ(乱数消費はここで完結し、再サンプルでは消費しない) */
interface RiverParams {
  theta0: number;
  spread: number;
  meander: number;
  phase: number;
}

/** 消費順・消費数固定: 1河川 = 4値 */
function drawRiverParams(seed: string, index: number): RiverParams {
  const rng = makeRng(seed, `water/river/${index}`);
  return {
    theta0: rng.range(0, Math.PI * 2),
    spread: rng.range(-0.55, 0.55),
    meander: rng.range(0.6, 1.0),
    phase: rng.range(0, 64),
  };
}

/**
 * 河川スプラインの点列を作る(純関数)。
 * 外縁の外側の一点から反対側の外側へ抜ける弦を、弦と直交する方向に
 * 低周波ノイズでずらして蛇行させる。両端は境界の外に固定する。
 */
function riverPath(
  seed: string,
  index: number,
  params: RiverParams,
  size: number,
  radius: (theta: number) => number,
  width: number,
): Vec2[] {
  const theta1 = params.theta0 + Math.PI + params.spread;
  const r0 = radius(params.theta0) * MOUTH_OVERHANG;
  const r1 = radius(theta1) * MOUTH_OVERHANG;
  const start = { x: Math.cos(params.theta0) * r0, z: Math.sin(params.theta0) * r0 };
  const end = { x: Math.cos(theta1) * r1, z: Math.sin(theta1) * r1 };
  const dx = end.x - start.x;
  const dz = end.z - start.z;
  const length = Math.hypot(dx, dz);
  const perp = { x: -dz / length, z: dx / length };
  const count = clamp(Math.ceil(length / (width * RIVER_SAMPLE_RATIO)), 40, 220);
  const amp = size * MEANDER_RATIO * params.meander;
  const nSeed = noiseSeed(seed, `water/river/${index}`);

  const points: Vec2[] = [];
  for (let i = 0; i <= count; i++) {
    const t = i / count;
    // 端(河口)は境界の外に固定するため、蛇行を sin 包絡で0に落とす
    const envelope = Math.sin(Math.PI * t);
    const noise = fbm2D(nSeed, t * 3 + params.phase, 0, 3);
    const offset = (noise * 2 - 1) * amp * envelope;
    points.push({
      x: start.x + dx * t + perp.x * offset,
      z: start.z + dz * t + perp.z * offset,
    });
  }
  return points;
}

/** 湖の生成パラメータ(消費順・消費数固定: 12値) */
interface LakeParams {
  roll: number;
  tAlong: number;
  angle: number;
  radFrac: number;
  harmonics: { k: number; amp: number; phase: number }[];
}

function drawLakeParams(seed: string): LakeParams {
  const rng = makeRng(seed, "water/lake");
  const roll = rng.next();
  const tAlong = rng.range(0.3, 0.7);
  const angle = rng.range(0, Math.PI * 2);
  const radFrac = rng.range(0.15, 0.45);
  const harmonics = [2, 3, 4, 5].map((k) => ({
    k,
    amp: (0.3 / k) * rng.range(0.4, 1.0),
    phase: rng.range(0, Math.PI * 2),
  }));
  return { roll, tAlong, angle, radFrac, harmonics };
}

/**
 * 湖ポリゴンを作る(純関数)。境界と同じ調和波の星形ブロブで、
 * 偏角を減少方向に回して時計回り(Polygon 規約)にする。
 */
function lakePolygon(center: Vec2, baseRadius: number, params: LakeParams): Polygon {
  const count = 40;
  const points: Polygon = [];
  for (let i = 0; i < count; i++) {
    const theta = -(i / count) * Math.PI * 2;
    let r = 1;
    for (const h of params.harmonics) r += h.amp * Math.cos(h.k * theta + h.phase);
    points.push({
      x: center.x + baseRadius * r * Math.cos(theta),
      z: center.z + baseRadius * r * Math.sin(theta),
    });
  }
  return points;
}

/** 湖の中心を決める。川があれば経路上(流入・流出)、なければ境界内の一点 */
function lakeCenter(
  params: LakeParams,
  rivers: Spline[],
  radius: (theta: number) => number,
  lakeRadius: number,
): Vec2 {
  let center: Vec2;
  const first = rivers[0];
  if (first && first.points.length > 0) {
    const idx = Math.round(params.tAlong * (first.points.length - 1));
    center = first.points[idx] ?? { x: 0, z: 0 };
  } else {
    const r = params.radFrac * radius(params.angle);
    center = {
      x: Math.cos(params.angle) * r,
      z: Math.sin(params.angle) * r,
    };
  }
  // 湖が境界の外へ大きくはみ出さないよう中心を原点側へ引き込む(決定論的)
  for (let i = 0; i < 8; i++) {
    const dist = Math.hypot(center.x, center.z);
    if (dist < 1e-6) break;
    const room = radius(Math.atan2(center.z, center.x)) - dist;
    if (room >= lakeRadius * 0.7) break;
    center = { x: center.x * 0.88, z: center.z * 0.88 };
  }
  return center;
}

/**
 * 岸線を抽出する。地面の三角形分割と同じ陸地関数の等値線
 * (model/waterfield.ts)から、水域が活性な区間を岸線ループとして取り出す。
 */
function extractShoreline(
  field: WaterField,
  size: number,
): { cellSize: number; loops: ShoreLoop[] } {
  const cells = gridCellCount(size);
  const cellSize = (size * GRID_SPAN_RATIO) / cells;
  const march = marchPositiveRegion(field.landSdf, size, cells);
  const loops: ShoreLoop[] = [];
  let counter = 0;

  const makeLoop = (points: Vec2[], closed: boolean): ShoreLoop => ({
    id: `shore/${counter++}`,
    closed,
    points,
    normals: points.map((p) => {
      const g = fieldGradient(field.waterSdf, p.x, p.z);
      const len = Math.hypot(g.x, g.z);
      return len > 1e-9 ? { x: g.x / len, z: g.z / len } : { x: 1, z: 0 };
    }),
  });

  for (const contour of march.contours) {
    const pts = contour.points;
    const n = pts.length;
    if (n < 2) continue;
    const segCount = contour.closed ? n : n - 1;
    // 各セグメントの中点で「水域」と「外縁境界」のどちらが活性かを判定する
    const isShore: boolean[] = [];
    let shoreCount = 0;
    for (let i = 0; i < segCount; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % n];
      if (!a || !b) {
        isShore.push(false);
        continue;
      }
      const mx = (a.x + b.x) / 2;
      const mz = (a.z + b.z) / 2;
      const shore = field.waterSdf(mx, mz) <= field.boundarySdf(mx, mz);
      isShore.push(shore);
      if (shore) shoreCount++;
    }
    if (shoreCount === 0) continue;
    if (shoreCount === segCount && contour.closed) {
      loops.push(makeLoop(pts.slice(), true));
      continue;
    }
    // 水域が活性な連続区間ごとに開いた岸線として切り出す(環はまたぎを考慮)
    const runStarts: number[] = [];
    for (let i = 0; i < segCount; i++) {
      const prev = contour.closed
        ? (isShore[(i - 1 + segCount) % segCount] ?? false)
        : i > 0 && (isShore[i - 1] ?? false);
      if ((isShore[i] ?? false) && !prev) runStarts.push(i);
    }
    if (runStarts.length === 0 && (isShore[0] ?? false)) runStarts.push(0);
    for (const startSeg of runStarts) {
      const runPts: Vec2[] = [];
      const firstPt = pts[startSeg % n];
      if (firstPt) runPts.push(firstPt);
      for (let k = 0; k < segCount; k++) {
        const segIdx = (startSeg + k) % segCount;
        if (!(isShore[segIdx] ?? false)) break;
        const p = pts[(segIdx + 1) % n];
        if (p) runPts.push(p);
      }
      if (runPts.length >= 2) loops.push(makeLoop(runPts, false));
    }
  }
  return { cellSize, loops };
}

/** 湿地・砂洲を岸辺周辺の zoneMask チャネルへ書き込む(contracts/ground-water.md) */
function writeShoreZones(model: WorldModel, field: WaterField): void {
  const { seed, derived } = { seed: model.meta.seed, derived: model.meta.derived };
  const mask = model.ground.zoneMask;
  const sandW = 2.2 + 4.5 * derived.sandbarAmount;
  const marshW = 5 + 15 * derived.marshAmount;
  const reach = Math.max(sandW, marshW);
  const sandSeed = noiseSeed(seed, "water/sandbar");
  const marshSeed = noiseSeed(seed, "water/marsh");
  const half = (mask.resolution * mask.cellSize) / 2;

  for (let iz = 0; iz < mask.resolution; iz++) {
    for (let ix = 0; ix < mask.resolution; ix++) {
      const x = (ix + 0.5) * mask.cellSize - half;
      const z = (iz + 0.5) * mask.cellSize - half;
      if (field.boundarySdf(x, z) < -mask.cellSize) continue;
      const d = field.waterSdf(x, z);
      if (d > reach) continue;
      // 水中のセルも水際扱いにし、岸の頂点色が砂寄りに補間されるようにする
      const dl = Math.max(0, d);

      const sandNoise = 0.55 + 0.45 * fbm2D(sandSeed, x / 18, z / 18, 2);
      let sand =
        derived.sandbarAmount <= 0
          ? 0
          : (1 - clamp(dl / sandW, 0, 1)) *
            sandNoise *
            (0.5 + 0.5 * derived.sandbarAmount);

      const marshPatch = smoothstep(0.5, 0.72, fbm2D(marshSeed, x / 26, z / 26, 3));
      let marsh =
        (1 - clamp(dl / marshW, 0, 1)) *
        marshPatch *
        Math.min(1, derived.marshAmount * 1.6);
      // 水際の直近は砂洲を優先し、湿地はやや引いた帯に出す
      marsh *= clamp(dl / (sandW * 0.6), 0.15, 1);

      let total = sand + marsh;
      if (total <= 0.001) continue;
      if (total > 0.96) {
        sand *= 0.96 / total;
        marsh *= 0.96 / total;
        total = 0.96;
      }
      const w = zoneCellIndex(mask, ix, iz);
      const keep = 1 - total;
      mask.weights[w] = (mask.weights[w] ?? 0) * keep; // grass
      mask.weights[w + 1] = (mask.weights[w + 1] ?? 0) * keep; // dirt
      mask.weights[w + 2] = sand; // sandbar
      mask.weights[w + 3] = marsh; // marsh
    }
  }
}

/** パイプライン段の実体: water 一式・edgeStyle・zoneMask(湿地/砂洲)を埋める */
export function runWater(model: WorldModel): void {
  const { seed, params, derived } = model.meta;
  const size = model.ground.size;
  const boundary = model.ground.boundary;
  const radius = createBoundaryRadius(boundary);

  // 段の親ストリーム。消費数は入力に依らず固定(edgeStyle の1値のみ)
  const rng = makeRng(seed, "water");
  const edgeRoll = rng.next();

  // 河川・湖のパラメータを先に確定する(乱数消費はここで完結)
  const riverParams: RiverParams[] = [];
  for (let i = 0; i < derived.riverCount; i++) {
    riverParams.push(drawRiverParams(seed, i));
  }
  const lakeParams = drawLakeParams(seed);
  const hasLake = derived.lakeChance > 0 && lakeParams.roll < derived.lakeChance;

  const groundArea = polygonArea(boundary);
  const capArea = groundArea * derived.waterAreaCap;

  // 幅・湖半径のスケールを縮めながら waterAreaCap 以下へクリップする(決定論的)
  let widthScale = 1;
  let lakeScale = 1;
  let rivers: Spline[] = [];
  let lakes: Polygon[] = [];
  let field: WaterField = createWaterField(boundary, [], []);
  for (let iter = 0; iter < AREA_CLIP_ITERATIONS; iter++) {
    const width = Math.max(RIVER_WIDTH_FLOOR, derived.riverWidth * widthScale);
    rivers = riverParams.map((p, i) => ({
      points: riverPath(seed, i, p, size, radius, width),
      width,
    }));
    lakes = [];
    if (hasLake) {
      const lakeRadius =
        Math.sqrt((derived.lakeArea * groundArea) / Math.PI) * lakeScale;
      const center = lakeCenter(lakeParams, rivers, radius, lakeRadius);
      lakes.push(lakePolygon(center, lakeRadius, lakeParams));
    }
    field = createWaterField(boundary, rivers, lakes);
    if (rivers.length === 0 && lakes.length === 0) break;
    const area = estimateWaterArea(field, size);
    if (area <= capArea) break;
    const s = Math.sqrt(capArea / area);
    widthScale *= s;
    lakeScale *= s;
  }

  model.water.rivers = rivers;
  model.water.lakes = lakes;
  model.water.shoreline = extractShoreline(field, size);

  // 湿地・砂洲(水域があるときのみ。Water 0 では zoneMask は下地のまま)
  if (rivers.length > 0 || lakes.length > 0) {
    writeShoreZones(model, field);
  }

  // 外周の閉じ方: 選択確率は Water Presence 連動。Water 15 未満は "fog" 固定
  const waterEdgeChance =
    params.water < 15 ? 0 : clamp((params.water - 15) / 85, 0, 1) * 0.85;
  model.ground.edgeStyle = edgeRoll < waterEdgeChance ? "water" : "fog";

  // サマリー(段13 の担当だが、中間PHASEでは部分的に埋める)
  model.summary.waterOverview.rivers = rivers.length;
  model.summary.waterOverview.lakes = lakes.length;

  // パイプライン内アサーション: 違反は throw せず件数を console に出す
  // (implementation-spec 1.10節)
  let violations = 0;
  if (rivers.length > 0 || lakes.length > 0) {
    const area = estimateWaterArea(field, size);
    if (area > capArea * 1.02) violations++;
  }
  for (const river of rivers) {
    const head = river.points[0];
    const tail = river.points[river.points.length - 1];
    if (!head || !tail) {
      violations++;
      continue;
    }
    // 両端は境界の外(契約: 外縁の外側から外側へ抜ける)
    if (field.boundarySdf(head.x, head.z) > 0) violations++;
    if (field.boundarySdf(tail.x, tail.z) > 0) violations++;
    for (let i = 0; i + 1 < river.points.length; i++) {
      const a = river.points[i];
      const b = river.points[i + 1];
      if (!a || !b) continue;
      if (Math.hypot(b.x - a.x, b.z - a.z) > river.width * 1.5) violations++;
    }
  }
  if (violations > 0) {
    console.warn(`water: パイプライン内アサーション違反 ${violations} 件`);
  }
}
