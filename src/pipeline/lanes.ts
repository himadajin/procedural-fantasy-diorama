/**
 * 段13「小道」: 建物裏手を結ぶ細い道と、水路沿いの岸沿い道(towpath)を
 * lane class の edge として道路網へ追記する(PHASE 4b commit 15)。
 * データの正は docs/internal/contracts/worldmodel.md(Network 節
 * 「小道の性質」)、段の位置づけは contracts/pipeline.md の段契約表。
 *
 * - 段12「建物」の後に走る専用段(建物 footprint・広場・水路の最終配置を
 *   衝突判定に使う)。既存の node / edge の id・内容は一切変更しない(追記のみ)
 * - 裏手の小道: 道路 edge の片側に並ぶ区画の列の奥(裏手)を通る。
 *   採択は laneAmount 駆動(clamp(1.15 × laneAmount, 0, 0.95))
 * - 岸沿い道: 各水路の towpathSide 側、護岸縁石の外(中心線から
 *   幅/2 + 1.35)。採択は clamp(0.3 + 0.9 × laneAmount, 0, 0.98)
 * - 小道は水域(河川・湖・水路)を渡らず、結界環も横切らない
 *   (衝突制約でトリム・分断する設計判断。bridges / gates は段8 のまま)
 * - 乱数は要素ごとの独立サブストリーム "lanes/back/<roadEdgeId>/<L|R>" /
 *   "lanes/towpath/<canalId>" のみ・候補ごとに固定消費
 * - lane の被覆で zoneMask の舗装チャネルを段10 と同じ流儀で追記する
 *   (乱数非消費)。summary.scale.roadLength へ小道の総延長を加算する
 */
import { makeRng } from "../rng";
import type { Polygon, Vec2, WorldModel } from "../model/worldmodel";
import {
  createBoundaryRadius,
  createWaterField,
  distToPolyline,
  polygonSignedDistance,
} from "../model/waterfield";
import {
  chaikin,
  pathLength,
  pointAlong,
  polygonBounds,
  resamplePath,
} from "../model/geometry";
import { applyPavedCoverage, maskCellGrid, stampPath } from "./paving";

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/** 小道の幅(実寸。contracts/worldmodel.md Network 節) */
export const LANE_WIDTH = 1.6;
/** 等級の格下げ(lane = roadGrade − 0.5、下限 0。道路より低い等級) */
export const LANE_GRADE_DROP = 0.5;
/** 候補経路の標本間隔 */
const LANE_STEP = 3;
/** 裏手の小道: 区画の奥からのあき */
const BACK_GAP = 1.0;
/** 裏手の小道: 列の端の延長(最初/最後の区画の縁から) */
const BACK_END_EXTEND = 1.0;
/** 岸沿い道: 水路中心線からのオフセット追加分(縁石 0.12+0.42 + 半幅 0.8) */
const TOWPATH_OFFSET_EXTRA = 1.35;
/** 連続区間の最小長(これ未満のトリム残りは棄却) */
const BACK_MIN_RUN = 12;
const TOWPATH_MIN_RUN = 10;
/** 採択確率(laneAmount 駆動。契約) */
const BACK_ADOPT_SCALE = 1.15;
const BACK_ADOPT_MAX = 0.95;
const TOWPATH_ADOPT_BASE = 0.3;
const TOWPATH_ADOPT_SCALE = 0.9;
const TOWPATH_ADOPT_MAX = 0.98;
/** 衝突クリアランス(契約の一覧) */
const BOUNDARY_CLEAR = 2;
const WATER_CLEAR = 0.4;
const CANAL_CLEAR = 0.3;
const BUILDING_CLEAR = 0.3;
const PLAZA_CLEAR = 0.5;
const CENTER_CLEAR = 1;
const RING_CLEAR = 2.0;
/** 既採択の小道との中心線間隔の最小(幅 + 0.6) */
const LANE_LANE_GAP = LANE_WIDTH + 0.6;
/** 舗装被覆のブレンド帯(道路と同基準。paving.ts の ROAD_BLEND と同値) */
const LANE_BLEND = 2.2;
const BLEND_CELL_RATIO = 0.9;

/** 採択済み小道(衝突判定と最終出力の元) */
interface LaneCandidate {
  id: string;
  points: Vec2[];
}

/** 衝突判定の文脈(段13 専用。生成順に依存しない決定的な判定のみ) */
interface LaneContext {
  model: WorldModel;
  waterSdf: (x: number, z: number) => number;
  boundaryInside: (x: number, z: number) => number;
  buildingBounds: { minX: number; maxX: number; minZ: number; maxZ: number }[];
  ringBand: { minR: number; maxR: number } | null;
  accepted: LaneCandidate[];
}

