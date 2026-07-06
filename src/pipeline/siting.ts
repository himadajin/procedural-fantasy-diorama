/**
 * 段4「立地評価」: 主中心の位置・中心建築の予定地(占有範囲)・4軸スコアと、
 * 外縁の進入点を確定する。
 * データの正は docs/internal/contracts/worldmodel.md(CenterPlan / Network 節)、
 * 設計は implementation-spec 1.3節(段4)・1.7節・PHASE 3。
 *
 * - 主中心のスコア = 水辺近接×√Water + 中央寄り + 進入点からのアクセス性
 *   − 水中ペナルティ。Water項は平方根で飽和させ、Water の微小変化で
 *   主中心が跳ばないようにする。seed はタイブレーク(格子ハッシュノイズの
 *   微小加点)にのみ使う
 * - 進入点は外縁上に derived.entryPointCount 点(2〜4)。水域を避け、
 *   主河川がある場合は両岸に分かれるよう配置して橋の必然性を作る
 * - centerPlan.facing / heightHint は段9「広場」(PHASE 3 commit 10)の担当。
 *   本段では 0 のまま
 */
import { makeRng } from "../rng";
import type { Polygon, Vec2, WorldModel } from "../model/worldmodel";
import {
  createBoundaryRadius,
  createWaterField,
  pointInPolygon,
  type WaterField,
} from "../model/waterfield";
import { noiseSeed, valueNoise2D } from "./noise";

/** 立地評価グリッドの一辺セル数 */
const SITE_GRID = 64;
/** スコアの重み: 水辺近接(×√Water) */
const W_WATER = 1.0;
/** スコアの重み: 中央寄り */
const W_CENTRAL = 0.85;
/** スコアの重み: 進入点からのアクセス性 */
const W_ACCESS = 0.6;
/** スコアの重み: 水中ペナルティ(水際に近すぎる候補を沈める) */
const W_PENALTY = 1.2;
/** 水辺近接の指数減衰の距離スケール(ワールド一辺比) */
const PROX_FALLOFF_RATIO = 0.09;
/** seed タイブレークの振幅(スコア本体より十分小さい微小量) */
const TIEBREAK_AMP = 1e-4;
/** 4軸スコアの seed 揺らぎ(同点付近のタイブレーク用。1.7節) */
const AXES_JITTER = 0.02;
/** 進入点の角度探索の分割数(対岸への移設・水域回避の候補) */
const ENTRY_CANDIDATES = 96;

function angularDistance(a: number, b: number): number {
  let d = (a - b) % (Math.PI * 2);
  if (d < -Math.PI) d += Math.PI * 2;
  if (d > Math.PI) d -= Math.PI * 2;
  return Math.abs(d);
}

/**
 * 進入点を外縁上に置く。基準角+等間隔+進入点ごとの揺らぎ
 * (乱数は安定ID `siting/entry/<i>` のサブストリーム)。
 * 水域(河口)を避け、主河川があるのに全点が同じ岸に偏ったら
 * 1点を対岸へ移す(決定論的な候補角探索。乱数は消費しない)。
 */
