/**
 * 段11「区画」: 最終密度場(density.final)と道路沿いの敷地分割(parcels)。
 * データの正は docs/internal/contracts/network-plaza.md(Density 節)・buildings.md(Parcel 節)、
 * 設計は implementation-spec 1.3節(段10「区画」相当)・PHASE 4a。
 *
 * - density.final = 一次密度場 + 結界内ブースト(ringPath 内側で最大 +0.15、
 *   環の縁は幅 8 の smoothstep で減衰)。乱数を消費しない
 * - 区画は道路 edge の両側のオフセット帯を間口×奥行きの矩形敷地へ分割し、
 *   final 密度が敷地サイズ(高密度=狭小)と採択確率を駆動する。
 *   総数は derived.parcelCountMax を上限とする
 * - 衝突棄却・岸線占有率 40% 上限・id の安定性は契約の一覧に従う
 * - 乱数は区画ごとの独立サブストリーム "parcel/<id>" のみ
 *   (生成順序の変更が他区画へ波及しない)
 */
import { makeRng } from "../rng";
import type { Parcel, Polygon, Vec2, WorldModel } from "../model/worldmodel";
import {
  createBoundaryRadius,
  createWaterField,
  distToPolyline,
  polygonSignedDistance,
  waterBodies,
} from "../model/waterfield";
import {
  createFieldGrid,
  fieldCellIndex,
  sampleFieldGrid,
  type FieldGrid,
} from "../model/fieldgrid";
import {
  ensureClockwise,
  pathLength,
  pointAlong,
  polygonBounds,
  polygonsOverlap,
  segmentNearPolygon,
} from "../model/geometry";

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