function buildLaneContext(model: WorldModel): LaneContext {
  const field = createWaterField(
    model.ground.boundary,
    model.water.rivers,
    model.water.lakes,
  );
  const boundaryRadius = createBoundaryRadius(model.ground.boundary);
  const ring = model.wards.ringPath;
  let ringBand: LaneContext["ringBand"] = null;
  if (ring.length >= 3) {
    const c = model.centerPlan.position;
    let minR = Infinity;
    let maxR = -Infinity;
    for (const p of ring) {
      const r = Math.hypot(p.x - c.x, p.z - c.z);
      minR = Math.min(minR, r);
      maxR = Math.max(maxR, r);
    }
    ringBand = { minR, maxR };
  }
  return {
    model,
    waterSdf: field.waterSdf,
    boundaryInside: (x, z) =>
      boundaryRadius(Math.atan2(z, x)) - Math.hypot(x, z),
    buildingBounds: model.buildings.map((b) => polygonBounds(b.footprint)),
    ringBand,
    accepted: [],
  };
}

/** 点 p が小道の経路点として置けるか(契約の衝突制約) */
function laneSampleValid(ctx: LaneContext, p: Vec2): boolean {
  const half = LANE_WIDTH / 2;
  const { model } = ctx;
  // 境界
  if (ctx.boundaryInside(p.x, p.z) < BOUNDARY_CLEAR) return false;
  // 河川・湖(小道は水域を渡らない)
  if (ctx.waterSdf(p.x, p.z) < half + WATER_CLEAR) return false;
  // 水路(岸沿い道の点は押し出しで 幅/2 + 1.35 に置かれるため自水路も
  // この制約を満たす。ヘアピン等で押し出しが収束しない点はここでトリムされる)
  for (const canal of model.water.canals) {
    if (
      distToPolyline(p.x, p.z, canal.points) - canal.width / 2 <
      half + CANAL_CLEAR
    ) {
      return false;
    }
  }
  // 建物 footprint(バウンディングボックスで粗く絞る)
  const reach = half + BUILDING_CLEAR;
  for (let i = 0; i < model.buildings.length; i++) {
    const bb = ctx.buildingBounds[i];
    const b = model.buildings[i];
    if (!bb || !b) continue;
    if (
      p.x < bb.minX - reach ||
      p.x > bb.maxX + reach ||
      p.z < bb.minZ - reach ||
      p.z > bb.maxZ + reach
    ) {
      continue;
    }
    if (polygonSignedDistance(p.x, p.z, b.footprint) < reach) return false;
  }
  // 広場
  for (const plaza of model.plazas) {
    const pr = plaza.radius + half + PLAZA_CLEAR;
    if (
      Math.abs(p.x - plaza.position.x) > pr ||
      Math.abs(p.z - plaza.position.z) > pr
    ) {
      continue;
    }
    if (polygonSignedDistance(p.x, p.z, plaza.polygon) < half + PLAZA_CLEAR) {
      return false;
    }
  }
  // centerPlan の予約領域
  const foot = model.centerPlan.footprint;
  if (foot.length >= 3) {
    if (polygonSignedDistance(p.x, p.z, foot) < CENTER_CLEAR) return false;
  }
  // 結界環(横切らない・張り付かない。環の半径帯のみ検査して間引く)
  const ring = model.wards.ringPath;
  if (ctx.ringBand && ring.length >= 3) {
    const c = model.centerPlan.position;
    const r = Math.hypot(p.x - c.x, p.z - c.z);
    if (
      r > ctx.ringBand.minR - RING_CLEAR - 1 &&
      r < ctx.ringBand.maxR + RING_CLEAR + 1
    ) {
      if (Math.abs(polygonSignedDistance(p.x, p.z, ring)) < RING_CLEAR) {
        return false;
      }
    }
  }
  // 既採択の小道
  for (const lane of ctx.accepted) {
    if (distToPolyline(p.x, p.z, lane.points) < LANE_LANE_GAP) return false;
  }
  return true;
}

/**
 * 候補点列を有効な連続区間へトリム・分割する(乱数非消費・決定論的)。
 * 各区間は弧長 minRun 以上を要求する。
 */
