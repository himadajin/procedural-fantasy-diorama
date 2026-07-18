/**
 * 段10「舗装」: 道路・広場・水路の footprint で zoneMask の舗装チャネルを
 * 上書きする(contracts/ground-water.md ZoneMask 節)。
 *
 * - 各セルの舗装被覆度 p(0〜1)を、道路(edge.path への距離 − width/2)、
 *   広場(polygon の符号付き距離)、水路(スプラインへの距離 − width/2 −
 *   護岸幅)の最大被覆から求め、縁は短いブレンド帯で滑らかに落とす
 * - 既存チャネルを (1 − p) 倍へ縮めて paved に p を置き、
 *   「非負・合計 1」の規約を保つ
 * - 乱数サブストリームは消費しない(入力データのみの決定的なラスタライズ。
 *   被覆の合成は max なのでスタンプ順にも依存しない)
 * - 舗装の色はメッシュビルダーが derived.roadGrade から決める
 *   (土→砂利→石畳。art-direction 5.2節)
 */
import type { Polygon, Vec2, WorldModel } from "../model/worldmodel";
import { ZONE_COUNT, ZONE_KINDS, type ZoneMask } from "../model/zonemask";
import { polygonSignedDistance } from "../model/waterfield";

/** 道路の縁のブレンド帯(実寸)。路肩の踏み固めが土地へ馴染む幅 */
const ROAD_BLEND = 2.2;
/** 広場の縁のブレンド帯(実寸) */
const PLAZA_BLEND = 1.8;
/** 水路の護岸(縁石・石積み)の幅相当。この縁まで舗装として扱う */
const CANAL_APRON = 0.9;
/** 水路の縁のブレンド帯(実寸) */
const CANAL_BLEND = 1.6;
/**
 * ブレンド帯の下限(セル寸比)。zoneMask のセル寸(≒5)は道路幅(2.6〜3.6)
 * より粗いため、固定のブレンド帯ではセル中心の間で被覆が途切れる。
 * 下限をセル寸の 0.9 倍とし、細い footprint でも帯が連続するようにする
 * (contracts/ground-water.md ZoneMask 節)。
 */
const BLEND_CELL_RATIO = 0.9;

const PAVED_INDEX = ZONE_KINDS.indexOf("paved");

function smoothstep01(t: number): number {
  const k = Math.min(1, Math.max(0, t));
  return k * k * (3 - 2 * k);
}

/** 点 (px, pz) と線分 ab の距離 */
function distToSegment(
  px: number,
  pz: number,
  a: Vec2,
  b: Vec2,
): number {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const lenSq = dx * dx + dz * dz;
  const t =
    lenSq > 0
      ? Math.min(1, Math.max(0, ((px - a.x) * dx + (pz - a.z) * dz) / lenSq))
      : 0;
  return Math.hypot(px - (a.x + dx * t), pz - (a.z + dz * t));
}

/** セル中心座標系(zonemask.ts の sampleZoneMask と同じ張り)のヘルパー */
export interface CellGrid {
  resolution: number;
  cellSize: number;
  half: number;
}

/** ZoneMask のセル中心座標系(段12「建物」の footprint 上書きも共有する) */
export function maskCellGrid(mask: ZoneMask): CellGrid {
  return {
    resolution: mask.resolution,
    cellSize: mask.cellSize,
    half: (mask.resolution * mask.cellSize) / 2,
  };
}

function cellCenter(grid: CellGrid, ix: number, iz: number): Vec2 {
  return {
    x: (ix + 0.5) * grid.cellSize - grid.half,
    z: (iz + 0.5) * grid.cellSize - grid.half,
  };
}

/** ワールド座標範囲 [min, max] をセルインデックス範囲へ変換(クランプ込み) */
function cellRange(
  grid: CellGrid,
  min: number,
  max: number,
): [number, number] {
  const lo = Math.max(0, Math.floor((min + grid.half) / grid.cellSize - 0.5));
  const hi = Math.min(
    grid.resolution - 1,
    Math.ceil((max + grid.half) / grid.cellSize - 0.5),
  );
  return [lo, hi];
}

/**
 * 折れ線(半幅 halfWidth)の被覆をセルへスタンプする。
 * 被覆は max 合成なので、スプライン・セグメントの走査順に依存しない。
 * 段13「小道」の lane 被覆の追記も共有する(contracts/ground-water.md ZoneMask 節)。
 */