function smoothstep(edge0: number, edge1: number, v: number): number {
  const t = clamp((v - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

// --- density.final(contracts/network-plaza.md Density 節) ---
/** 結界内ブーストの最大値 */
const WARD_BOOST = 0.15;
/** 環の縁の減衰幅(実寸) */
const WARD_FADE = 8;

// --- 区画分割の寸法(contracts/buildings.md Parcel 節) ---
/** 道路縁から敷地前面までの帯(実寸) */
const FRONT_GAP = 1.0;
/** 敷地間の隙間(実寸) */
const SLOT_GAP = 1.0;
/** edge 両端(交差点まわり)を避ける弧長 */
const END_MARGIN = 4;
/** 奥行き = 間口 × この比(±10% 揺らぎ) */
const DEPTH_RATIO = 1.25;
const DEPTH_MIN = 7;
const DEPTH_MAX = 22;
/**
 * 奥行きの縮小リトライ(岸沿いなど狭い帯に敷地を通す)。
 * 縮小した矩形は元の矩形に含まれるため、縮小候補の検査は決定論的な
 * 局所探索であり乱数を消費しない。
 */
const DEPTH_SHRINK_STEPS = [1, 0.72, 0.5];
const DEPTH_SHRINK_MIN = 4.5;
/** 間口のクランプ(密度変調後) */
const FRONTAGE_MIN = 5.5;
const FRONTAGE_MAX = 20;

// --- 衝突棄却のクリアランス ---
const ROAD_CLEAR = 0.3;
const WATER_CLEAR = 0.4;
const PLAZA_CLEAR = 0.5;
const BOUNDARY_MARGIN = 2;
const RING_BUFFER = 2.5;
const CENTER_FOOTPRINT_CLEAR = 1;

// --- 水辺判定・岸線占有率(契約) ---
/** waterside / canalside の判定距離 */
const NEAR_WATER = 4.5;
/** 岸線点を「占有」と数える区画ポリゴンまでの距離 */
const SHORE_OCCUPY_DIST = 6;
/** 岸線の建築占有率の上限 */
const SHORE_OCCUPY_CAP = 0.4;
/** 水辺候補の採択率ブースト係数(watersideRate に掛かる) */
const WATERSIDE_BOOST = 0.8;

/** 一次密度場+結界内ブースト(乱数非消費) */
export function computeFinalDensity(model: WorldModel): FieldGrid | null {
  const primary = model.density.primary;
  if (!primary) return null;
  const grid = createFieldGrid(primary.resolution, primary.cellSize);
  const ring = model.wards.ringPath;
  const half = (primary.resolution * primary.cellSize) / 2;
  const hasRing = ring.length >= 3;
  const bounds = hasRing ? polygonBounds(ring) : null;
  for (let iz = 0; iz < primary.resolution; iz++) {
    for (let ix = 0; ix < primary.resolution; ix++) {
      const idx = fieldCellIndex(grid, ix, iz);
      let v = primary.values[idx] ?? 0;
      if (hasRing && bounds) {
        const x = (ix + 0.5) * primary.cellSize - half;
        const z = (iz + 0.5) * primary.cellSize - half;
        if (
          x >= bounds.minX - WARD_FADE &&
          x <= bounds.maxX + WARD_FADE &&
          z >= bounds.minZ - WARD_FADE &&
          z <= bounds.maxZ + WARD_FADE
        ) {
          const sdf = polygonSignedDistance(x, z, ring);
          v = clamp(v + WARD_BOOST * smoothstep(0, WARD_FADE, -sdf), 0, 1);
        }
      }
      grid.values[idx] = v;
    }
  }
  return grid;
}

/** 敷地候補の矩形(接線・法線フレームから構成) */
interface CandidateRect {
  polygon: Polygon;
  frontEdge: [Vec2, Vec2];
  facing: number;
  center: Vec2;
  /** 角4+辺中点4+中心1+内部4 の 13 プローブ */
  probes: Vec2[];
}

function buildRect(
  mid: Vec2,
  angle: number,
  side: 1 | -1,
  frontage: number,
  depth: number,
  frontOffset: number,
): CandidateRect {
  const tx = Math.cos(angle);
  const tz = Math.sin(angle);
  // 進行方向左手の法線(+1=L / -1=R)
  const nx = -tz * side;
  const nz = tx * side;
  const at = (u: number, v: number): Vec2 => ({
    x: mid.x + tx * u + nx * (frontOffset + v),
    z: mid.z + tz * u + nz * (frontOffset + v),
  });
  const half = frontage / 2;
  const fl = at(-half, 0);
  const fr = at(half, 0);
  const br = at(half, depth);
  const bl = at(-half, depth);
  const probes: Vec2[] = [
    fl,
    fr,
    br,
    bl,
    at(0, 0),
    at(half, depth / 2),
    at(0, depth),
    at(-half, depth / 2),
    at(0, depth / 2),
    at(-half / 2, depth / 4),
    at(half / 2, depth / 4),
    at(half / 2, (depth * 3) / 4),
    at(-half / 2, (depth * 3) / 4),
  ];
  return {
    polygon: ensureClockwise([fl, fr, br, bl]),
    frontEdge: [fl, fr],
    facing: Math.atan2(-nz, -nx),
    center: at(0, depth / 2),
    probes,
  };
}

/** 岸線の占有トラッキング(契約: 岸線点×距離 6 以内の waterside 区画) */
interface ShoreOccupancy {
  points: Vec2[];
  occupied: Uint8Array;
  occupiedCount: number;
}

function collectShorePoints(model: WorldModel): ShoreOccupancy {
  const points: Vec2[] = [];
  for (const loop of model.water.shoreline.loops) {
    for (const p of loop.points) points.push(p);
  }
  return { points, occupied: new Uint8Array(points.length), occupiedCount: 0 };
}

/** 区画ポリゴンが新たに占有する岸線点のインデックス */
function newlyOccupiedShorePoints(
  shore: ShoreOccupancy,
  polygon: Polygon,
): number[] {
  const b = polygonBounds(polygon);
  const found: number[] = [];
  for (let i = 0; i < shore.points.length; i++) {
    if (shore.occupied[i]) continue;
    const p = shore.points[i];
    if (!p) continue;
    if (
      p.x < b.minX - SHORE_OCCUPY_DIST ||
      p.x > b.maxX + SHORE_OCCUPY_DIST ||
      p.z < b.minZ - SHORE_OCCUPY_DIST ||
      p.z > b.maxZ + SHORE_OCCUPY_DIST
    ) {
      continue;
    }
    if (polygonSignedDistance(p.x, p.z, polygon) <= SHORE_OCCUPY_DIST) {
      found.push(i);
    }
  }
  return found;
}

/** 衝突検査に使う周辺環境(段11・段12で共有する形) */
export interface SiteContext {
  /** 湖・池の waterSdf(正=陸側) */
  waterBodySdf: (x: number, z: number) => number;
  /** 水路の sdf(中心線距離 − 幅/2。水路が無ければ +∞) */
  canalSdf: (x: number, z: number) => number;
  /** 境界の内側距離 */
  boundaryInside: (x: number, z: number) => number;
}

/** モデルから衝突検査の環境を作る(段12「建物」も同じ判定を使う) */
export function createSiteContext(model: WorldModel): SiteContext {
  const field = createWaterField(model.ground.boundary, waterBodies(model.water));
  const boundaryRadius = createBoundaryRadius(model.ground.boundary);
  const canals = model.water.canals;
  return {
    waterBodySdf: field.waterSdf,
    canalSdf:
      canals.length === 0
        ? () => Infinity
        : (x, z) => {
            let d = Infinity;
            for (const canal of canals) {
              d = Math.min(
                d,
                distToPolyline(x, z, canal.points) - canal.width / 2,
              );
            }
            return d;
          },
    boundaryInside: (x, z) =>
      boundaryRadius(Math.atan2(z, x)) - Math.hypot(x, z),
  };
}

/**
 * 折れ線(半幅 halfWidth+clearance)がポリゴンへ触れるか。
 * バウンディングボックスで粗く絞ってから segmentNearPolygon で確定する。
 */
export function polylineTouchesPolygon(
  path: Vec2[],
  polygon: Polygon,
  clearance: number,
): boolean {
  const b = polygonBounds(polygon);
  for (let i = 0; i + 1 < path.length; i++) {
    const a = path[i];
    const c = path[i + 1];
    if (!a || !c) continue;
    if (
      Math.max(a.x, c.x) < b.minX - clearance ||
      Math.min(a.x, c.x) > b.maxX + clearance ||
      Math.max(a.z, c.z) < b.minZ - clearance ||
      Math.min(a.z, c.z) > b.maxZ + clearance
    ) {
      continue;
    }
    if (segmentNearPolygon(a, c, polygon, clearance)) return true;
  }
  return false;
}

/** 衝突棄却(契約の一覧)。当たったら true(=棄却) */
function rejectByCollision(
  model: WorldModel,
  ctx: SiteContext,
  rect: CandidateRect,
  accepted: Parcel[],
): boolean {
  const { derived } = model.meta;

  // (7) 境界の外(マージン 2)
  for (const p of rect.probes) {
    if (ctx.boundaryInside(p.x, p.z) < BOUNDARY_MARGIN) return true;
  }
  // (2) 水面 = 湖・池+水路
  for (const p of rect.probes) {
    if (ctx.waterBodySdf(p.x, p.z) < WATER_CLEAR) return true;
    if (ctx.canalSdf(p.x, p.z) < WATER_CLEAR) return true;
  }
  // (1) 広場ポリゴン
  const rectB = polygonBounds(rect.polygon);
  for (const plaza of model.plazas) {
    const reach = plaza.radius + PLAZA_CLEAR;
    if (
      plaza.position.x < rectB.minX - reach ||
      plaza.position.x > rectB.maxX + reach ||
      plaza.position.z < rectB.minZ - reach ||
      plaza.position.z > rectB.maxZ + reach
    ) {
      continue;
    }
    for (const p of rect.probes) {
      if (polygonSignedDistance(p.x, p.z, plaza.polygon) < PLAZA_CLEAR) {
        return true;
      }
    }
  }
  // (3) 道路(全 edge。クリアランス width/2 + 0.3)
  for (const edge of model.network.edges) {
    if (
      polylineTouchesPolygon(edge.path, rect.polygon, edge.width / 2 + ROAD_CLEAR)
    ) {
      return true;
    }
  }
  // (4) 結界環バッファ
  const ring = model.wards.ringPath;
  if (ring.length >= 3) {
    for (const p of rect.probes) {
      if (Math.abs(polygonSignedDistance(p.x, p.z, ring)) < RING_BUFFER) {
        return true;
      }
    }
    // 環がプローブの間を貫通するケースは辺交差で拾う
    const closedRing = [...ring, ring[0] as Vec2];
    if (polylineTouchesPolygon(closedRing, rect.polygon, RING_BUFFER)) {
      return true;
    }
  }
  // (5) centerPlan の予約(parcelReserve 半径の円 + footprint ポリゴン)
  const reserveR = (derived.parcelReserve * derived.centerFootprint) / 2;
  const c = model.centerPlan.position;
  for (const p of rect.probes) {
    if (Math.hypot(p.x - c.x, p.z - c.z) < reserveR) return true;
  }
  const foot = model.centerPlan.footprint;
  if (foot.length >= 3) {
    for (const p of rect.probes) {
      if (polygonSignedDistance(p.x, p.z, foot) < CENTER_FOOTPRINT_CLEAR) {
        return true;
      }
    }
  }
  // (6) 既採択の区画
  for (const other of accepted) {
    const ob = polygonBounds(other.polygon);
    if (
      ob.minX > rectB.maxX ||
      ob.maxX < rectB.minX ||
      ob.minZ > rectB.maxZ ||
      ob.maxZ < rectB.minZ
    ) {
      continue;
    }
    if (polygonsOverlap(rect.polygon, other.polygon)) return true;
  }
  return false;
}

/** パイプライン段の実体: density.final と parcels を埋める */
export function runParcels(model: WorldModel): void {
  const { seed, derived } = model.meta;
  let violations = 0;

  // --- 最終密度場 ---
  const final = computeFinalDensity(model);
  model.density.final = final;
  if (!final) {
    violations++;
    console.warn(`parcels: パイプライン内アサーション違反 ${violations} 件`);
    model.parcels = [];
    return;
  }

  // --- 区画分割 ---
  const ctx = createSiteContext(model);
  const shore = collectShorePoints(model);
  const accepted: Parcel[] = [];
  let capReached = false;

  for (const edge of model.network.edges) {
    if (capReached) break;
    const total = pathLength(edge.path);
    const frontOffset = edge.width / 2 + FRONT_GAP;
    let s = END_MARGIN;
    let slot = 0;
    while (s < total - END_MARGIN && !capReached) {
      const at = pointAlong(edge.path, s);
      const d0 = sampleFieldGrid(final, at.p.x, at.p.z);
      const frontage = clamp(
        derived.parcelSize * (1.35 - 0.75 * d0),
        FRONTAGE_MIN,
        FRONTAGE_MAX,
      );
      if (s + frontage > total - END_MARGIN) break;
      const mid = pointAlong(edge.path, s + frontage / 2);

      for (const side of [1, -1] as const) {
        if (capReached) break;
        const id = `parcel/${edge.id}/${side === 1 ? "L" : "R"}/${slot}`;
        const rng = makeRng(seed, id);
        // 消費順を固定: 奥行き揺らぎ → 採択ロール
        const depthJitter = rng.range(0.9, 1.1);
        const adoptRoll = rng.next();
        const baseDepth = clamp(
          frontage * DEPTH_RATIO * depthJitter,
          DEPTH_MIN,
          DEPTH_MAX,
        );
        // 奥行きの縮小リトライ(通らない候補は浅くして狭い帯にも通す)
        let rect: CandidateRect | null = null;
        for (const scale of DEPTH_SHRINK_STEPS) {
          const depth = Math.max(baseDepth * scale, DEPTH_SHRINK_MIN);
          const candidate = buildRect(
            mid.p,
            mid.angle,
            side,
            frontage,
            depth,
            frontOffset,
          );
          if (!rejectByCollision(model, ctx, candidate, accepted)) {
            rect = candidate;
            break;
          }
          if (depth <= DEPTH_SHRINK_MIN) break;
        }
        if (!rect) continue;

        // 水辺判定(契約: プローブの最小距離 < 4.5)
        let minWaterBody = Infinity;
        let minCanal = Infinity;
        for (const p of rect.probes) {
          minWaterBody = Math.min(minWaterBody, ctx.waterBodySdf(p.x, p.z));
          minCanal = Math.min(minCanal, ctx.canalSdf(p.x, p.z));
        }
        const waterside = minWaterBody < NEAR_WATER;
        const canalside = minCanal < NEAR_WATER;

        // 採択確率: parcelRate × 密度係数。水辺は watersideRate で押し上げ
        const dc = sampleFieldGrid(final, rect.center.x, rect.center.z);
        let adoptP =
          derived.parcelRate * (0.15 + 0.85 * smoothstep(0.04, 0.55, dc));
        if (waterside || canalside) {
          adoptP = Math.min(
            0.98,
            adoptP * (1 + WATERSIDE_BOOST * derived.watersideRate),
          );
        }
        if (adoptRoll >= adoptP) continue;

        // 岸線占有率 40% 上限(waterside 候補のみ)
        let newShore: number[] = [];
        if (waterside && shore.points.length > 0) {
          newShore = newlyOccupiedShorePoints(shore, rect.polygon);
          if (
            shore.occupiedCount + newShore.length >
            SHORE_OCCUPY_CAP * shore.points.length
          ) {
            continue;
          }
        }
        for (const i of newShore) {
          shore.occupied[i] = 1;
          shore.occupiedCount++;
        }

        accepted.push({
          id,
          roadEdgeId: edge.id,
          polygon: rect.polygon,
          frontEdge: rect.frontEdge,
          facing: rect.facing,
          waterside,
          canalside,
        });
        if (accepted.length >= derived.parcelCountMax) capReached = true;
      }
      slot++;
      s += frontage + SLOT_GAP;
    }
  }

  model.parcels = accepted;

  // --- パイプライン内アサーション(throw せず件数を console に出す) ---
  // 接道保証: frontEdge 中点から接道 edge への距離 ≤ width/2 + 2.0
  const edgeById = new Map(model.network.edges.map((e) => [e.id, e]));
  for (const parcel of accepted) {
    const edge = edgeById.get(parcel.roadEdgeId);
    if (!edge) {
      violations++;
      continue;
    }
    const [a, b] = parcel.frontEdge;
    const mid = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
    if (distToPolyline(mid.x, mid.z, edge.path) > edge.width / 2 + 2.0) {
      violations++;
    }
  }
  // 既存区画との重なりゼロ(構成上ゼロのはず。再検査)
  for (let i = 0; i < accepted.length; i++) {
    const a = accepted[i];
    if (!a) continue;
    const ab = polygonBounds(a.polygon);
    for (let j = i + 1; j < accepted.length; j++) {
      const b = accepted[j];
      if (!b) continue;
      const bb = polygonBounds(b.polygon);
      if (
        bb.minX > ab.maxX ||
        bb.maxX < ab.minX ||
        bb.minZ > ab.maxZ ||
        bb.maxZ < ab.minZ
      ) {
        continue;
      }
      if (polygonsOverlap(a.polygon, b.polygon)) violations++;
    }
  }
  // 上限・密度場の整合
  if (accepted.length > derived.parcelCountMax) violations++;
  const primary = model.density.primary;
  if (primary) {
    for (let i = 0; i < final.values.length; i++) {
      const f = final.values[i] ?? 0;
      const p = primary.values[i] ?? 0;
      if (f < p - 1e-9 || f < 0 || f > 1 || !Number.isFinite(f)) violations++;
    }
  }
  // 岸線占有率
  if (
    shore.points.length > 0 &&
    shore.occupiedCount > SHORE_OCCUPY_CAP * shore.points.length
  ) {
    violations++;
  }
  if (violations > 0) {
    console.warn(`parcels: パイプライン内アサーション違反 ${violations} 件`);
  }
}