function splitValidRuns(
  ctx: LaneContext,
  points: Vec2[],
  minRun: number,
): Vec2[][] {
  const valid = points.map((p) => laneSampleValid(ctx, p));
  const runs: Vec2[][] = [];
  let current: Vec2[] = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (valid[i] && p) {
      current.push(p);
    } else if (current.length > 0) {
      runs.push(current);
      current = [];
    }
  }
  if (current.length > 0) runs.push(current);
  return runs.filter((run) => run.length >= 2 && pathLength(run) >= minRun);
}

/** 採択した区間を lane edge として network へ追記する */
function acceptLane(
  ctx: LaneContext,
  id: string,
  points: Vec2[],
  grade: number,
): void {
  const { model } = ctx;
  const head = points[0];
  const tail = points[points.length - 1];
  if (!head || !tail) return;
  model.network.nodes.push(
    { id: `node/${id}/a`, position: { x: head.x, z: head.z } },
    { id: `node/${id}/b`, position: { x: tail.x, z: tail.z } },
  );
  model.network.edges.push({
    id,
    from: `node/${id}/a`,
    to: `node/${id}/b`,
    class: "lane",
    width: LANE_WIDTH,
    path: points,
    grade,
  });
  ctx.accepted.push({ id, points });
}

/** 折れ線上の最近点(岸沿い道の押し出しに使う) */
function nearestOnPolyline(p: Vec2, path: Vec2[]): { q: Vec2; d: number } {
  let best: Vec2 = path[0] ?? { x: 0, z: 0 };
  let bestD = Infinity;
  for (let i = 0; i + 1 < path.length; i++) {
    const a = path[i];
    const b = path[i + 1];
    if (!a || !b) continue;
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const lenSq = dx * dx + dz * dz;
    const t =
      lenSq > 0
        ? clamp(((p.x - a.x) * dx + (p.z - a.z) * dz) / lenSq, 0, 1)
        : 0;
    const qx = a.x + dx * t;
    const qz = a.z + dz * t;
    const d = Math.hypot(p.x - qx, p.z - qz);
    if (d < bestD) {
      bestD = d;
      best = { x: qx, z: qz };
    }
  }
  return { q: best, d: bestD };
}

/**
 * 岸沿い道の点列を水路中心線から minDist 以上へ押し出す(決定論的・
 * 乱数非消費)。単純な垂直オフセットは水路の凹側のカーブで
 * コーナーを切って水路内へ食い込むため、最近点から離す方向へ反復して均す。
 */
function pushAwayFromCanal(points: Vec2[], canal: Vec2[], minDist: number): void {
  for (let pass = 0; pass < 4; pass++) {
    let moved = false;
    for (const p of points) {
      const { q, d } = nearestOnPolyline(p, canal);
      if (d >= minDist - 1e-6) continue;
      moved = true;
      if (d < 1e-6) {
        p.x += minDist; // 縮退(中心線上)は決定論的に +x へ逃がす
        continue;
      }
      const push = minDist - d;
      p.x += ((p.x - q.x) / d) * push;
      p.z += ((p.z - q.z) / d) * push;
    }
    if (!moved) break;
  }
}

/** 折れ線上の点 q に最も近い位置の弧長(区画の列内の並び順に使う) */
function arcLengthOfPoint(path: Vec2[], q: Vec2): number {
  let acc = 0;
  let bestS = 0;
  let bestD = Infinity;
  for (let i = 0; i + 1 < path.length; i++) {
    const a = path[i];
    const b = path[i + 1];
    if (!a || !b) continue;
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const lenSq = dx * dx + dz * dz;
    const t =
      lenSq > 0
        ? clamp(((q.x - a.x) * dx + (q.z - a.z) * dz) / lenSq, 0, 1)
        : 0;
    const seg = Math.sqrt(lenSq);
    const d = Math.hypot(q.x - (a.x + dx * t), q.z - (a.z + dz * t));
    if (d < bestD) {
      bestD = d;
      bestS = acc + seg * t;
    }
    acc += seg;
  }
  return bestS;
}

/** ポリゴン頂点の折れ線への最大距離(区画の奥=裏手の距離) */
function rearDistance(polygon: Polygon, path: Vec2[]): number {
  let d = 0;
  for (const v of polygon) {
    d = Math.max(d, distToPolyline(v.x, v.z, path));
  }
  return d;
}

/**
 * 岸沿い道(towpath): 各水路の towpathSide 側、護岸縁石の外を水路に沿って
 * 通す。乱数は "lanes/towpath/<canalId>"(採択ロール 1 値で固定)。
 */
