/**
 * 段3「水系」: 湖・池・岸線・湿地/砂洲・外周の閉じ方を確定する。
 * データの正は docs/internal/contracts/ground-water.md(Water 節)、
 * 設計は implementation-spec 1.3節・1.6節・PHASE 2。
 *
 * - 湖: derived.lakeChance で存否を決め、0〜1個。位置候補(角度 θ・境界半径比
 *   r ∈ [0.15, 0.55])を固定数(6組)先に引き切り、境界クリアランス
 *   (湖半径 × 0.25 + 8 を目安)を満たす最初の候補を採用する
 *   (乱数は makeRng(seed, "water/lake") のサブストリーム。全候補が不適なら湖なし)
 * - 池: derived.pondCount 個(0〜4)。各池は makeRng(seed, "water/pond/<i>")
 *   から湖と同様に位置候補を6組引き、(a) 境界クリアランス、(b) 既存水域
 *   (湖・先行して確定した池)との最小間隔(半径和 × 1.6 を目安)を満たす
 *   最初の候補を採用する。満たせない池は棄却し、その分だけ本数が減る
 * - 湖・池は同じ幾何(星形ブロブ `lakePolygon`)を流用するが、生成意図と
 *   サマリー表示を保つため配列を分けて持つ(contracts/ground-water.md)
 * - 水域合計面積は ground 面積 × derived.waterAreaCap を上限にクリップ
 *   (超過時は確定済みの湖・池の半径を一括スケールして縮小する決定論的な
 *   反復。乱数は消費しない)
 * - 湿地・砂洲を岸辺周辺の zoneMask チャネルへ書き込む(commit 7 で予約済み)
 * - edgeStyle: 選択確率を Water Presence に連動させ、Water 15 未満は "fog" 固定
 * - Water 0(水域なし)でも乾いた土地として破綻しない
 */
import { makeRng, type Rng } from "../rng";
import type { Polygon, ShoreLoop, Vec2, WorldModel } from "../model/worldmodel";
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

/** 面積クリップの最大反復(決定論的。乱数は消費しない) */
const AREA_CLIP_ITERATIONS = 6;
/** 位置候補の本数(湖・池とも同じ)。全候補が不適なら棄却する */
const CANDIDATE_COUNT = 6;
/** 位置候補の境界半径比の範囲(contracts/ground-water.md Water 節) */
const RAD_FRAC_MIN = 0.15;
const RAD_FRAC_MAX = 0.55;
/**
 * 境界クリアランス(目安: 半径 × 0.25 + 8。contracts/ground-water.md Water 節)。
 * 星形ブロブは調和波の合成次第で基準半径の最大 1.4 倍前後まで膨らみうるため、
 * 中心から境界までの距離だけで判定すると縁が境界の外へはみ出す候補を
 * 誤って採択しうる(実装中に発見)。そのため実際の判定はポリゴンの全頂点
 * (縁そのもの)の境界クリアランスで行い、この係数は頂点ごとの最小マージン
 * (目安の "+8" 相当)として使う
 */
const BOUNDARY_EDGE_MARGIN = 8;
/** 池と既存水域の最小間隔の係数(目安: 半径和 × 1.6) */
const POND_SEPARATION_RATIO = 1.6;

/** 位置候補(角度・境界半径比) */
interface Candidate {
  angle: number;
  radFrac: number;
}

/** 星形ブロブの調和波(既存 lakePolygon の形状パラメータ) */
interface Harmonic {
  k: number;
  amp: number;
  phase: number;
}

/** 湖の生成パラメータ(消費順・消費数固定: roll(1) + 候補6組(12) + 調和波4組(8) = 21値) */
interface LakeParams {
  roll: number;
  candidates: Candidate[];
  harmonics: Harmonic[];
}

/** 池の生成パラメータ(消費順・消費数固定: 候補6組(12) + 調和波4組(8) = 20値) */
interface PondParams {
  candidates: Candidate[];
  harmonics: Harmonic[];
}

function drawCandidates(rng: Rng): Candidate[] {
  const candidates: Candidate[] = [];
  for (let i = 0; i < CANDIDATE_COUNT; i++) {
    candidates.push({
      angle: rng.range(0, Math.PI * 2),
      radFrac: rng.range(RAD_FRAC_MIN, RAD_FRAC_MAX),
    });
  }
  return candidates;
}

function drawHarmonics(rng: Rng): Harmonic[] {
  return [2, 3, 4, 5].map((k) => ({
    k,
    amp: (0.3 / k) * rng.range(0.4, 1.0),
    phase: rng.range(0, Math.PI * 2),
  }));
}

