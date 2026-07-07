/**
 * 段7「一次密度場」: 中心からの距離(densityPeak / densityFalloff)、
 * 道路近接、Settlement Pressure から一次密度場を構成する。結界に依存しない。
 * データの正は docs/internal/contracts/network-plaza.md(Density 節)、
 * 設計は implementation-spec 1.3節(段7)・PHASE 3。
 *
 * - FieldGrid(model/fieldgrid.ts)へ格納する。解像度 64 固定、
 *   張りは waterfield と同じ(size×1.1)。結界計画の等値線抽出と
 *   後段の区画選別が sampleFieldGrid でサンプリングする
 * - 水域では 0 にしない(等値線が水域で歪まないようにする。契約)。
 *   境界の外はフェードで 0 に落とし、等値線が必ず境界内で閉じるようにする
 * - 乱数ストリームは消費しない(モデル状態からの決定論的な場)
 */
import type { WorldModel } from "../model/worldmodel";
import { createFieldGrid, fieldCellIndex } from "../model/fieldgrid";
import { createBoundaryRadius } from "../model/waterfield";

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

function smoothstep(edge0: number, edge1: number, v: number): number {
  const t = clamp((v - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** 解像度(契約: 64 固定) */
const DENSITY_RESOLUTION = 64;
/** グリッドの張り(ワールド一辺比。waterfield と同じ) */
const DENSITY_SPAN_RATIO = 1.1;
/** 道路近接ブーストの届く距離と強さ(main / connector) */
const ROAD_REACH_MAIN = 18;
const ROAD_REACH_CONNECTOR = 12;
const ROAD_BOOST_MAIN = 0.32;
const ROAD_BOOST_CONNECTOR = 0.2;
/** 外縁フェードの幅(marginWidth 比) */
const EDGE_FADE_RATIO = 0.6;

interface Segment {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  main: boolean;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

function collectRoadSegments(model: WorldModel): Segment[] {
  const segments: Segment[] = [];
  for (const edge of model.network.edges) {
    const main = edge.class === "main";
    for (let i = 0; i + 1 < edge.path.length; i++) {
      const a = edge.path[i];
      const b = edge.path[i + 1];
      if (!a || !b) continue;
      segments.push({
        ax: a.x,
        az: a.z,
        bx: b.x,
        bz: b.z,
        main,
        minX: Math.min(a.x, b.x),
        maxX: Math.max(a.x, b.x),
        minZ: Math.min(a.z, b.z),
        maxZ: Math.max(a.z, b.z),
      });
    }
  }
  return segments;
}

function distToSegmentSq(
  px: number,
  pz: number,
  s: Segment,
): number {
  const dx = s.bx - s.ax;
  const dz = s.bz - s.az;
  const lenSq = dx * dx + dz * dz;
  const t =
    lenSq > 0
      ? clamp(((px - s.ax) * dx + (pz - s.az) * dz) / lenSq, 0, 1)
      : 0;
  const ex = px - (s.ax + dx * t);
  const ez = pz - (s.az + dz * t);
  return ex * ex + ez * ez;
}

/** パイプライン段の実体: density.primary を埋める */
export function runDensity(model: WorldModel): void {
  const { derived } = model.meta;
  const size = model.ground.size;
  const cellSize = (size * DENSITY_SPAN_RATIO) / DENSITY_RESOLUTION;
  const grid = createFieldGrid(DENSITY_RESOLUTION, cellSize);
  const half = (DENSITY_RESOLUTION * cellSize) / 2;

  const radius = createBoundaryRadius(model.ground.boundary);
  const center = model.centerPlan.position;
  const falloffDist = Math.max(1, derived.densityFalloff * size);
  const fadeWidth = Math.max(4, derived.marginWidth * EDGE_FADE_RATIO);
  const segments = collectRoadSegments(model);
  const reachMax = Math.max(ROAD_REACH_MAIN, ROAD_REACH_CONNECTOR);

  for (let iz = 0; iz < DENSITY_RESOLUTION; iz++) {
    for (let ix = 0; ix < DENSITY_RESOLUTION; ix++) {
      const x = (ix + 0.5) * cellSize - half;
      const z = (iz + 0.5) * cellSize - half;

      // 外縁フェード(境界外は 0。等値線が境界内で閉じる)
      const bSdf = radius(Math.atan2(z, x)) - Math.hypot(x, z);
      const fade = smoothstep(0, fadeWidth, bSdf);
      if (fade <= 0) continue;

      // 中心距離の指数減衰(densityPeak を最大値、falloffDist を半減距離)
      const d = Math.hypot(x - center.x, z - center.z);
      const centerTerm = derived.densityPeak * Math.pow(2, -d / falloffDist);

      // 道路近接ブースト(main > connector)
      let boost = 0;
      for (const s of segments) {
        if (
          x < s.minX - reachMax ||
          x > s.maxX + reachMax ||
          z < s.minZ - reachMax ||
          z > s.maxZ + reachMax
        ) {
          continue;
        }
        const reach = s.main ? ROAD_REACH_MAIN : ROAD_REACH_CONNECTOR;
        const distSq = distToSegmentSq(x, z, s);
        if (distSq >= reach * reach) continue;
        const strength = s.main ? ROAD_BOOST_MAIN : ROAD_BOOST_CONNECTOR;
        const v = strength * (1 - Math.sqrt(distSq) / reach);
        if (v > boost) boost = v;
      }

      grid.values[fieldCellIndex(grid, ix, iz)] =
        clamp(centerTerm + boost, 0, 1) * fade;
    }
  }

  model.density.primary = grid;

  // パイプライン内アサーション: 違反は throw せず件数を console に出す
  let violations = 0;
  let maxValue = 0;
  for (const v of grid.values) {
    if (v < 0 || v > 1 || !Number.isFinite(v)) violations++;
    if (v > maxValue) maxValue = v;
  }
  // 中心付近に等値線抽出へ足る密度の山があること
  if (maxValue < derived.densityPeak * 0.5) violations++;
  if (violations > 0) {
    console.warn(`density: パイプライン内アサーション違反 ${violations} 件`);
  }
}