function planTowpaths(ctx: LaneContext, laneAmount: number, grade: number): void {
  const { model } = ctx;
  const adoptP = clamp(
    TOWPATH_ADOPT_BASE + TOWPATH_ADOPT_SCALE * laneAmount,
    0,
    TOWPATH_ADOPT_MAX,
  );
  for (const canal of model.water.canals) {
    const rng = makeRng(model.meta.seed, `lanes/towpath/${canal.id}`);
    const adoptRoll = rng.next();
    if (adoptRoll >= adoptP) continue;

    const total = pathLength(canal.points);
    if (total < TOWPATH_MIN_RUN) continue;
    const offset = canal.width / 2 + TOWPATH_OFFSET_EXTRA;
    const count = Math.max(2, Math.round(total / LANE_STEP));
    const raw: Vec2[] = [];
    for (let i = 0; i <= count; i++) {
      const { p, angle } = pointAlong(canal.points, (i / count) * total);
      const left = { x: -Math.sin(angle), z: Math.cos(angle) };
      raw.push({
        x: p.x + left.x * canal.towpathSide * offset,
        z: p.z + left.z * canal.towpathSide * offset,
      });
    }
    // 平滑化で凹側のコーナーが水路側へ食い込むため、中心線から押し出して
    // 均す(密にリサンプルしてから再度押し、点間の弦の食い込みも抑える)
    const smooth = chaikin(raw);
    pushAwayFromCanal(smooth, canal.points, offset);
    const dense = resamplePath(smooth, 1.5);
    pushAwayFromCanal(dense, canal.points, offset);
    const runs = splitValidRuns(ctx, dense, TOWPATH_MIN_RUN);
    for (let k = 0; k < runs.length; k++) {
      const run = runs[k];
      if (!run) continue;
      acceptLane(ctx, `lane/towpath/${canal.id}/${k}`, run, grade);
    }
  }
}

/**
 * 裏手の小道: 道路 edge の片側に並ぶ区画の列の奥(裏手)を、接道 edge に
 * 沿って通す。列内は区画ごとの裏手距離(裏あき+半幅込み)を弧長方向に
 * 線形補間する。乱数は "lanes/back/<roadEdgeId>/<L|R>"(採択ロール 1 値)。
 */
function planBackLanes(ctx: LaneContext, laneAmount: number, grade: number): void {
  const { model } = ctx;
  const adoptP = clamp(BACK_ADOPT_SCALE * laneAmount, 0, BACK_ADOPT_MAX);

  // 区画を (roadEdgeId, side) の列へまとめる(id の末尾 2 要素が side / slot)
  const rows = new Map<string, { side: 1 | -1; parcels: typeof model.parcels }>();
  for (const parcel of model.parcels) {
    const parts = parcel.id.split("/");
    const sideStr = parts[parts.length - 2];
    if (sideStr !== "L" && sideStr !== "R") continue;
    const key = `${parcel.roadEdgeId}/${sideStr}`;
    let row = rows.get(key);
    if (!row) {
      row = { side: sideStr === "L" ? 1 : -1, parcels: [] };
      rows.set(key, row);
    }
    row.parcels.push(parcel);
  }

  // 走査順は edges の配列順 × L → R(環境依存の順序に依存しない)
  for (const edge of model.network.edges) {
    if (edge.class === "lane") continue;
    for (const sideStr of ["L", "R"] as const) {
      const row = rows.get(`${edge.id}/${sideStr}`);
      if (!row || row.parcels.length < 2) continue;
      const rng = makeRng(model.meta.seed, `lanes/back/${edge.id}/${sideStr}`);
      const adoptRoll = rng.next();
      if (adoptRoll >= adoptP) continue;

      // 列のノット: 区画の接道中点の弧長 → 裏手のオフセット距離
      const knots: { s: number; offset: number; halfFront: number }[] = [];
      for (const parcel of row.parcels) {
        const [fa, fb] = parcel.frontEdge;
        const mid = { x: (fa.x + fb.x) / 2, z: (fa.z + fb.z) / 2 };
        knots.push({
          s: arcLengthOfPoint(edge.path, mid),
          offset: rearDistance(parcel.polygon, edge.path) + BACK_GAP + LANE_WIDTH / 2,
          halfFront: Math.hypot(fb.x - fa.x, fb.z - fa.z) / 2,
        });
      }
      knots.sort((a, b) => a.s - b.s);
      const first = knots[0];
      const last = knots[knots.length - 1];
      if (!first || !last) continue;
      const total = pathLength(edge.path);
      const s0 = clamp(first.s - first.halfFront - BACK_END_EXTEND, 0.5, total - 0.5);
      const s1 = clamp(last.s + last.halfFront + BACK_END_EXTEND, 0.5, total - 0.5);
      if (s1 - s0 < BACK_MIN_RUN) continue;

      const offsetAt = (s: number): number => {
        if (s <= first.s) return first.offset;
        if (s >= last.s) return last.offset;
        for (let i = 0; i + 1 < knots.length; i++) {
          const a = knots[i];
          const b = knots[i + 1];
          if (!a || !b) continue;
          if (s >= a.s && s <= b.s) {
            const t = b.s - a.s > 1e-9 ? (s - a.s) / (b.s - a.s) : 0;
            return a.offset + (b.offset - a.offset) * t;
          }
        }
        return last.offset;
      };

      const count = Math.max(2, Math.round((s1 - s0) / LANE_STEP));
      const raw: Vec2[] = [];
      for (let i = 0; i <= count; i++) {
        const s = s0 + ((s1 - s0) * i) / count;
        const { p, angle } = pointAlong(edge.path, s);
        const left = { x: -Math.sin(angle), z: Math.cos(angle) };
        const off = offsetAt(s);
        raw.push({
          x: p.x + left.x * row.side * off,
          z: p.z + left.z * row.side * off,
        });
      }
      const smooth = chaikin(raw);
      const runs = splitValidRuns(ctx, smooth, BACK_MIN_RUN);
      for (let k = 0; k < runs.length; k++) {
        const run = runs[k];
        if (!run) continue;
        acceptLane(ctx, `lane/back/${edge.id}/${sideStr}/${k}`, run, grade);
      }
    }
  }
}