/** 湖の生成パラメータを引く(乱数消費は入力に依らず固定) */
function drawLakeParams(seed: string): LakeParams {
  const rng = makeRng(seed, "water/lake");
  const roll = rng.next();
  const candidates = drawCandidates(rng);
  const harmonics = drawHarmonics(rng);
  return { roll, candidates, harmonics };
}

/**
 * i 番目の池の生成パラメータを引く(乱数消費は入力に依らず固定)。
 * 呼び出しは derived.pondCount 個ぶんのみ行う(旧・水系生成の「本数個ぶんだけ
 * 消費」と同型の消費スタイル。pondCount は seed+params の純関数のため
 * 決定性は保たれる)。
 */
function drawPondParams(seed: string, index: number): PondParams {
  const rng = makeRng(seed, `water/pond/${index}`);
  const candidates = drawCandidates(rng);
  const harmonics = drawHarmonics(rng);
  return { candidates, harmonics };
}

/**
 * 星形ブロブポリゴンを作る(純関数)。湖・池が共有する幾何
 * (contracts/ground-water.md「湖と池は同じ幾何を流用」)。
 * 偏角を減少方向に回して時計回り(Polygon 規約)にする。
 */
function lakePolygon(
  center: Vec2,
  baseRadius: number,
  harmonics: Harmonic[],
): Polygon {
  const count = 40;
  const points: Polygon = [];
  for (let i = 0; i < count; i++) {
    const theta = -(i / count) * Math.PI * 2;
    let r = 1;
    for (const h of harmonics) r += h.amp * Math.cos(h.k * theta + h.phase);
    points.push({
      x: center.x + baseRadius * r * Math.cos(theta),
      z: center.z + baseRadius * r * Math.sin(theta),
    });
  }
  return points;
}

/** 候補(角度・境界半径比)から中心座標を作る */
function candidateCenter(
  radius: (theta: number) => number,
  candidate: Candidate,
): Vec2 {
  const r = candidate.radFrac * radius(candidate.angle);
  return { x: Math.cos(candidate.angle) * r, z: Math.sin(candidate.angle) * r };
}

/**
 * ポリゴンの全頂点が境界クリアランス(margin)を保って境界の内側にあるか
 * (縁=頂点ごとの判定。星形ブロブは調和波次第で基準半径を大きく超えて
 * 膨らむ方向がありうるため、中心からの距離ではなく実際の頂点で判定する)
 */
function polygonWithinBoundary(
  radius: (theta: number) => number,
  polygon: Polygon,
  margin: number,
): boolean {
  for (const v of polygon) {
    const dist = Math.hypot(v.x, v.z);
    if (radius(Math.atan2(v.z, v.x)) - dist < margin) return false;
  }
  return true;
}

/** 確定済みの水域(湖・先行する池)。池の最小間隔判定に使う */
interface PlacedBody {
  center: Vec2;
  radius: number;
}

/**
 * 湖の位置を決める。6候補を順に試し、実際の湖ポリゴン(調和波込み)の
 * 全頂点が境界クリアランス(目安 8)を満たす最初の候補を採用する。
 * 全候補不適なら null(湖なし。contracts/ground-water.md Water 節)。
 */
function placeLake(
  radius: (theta: number) => number,
  lakeRadius: number,
  params: LakeParams,
  hasLake: boolean,
): Vec2 | null {
  if (!hasLake) return null;
  for (const candidate of params.candidates) {
    const center = candidateCenter(radius, candidate);
    const poly = lakePolygon(center, lakeRadius, params.harmonics);
    if (polygonWithinBoundary(radius, poly, BOUNDARY_EDGE_MARGIN)) return center;
  }
  return null; // 全候補が境界クリアランスを満たさない: 湖なし
}

/**
 * 池の位置を決める。6候補を順に試し、(a) 実際の池ポリゴンの全頂点が
 * 境界クリアランス(目安 8)を満たす、(b) 中心が既存水域(湖・先行する池)
 * との最小間隔(半径和 × 1.6)を満たす、の両方を満たす最初の候補を採用する。
 * 満たせない場合は null(その池は棄却。contracts/ground-water.md Water 節)。
 */
