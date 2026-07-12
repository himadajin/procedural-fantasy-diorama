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

export function smoothstep(edge0: number, edge1: number, v: number): number {
  const t = clamp((v - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** 解像度(契約: 64 固定) */
const DENSITY_RESOLUTION = 64;
/** グリッドの張り(ワールド一辺比。waterfield と同じ) */
const DENSITY_SPAN_RATIO = 1.1;
/** 道路近接ブーストの届く距離と強さ(main / connector / street。Phase B) */
const ROAD_REACH_MAIN = 18;
const ROAD_REACH_CONNECTOR = 12;
const ROAD_REACH_STREET = 10;
const ROAD_BOOST_MAIN = 0.32;
const ROAD_BOOST_CONNECTOR = 0.2;
const ROAD_BOOST_STREET = 0.16;
/** 外縁フェードの幅(marginWidth 比) */
const EDGE_FADE_RATIO = 0.6;
/**
 * urbanity(市街度)正規化の smoothstep 下端(契約の提案値。
 * network-plaza.md「Density 節 zoning」)。
 * urbanity = smoothstep(URBANITY_EDGE0, URBANITY_THRESHOLD, protoDensity + 0.5×roadBoost)
 */
export const URBANITY_EDGE0 = 0.1;
/**
 * urbanity 正規化の smoothstep 上端 = 市街ゾーンの閾値(urbanity ≥ これで
 * 市街ゾーン、未満は農村ゾーン。契約: 両者は同じ 0.45 という提案値)
 */
export const URBANITY_THRESHOLD = 0.45;

interface Segment {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  reach: number;
  strength: number;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/** class ごとの届く距離・強さ(main > connector > street。lane は対象外) */
function reachAndStrength(cls: WorldModel["network"]["edges"][number]["class"]): {
  reach: number;
  strength: number;
} | null {
  if (cls === "main") return { reach: ROAD_REACH_MAIN, strength: ROAD_BOOST_MAIN };
  if (cls === "connector") {
    return { reach: ROAD_REACH_CONNECTOR, strength: ROAD_BOOST_CONNECTOR };
  }
  if (cls === "street") {
    return { reach: ROAD_REACH_STREET, strength: ROAD_BOOST_STREET };
  }
  return null; // lane は近接ブーストの対象外(段7 の時点では存在しない)
}

function collectRoadSegments(model: WorldModel): Segment[] {
  const segments: Segment[] = [];
  for (const edge of model.network.edges) {
    const rs = reachAndStrength(edge.class);
    if (!rs) continue;
    for (let i = 0; i + 1 < edge.path.length; i++) {
      const a = edge.path[i];
      const b = edge.path[i + 1];
      if (!a || !b) continue;
      segments.push({
        ax: a.x,
        az: a.z,
        bx: b.x,
        bz: b.z,
        reach: rs.reach,
        strength: rs.strength,
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

/**
 * 中心の指数減衰(centerTerm)と外縁フェード(fade)の内訳(道路近接ブースト前)。
 * proto-density(道路近接ブーストを除く生値)は centerTerm × fade に等しい。
 */
export interface DensityDecayParts {
  centerTerm: number;
  fade: number;
}

/**
 * 中心の指数減衰 × 外縁フェード(道路近接ブーストを除く部分)を評価する
 * 純関数を返す(createWaterField / createBoundaryRadius と同じ「factory が
 * 前処理を1回だけ行い、返した閉関数を多数回呼ぶ」流儀)。
 * density.ts(段7。本ファイル)と streets.ts(段5後半サブフェーズ)が
 * 同じ実装を共有する(contracts/network-plaza.md「二次街路の有機成長」
 * 「成長優先度場」)。乱数は消費しない。
 */
export function createDensityDecay(
  model: WorldModel,
): (x: number, z: number) => DensityDecayParts {
  const { derived } = model.meta;
  const size = model.ground.size;
  const radius = createBoundaryRadius(model.ground.boundary);
  const center = model.centerPlan.position;
  const falloffDist = Math.max(1, derived.densityFalloff * size);
  const fadeWidth = Math.max(4, derived.marginWidth * EDGE_FADE_RATIO);
  return (x, z) => {
    // 外縁フェード(境界外は 0。等値線が境界内で閉じる)
    const bSdf = radius(Math.atan2(z, x)) - Math.hypot(x, z);
    const fade = smoothstep(0, fadeWidth, bSdf);
    if (fade <= 0) return { centerTerm: 0, fade: 0 };
    // 中心距離の指数減衰(densityPeak を最大値、falloffDist を半減距離)
    const d = Math.hypot(x - center.x, z - center.z);
    const centerTerm = derived.densityPeak * Math.pow(2, -d / falloffDist);
    return { centerTerm, fade };
  };
}

/**
 * proto-density(中心の指数減衰 × 外縁フェード。道路近接ブーストを含まない
 * 生値)。streets.ts の成長優先度場・市街限定閾値が使う
 * (contracts/network-plaza.md「二次街路の有機成長」)。
 */
export function protoDensityAt(
  decay: (x: number, z: number) => DensityDecayParts,
  x: number,
  z: number,
): number {
  const { centerTerm, fade } = decay(x, z);
  return centerTerm * fade;
}

/** パイプライン段の実体: density.primary・model.zoning を埋める */
export function runDensity(model: WorldModel): void {
  const { derived } = model.meta;
  const size = model.ground.size;
  const cellSize = (size * DENSITY_SPAN_RATIO) / DENSITY_RESOLUTION;
  const grid = createFieldGrid(DENSITY_RESOLUTION, cellSize);
  const zoningGrid = createFieldGrid(DENSITY_RESOLUTION, cellSize);
  const half = (DENSITY_RESOLUTION * cellSize) / 2;

  const decay = createDensityDecay(model);
  const segments = collectRoadSegments(model);
  const reachMax = Math.max(ROAD_REACH_MAIN, ROAD_REACH_CONNECTOR, ROAD_REACH_STREET);

  for (let iz = 0; iz < DENSITY_RESOLUTION; iz++) {
    for (let ix = 0; ix < DENSITY_RESOLUTION; ix++) {
      const x = (ix + 0.5) * cellSize - half;
      const z = (iz + 0.5) * cellSize - half;

      const { centerTerm, fade } = decay(x, z);
      // fade<=0(外縁の外)では protoDensity(= centerTerm×fade)が 0 になり、
      // zoning も既定値 0(createFieldGrid の初期値)のまま = 農村ゾーンで
      // primary(既存仕様)と同じ扱いになるため、continue でよい
      if (fade <= 0) continue;

      // 道路近接ブースト(main > connector > street)
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
        const distSq = distToSegmentSq(x, z, s);
        if (distSq >= s.reach * s.reach) continue;
        const v = s.strength * (1 - Math.sqrt(distSq) / s.reach);
        if (v > boost) boost = v;
      }

      grid.values[fieldCellIndex(grid, ix, iz)] =
        clamp(centerTerm + boost, 0, 1) * fade;

      // ゾーニング場(市街度 urbanity。契約: network-plaza.md「Density 節
      // zoning」)。protoDensity = centerTerm × fade(道路近接ブーストを
      // 含まない生値。protoDensityAt と同一式)、roadBoost は上記の boost を
      // そのまま使う。primary の算出(直上)には一切影響しない
      const protoDensity = centerTerm * fade;
      zoningGrid.values[fieldCellIndex(zoningGrid, ix, iz)] = smoothstep(
        URBANITY_EDGE0,
        URBANITY_THRESHOLD,
        protoDensity + 0.5 * boost,
      );
    }
  }

  model.density.primary = grid;
  model.zoning = zoningGrid;

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