/** lane の被覆で zoneMask の舗装チャネルを追記する(段10 と同じ流儀・乱数非消費) */
function stampLanesZone(model: WorldModel, lanes: LaneCandidate[]): void {
  const mask = model.ground.zoneMask;
  if (mask.resolution <= 0 || lanes.length === 0) return;
  const grid = maskCellGrid(mask);
  const blend = Math.max(LANE_BLEND, mask.cellSize * BLEND_CELL_RATIO);
  const coverage = new Float64Array(mask.resolution * mask.resolution);
  for (const lane of lanes) {
    stampPath(grid, coverage, lane.points, LANE_WIDTH / 2, blend);
  }
  applyPavedCoverage(mask, coverage);
}

/** パイプライン段の実体: lane を network へ追記し、舗装とサマリーを更新する */
export function runLanes(model: WorldModel): void {
  const { derived } = model.meta;
  const grade = clamp(derived.roadGrade - LANE_GRADE_DROP, 0, 2);
  const ctx = buildLaneContext(model);

  const edgeCountBefore = model.network.edges.length;

  // 岸沿い道 → 裏手の小道の順(後発は既採択の小道と衝突しない)
  planTowpaths(ctx, derived.laneAmount, grade);
  planBackLanes(ctx, derived.laneAmount, grade);

  // zoneMask の舗装追記とサマリー加算
  stampLanesZone(model, ctx.accepted);
  let laneLength = 0;
  for (const lane of ctx.accepted) laneLength += pathLength(lane.points);
  model.summary.scale.roadLength += laneLength;

  // --- パイプライン内アサーション(throw せず件数を console に出す) ---
  let violations = 0;
  const half = LANE_WIDTH / 2;
  const ids = new Set<string>();
  for (const e of model.network.edges) {
    if (ids.has(e.id)) violations++;
    ids.add(e.id);
  }
  for (const lane of ctx.accepted) {
    for (const p of lane.points) {
      // 水域を渡らない(クリアランスなしの最終確認)
      if (ctx.waterSdf(p.x, p.z) < half) violations++;
      for (const canal of model.water.canals) {
        if (distToPolyline(p.x, p.z, canal.points) - canal.width / 2 < 0) {
          violations++;
        }
      }
      // 建物・広場と重ならない
      for (let i = 0; i < model.buildings.length; i++) {
        const bb = ctx.buildingBounds[i];
        const b = model.buildings[i];
        if (!bb || !b) continue;
        if (
          p.x < bb.minX - half ||
          p.x > bb.maxX + half ||
          p.z < bb.minZ - half ||
          p.z > bb.maxZ + half
        ) {
          continue;
        }
        if (polygonSignedDistance(p.x, p.z, b.footprint) < 0) violations++;
      }
      for (const plaza of model.plazas) {
        if (polygonSignedDistance(p.x, p.z, plaza.polygon) < 0) violations++;
      }
    }
  }
  // 追記のみ(既存 edge の数は減らない)
  if (model.network.edges.length < edgeCountBefore) violations++;
  if (violations > 0) {
    console.warn(`lanes: パイプライン内アサーション違反 ${violations} 件`);
  }
}