export function stampPath(
  grid: CellGrid,
  coverage: Float64Array,
  points: Vec2[],
  halfWidth: number,
  blend: number,
): void {
  const reach = halfWidth + blend;
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (!a || !b) continue;
    const [ix0, ix1] = cellRange(
      grid,
      Math.min(a.x, b.x) - reach,
      Math.max(a.x, b.x) + reach,
    );
    const [iz0, iz1] = cellRange(
      grid,
      Math.min(a.z, b.z) - reach,
      Math.max(a.z, b.z) + reach,
    );
    for (let iz = iz0; iz <= iz1; iz++) {
      for (let ix = ix0; ix <= ix1; ix++) {
        const c = cellCenter(grid, ix, iz);
        const d = distToSegment(c.x, c.z, a, b) - halfWidth;
        if (d >= blend) continue;
        const p = 1 - smoothstep01(d / blend);
        const idx = iz * grid.resolution + ix;
        if (p > (coverage[idx] ?? 0)) coverage[idx] = p;
      }
    }
  }
}

/**
 * 閉多角形の被覆をセルへスタンプする(内側 1、縁で blend 幅のフォールオフ)。
 * max 合成なのでスタンプ順に依存しない。段12「建物」の footprint 上書きも
 * 同じ流儀を共有する(contracts/ground-water.md ZoneMask 節)。
 */
export function stampPolygon(
  grid: CellGrid,
  coverage: Float64Array,
  polygon: Polygon,
  blend: number,
): void {
  if (polygon.length < 3) return;
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const p of polygon) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minZ = Math.min(minZ, p.z);
    maxZ = Math.max(maxZ, p.z);
  }
  const [ix0, ix1] = cellRange(grid, minX - blend, maxX + blend);
  const [iz0, iz1] = cellRange(grid, minZ - blend, maxZ + blend);
  for (let iz = iz0; iz <= iz1; iz++) {
    for (let ix = ix0; ix <= ix1; ix++) {
      const c = cellCenter(grid, ix, iz);
      const d = polygonSignedDistance(c.x, c.z, polygon);
      if (d >= blend) continue;
      const p = 1 - smoothstep01(d / blend);
      const idx = iz * grid.resolution + ix;
      if (p > (coverage[idx] ?? 0)) coverage[idx] = p;
    }
  }
}

/** 道路・広場・水路の footprint から舗装被覆度のグリッドを求める(純関数) */
export function computePavedCoverage(model: WorldModel): Float64Array {
  const mask = model.ground.zoneMask;
  const grid: CellGrid = {
    resolution: mask.resolution,
    cellSize: mask.cellSize,
    half: (mask.resolution * mask.cellSize) / 2,
  };
  const coverage = new Float64Array(mask.resolution * mask.resolution);
  const blendFloor = mask.cellSize * BLEND_CELL_RATIO;
  for (const edge of model.network.edges) {
    stampPath(
      grid,
      coverage,
      edge.path,
      edge.width / 2,
      Math.max(ROAD_BLEND, blendFloor),
    );
  }
  for (const canal of model.water.canals) {
    stampPath(
      grid,
      coverage,
      canal.points,
      canal.width / 2 + CANAL_APRON,
      Math.max(CANAL_BLEND, blendFloor),
    );
  }
  for (const plaza of model.plazas) {
    stampPolygon(grid, coverage, plaza.polygon, Math.max(PLAZA_BLEND, blendFloor));
  }
  return coverage;
}

/**
 * 被覆度で zoneMask の指定チャネルを上書きする
 * (他チャネルを (1−p) 倍へ縮め、対象チャネルに p を置く。
 * 「非負・合計 1」の規約を保つ。段12「建物」の上書きも共有する)。
 */
export function applyCoverageToChannel(
  mask: ZoneMask,
  coverage: Float64Array,
  channel: number,
): void {
  const cells = mask.resolution * mask.resolution;
  for (let c = 0; c < cells; c++) {
    const p = coverage[c] ?? 0;
    if (p <= 1e-4) continue;
    const base = c * ZONE_COUNT;
    for (let k = 0; k < ZONE_COUNT; k++) {
      if (k === channel) continue;
      mask.weights[base + k] = (mask.weights[base + k] ?? 0) * (1 - p);
    }
    mask.weights[base + channel] =
      (mask.weights[base + channel] ?? 0) * (1 - p) + p;
  }
}

/** 被覆度で zoneMask を上書きする(既存チャネルを (1−p) 倍、paved に p) */
export function applyPavedCoverage(mask: ZoneMask, coverage: Float64Array): void {
  applyCoverageToChannel(mask, coverage, PAVED_INDEX);
}

/** パイプライン段の実体: zoneMask の舗装チャネルを上書きする */
export function runPaving(model: WorldModel): void {
  const mask = model.ground.zoneMask;
  if (mask.resolution <= 0) return;
  applyPavedCoverage(mask, computePavedCoverage(model));
}