function placeEntryPoints(
  model: WorldModel,
  field: WaterField,
): { id: string; position: Vec2 }[] {
  const { seed, derived } = model.meta;
  const radius = createBoundaryRadius(model.ground.boundary);
  const n = derived.entryPointCount;
  const baseAngle = makeRng(seed, "siting/entry").range(0, Math.PI * 2);

  const pointAt = (theta: number): Vec2 => ({
    x: Math.cos(theta) * radius(theta),
    z: Math.sin(theta) * radius(theta),
  });
  const onLand = (theta: number): boolean => {
    const p = pointAt(theta);
    return field.waterSdf(p.x, p.z) >= 0;
  };
  /** 水域(河口)に落ちた角を近傍の陸へずらす(決定論的な交互探索) */
  const nudgeToLand = (theta: number): number => {
    if (onLand(theta)) return theta;
    const step = (Math.PI * 2) / ENTRY_CANDIDATES;
    for (let k = 1; k <= ENTRY_CANDIDATES / 2; k++) {
      if (onLand(theta + k * step)) return theta + k * step;
      if (onLand(theta - k * step)) return theta - k * step;
    }
    return theta;
  };

  const angles: number[] = [];
  for (let i = 0; i < n; i++) {
    const jitter = makeRng(seed, `siting/entry/${i}`).range(-0.3, 0.3);
    angles.push(nudgeToLand(baseAngle + ((i + jitter) / n) * Math.PI * 2));
  }

  // 主河川の弦に対する側(符号)で両岸を判定する
  const river = model.water.rivers[0];
  if (river && river.points.length >= 2 && n >= 2) {
    const head = river.points[0];
    const tail = river.points[river.points.length - 1];
    if (head && tail) {
      const side = (p: Vec2): number =>
        Math.sign(
          (tail.x - head.x) * (p.z - head.z) - (tail.z - head.z) * (p.x - head.x),
        );
      const sides = angles.map((t) => side(pointAt(t)));
      const first = sides[0] ?? 0;
      if (first !== 0 && sides.every((s) => s === first)) {
        // 対岸の候補角から、残す進入点との角距離が最大の1点を選んで移す
        let bestAngle: number | null = null;
        let bestGap = -Infinity;
        for (let k = 0; k < ENTRY_CANDIDATES; k++) {
          const t = (k / ENTRY_CANDIDATES) * Math.PI * 2;
          if (side(pointAt(t)) !== -first || !onLand(t)) continue;
          let gap = Infinity;
          for (let i = 0; i + 1 < n; i++) {
            gap = Math.min(gap, angularDistance(t, angles[i] ?? 0));
          }
          if (gap > bestGap) {
            bestGap = gap;
            bestAngle = t;
          }
        }
        if (bestAngle !== null) angles[n - 1] = bestAngle;
      }
    }
  }

  return angles.map((t, i) => ({ id: `entry/${i}`, position: pointAt(t) }));
}

/** 中心候補の水辺近接度(岸距離の指数減衰。4軸の水辺軸と共有) */
function waterProximity(wSdf: number, footHalf: number, size: number): number {
  return Math.exp(-Math.max(0, wSdf - footHalf) / (size * PROX_FALLOFF_RATIO));
}

/** グリッド各点をスコアリングして主中心位置を1点決める */
function chooseCenter(
  model: WorldModel,
  field: WaterField,
  entries: { id: string; position: Vec2 }[],
): { position: Vec2; waterProx: number; fallback: boolean } {
  const size = model.ground.size;
  const water01 = model.meta.params.water / 100;
  const footHalf = model.meta.derived.centerFootprint / 2;
  const tieSeed = noiseSeed(model.meta.seed, "siting/tiebreak");
  const sqrtWater = Math.sqrt(water01);
  const half = size / 2;
  const cell = size / SITE_GRID;

  let best: { score: number; x: number; z: number; wSdf: number } | null = null;
  let driest: { x: number; z: number; wSdf: number } | null = null;

  for (let iz = 0; iz < SITE_GRID; iz++) {
    for (let ix = 0; ix < SITE_GRID; ix++) {
      const x = (ix + 0.5) * cell - half;
      const z = (iz + 0.5) * cell - half;
      const bSdf = field.boundarySdf(x, z);
      // footprint(対角半径 footHalf×√2)が境界内に収まる余裕を要求する
      if (bSdf < footHalf * Math.SQRT2 + 2) continue;
      const wSdf = field.waterSdf(x, z);
      if (driest === null || wSdf > driest.wSdf) driest = { x, z, wSdf };
      // 水中・水際すぎる点は候補外(主中心は水中に置かない)
      if (wSdf < footHalf * 0.7) continue;

      const prox = waterProximity(wSdf, footHalf, size);
      const central = 1 - Math.hypot(x, z) / half;
      let access = 0;
      for (const e of entries) {
        access += 1 - Math.hypot(x - e.position.x, z - e.position.z) / size;
      }
      access /= Math.max(1, entries.length);
      const penalty = wSdf < footHalf * 1.6 ? 1 - wSdf / (footHalf * 1.6) : 0;
      const tie = valueNoise2D(tieSeed, ix, iz) * TIEBREAK_AMP;
      const score =
        W_WATER * sqrtWater * prox +
        W_CENTRAL * central +
        W_ACCESS * access -
        W_PENALTY * penalty +
        tie;
      if (best === null || score > best.score) best = { score, x, z, wSdf };
    }
  }

  if (best) {
    return {
      position: { x: best.x, z: best.z },
      waterProx: waterProximity(best.wSdf, footHalf, size),
      fallback: false,
    };
  }
  // フォールバック: 水から最も遠い点(waterAreaCap により実際には到達しない)
  const d = driest ?? { x: 0, z: 0, wSdf: field.waterSdf(0, 0) };
  return {
    position: { x: d.x, z: d.z },
    waterProx: waterProximity(d.wSdf, footHalf, size),
    fallback: true,
  };
}