function placePond(
  radius: (theta: number) => number,
  pondRadius: number,
  params: PondParams,
  existing: PlacedBody[],
): Vec2 | null {
  for (const candidate of params.candidates) {
    const center = candidateCenter(radius, candidate);
    let ok = true;
    for (const body of existing) {
      const dist = Math.hypot(center.x - body.center.x, center.z - body.center.z);
      if (dist < (pondRadius + body.radius) * POND_SEPARATION_RATIO) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    const poly = lakePolygon(center, pondRadius, params.harmonics);
    if (polygonWithinBoundary(radius, poly, BOUNDARY_EDGE_MARGIN)) return center;
  }
  return null;
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

  // 湖・池のパラメータと配置を先に確定する(乱数消費はここで完結。
  // 面積クリップは半径の一括スケールのみで、配置(中心座標)は変えない)
  const lakeParams = drawLakeParams(seed);
  const hasLake = derived.lakeChance > 0 && lakeParams.roll < derived.lakeChance;

  const groundArea = polygonArea(boundary);
  const capArea = groundArea * derived.waterAreaCap;
  const lakeRadius0 = Math.sqrt((derived.lakeArea * groundArea) / Math.PI);
  const pondRadius0 = Math.sqrt((derived.pondArea * groundArea) / Math.PI);

  const lakeCenter = placeLake(radius, lakeRadius0, lakeParams, hasLake);

  const placedBodies: PlacedBody[] = [];
  if (lakeCenter) placedBodies.push({ center: lakeCenter, radius: lakeRadius0 });

  const acceptedPonds: { center: Vec2; params: PondParams }[] = [];
  for (let i = 0; i < derived.pondCount; i++) {
    const pondParams = drawPondParams(seed, i);
    const center = placePond(radius, pondRadius0, pondParams, placedBodies);
    if (center) {
      acceptedPonds.push({ center, params: pondParams });
      placedBodies.push({ center, radius: pondRadius0 });
    }
  }

  // 面積クリップ: 湖・池の半径を一括スケールして waterAreaCap 以下へ縮小する
  // (既存の AREA_CLIP_ITERATIONS の反復縮小を読み替えて維持。乱数非消費)
  let scale = 1;
  let lakes: Polygon[] = [];
  let ponds: Polygon[] = [];
  let field: WaterField = createWaterField(boundary, []);
  for (let iter = 0; iter < AREA_CLIP_ITERATIONS; iter++) {
    lakes = lakeCenter
      ? [lakePolygon(lakeCenter, lakeRadius0 * scale, lakeParams.harmonics)]
      : [];
    ponds = acceptedPonds.map(({ center, params }) =>
      lakePolygon(center, pondRadius0 * scale, params.harmonics),
    );
    const bodies = [...lakes, ...ponds];
    field = createWaterField(boundary, bodies);
    if (bodies.length === 0) break;
    const area = estimateWaterArea(field, size);
    if (area <= capArea) break;
    scale *= Math.sqrt(capArea / area);
  }

  model.water.lakes = lakes;
  model.water.ponds = ponds;
  model.water.shoreline = extractShoreline(field, size);

  // 湿地・砂洲(水域があるときのみ。Water 0 では zoneMask は下地のまま)
  if (lakes.length > 0 || ponds.length > 0) {
    writeShoreZones(model, field);
  }

  // 外周の閉じ方: 選択確率は Water Presence 連動。Water 15 未満は "fog" 固定
  const waterEdgeChance =
    params.water < 15 ? 0 : clamp((params.water - 15) / 85, 0, 1) * 0.85;
  model.ground.edgeStyle = edgeRoll < waterEdgeChance ? "water" : "fog";

  // サマリー(段16 の担当だが、中間PHASEでは部分的に埋める)
  model.summary.waterOverview.lakes = lakes.length;
  model.summary.waterOverview.ponds = ponds.length;

  // パイプライン内アサーション: 違反は throw せず件数を console に出す
  // (implementation-spec 1.10節)
  let violations = 0;
  if (lakes.length > 1) violations++;
  if (ponds.length > 4) violations++;
  const bodies = [...lakes, ...ponds];
  if (bodies.length > 0) {
    const area = estimateWaterArea(field, size);
    if (area > capArea * 1.02) violations++;
  }
  for (const body of bodies) {
    for (const v of body) {
      if (field.boundarySdf(v.x, v.z) < 0) violations++;
    }
  }
  // 水が完全に消える入力(pondCount=0 かつ湖なし)では edgeStyle は "fog"
  if (bodies.length === 0 && model.ground.edgeStyle !== "fog") violations++;
  if (violations > 0) {
    console.warn(`water: パイプライン内アサーション違反 ${violations} 件`);
  }
}