/** 占有範囲: position 中心・軸平行の正方形。時計回り(shoelace 符号負) */
function squareFootprint(center: Vec2, side: number): Polygon {
  const h = side / 2;
  return [
    { x: center.x - h, z: center.z - h },
    { x: center.x - h, z: center.z + h },
    { x: center.x + h, z: center.z + h },
    { x: center.x + h, z: center.z - h },
  ];
}

/** パイプライン段の実体: centerPlan.position/footprint/axes と進入点を埋める */
export function runSiting(model: WorldModel): void {
  const { seed, params, derived } = model.meta;
  const field = createWaterField(
    model.ground.boundary,
    model.water.rivers,
    model.water.lakes,
  );

  const entryPoints = placeEntryPoints(model, field);
  model.network.entryPoints = entryPoints;

  const center = chooseCenter(model, field, entryPoints);
  model.centerPlan.position = center.position;
  model.centerPlan.footprint = squareFootprint(
    center.position,
    derived.centerFootprint,
  );

  // 4軸スコア(implementation-spec 1.7節)。seed 揺らぎは同点付近の
  // タイブレーク用の微小量のみ(消費順・消費数固定: 4値)
  const rng = makeRng(seed, "siting/axes");
  const monument = params.monumentality / 100;
  const prosper = params.prosperity / 100;
  const water = params.water / 100;
  const settle = params.settlement / 100;
  model.centerPlan.axes = {
    arcane: Math.max(
      0,
      monument * derived.centerArcaneBias + rng.range(-AXES_JITTER, AXES_JITTER),
    ),
    authority: Math.max(
      0,
      monument * prosper + rng.range(-AXES_JITTER, AXES_JITTER),
    ),
    waterside: Math.max(
      0,
      monument * water * center.waterProx + rng.range(-AXES_JITTER, AXES_JITTER),
    ),
    rustic: Math.max(
      0,
      (1 - monument) * (1 - settle) + rng.range(-AXES_JITTER, AXES_JITTER),
    ),
  };
  // facing / heightHint は段9「広場」(PHASE 3 commit 10)が
  // 中心前広場・主道の収束方向の確定後に埋める。ここでは 0 のまま

  // パイプライン内アサーション: 違反は throw せず件数を console に出す
  // (implementation-spec 1.10節)
  let violations = 0;
  if (center.fallback) violations++;
  if (field.waterSdf(center.position.x, center.position.z) <= 0) violations++;
  for (const v of model.centerPlan.footprint) {
    if (!pointInPolygon(v.x, v.z, model.ground.boundary)) violations++;
  }
  for (const e of entryPoints) {
    if (field.waterSdf(e.position.x, e.position.z) < 0) violations++;
  }
  if (violations > 0) {
    console.warn(`siting: パイプライン内アサーション違反 ${violations} 件`);
  }
}
