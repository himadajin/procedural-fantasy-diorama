/**
 * 密度場グリッド(FieldGrid)の実体表現とアクセスヘルパー。
 * 表現の正は docs/internal/contracts/network-plaza.md(Density 節)。
 * zoneMask と同様のフラット配列グリッドで、プレーンな JSON シリアライズ可能
 * データと純関数のみで構成する(three 非依存・乱数非消費)。
 */

/**
 * グリッド解像度+float値(0〜1)。
 * グリッド全体は原点中心の正方 [-resolution×cellSize/2, +resolution×cellSize/2]²。
 * セルは行優先(z 外側 → x 内側)。
 */
export interface FieldGrid {
  /** 一辺セル数 */
  resolution: number;
  /** セル一辺の実寸 */
  cellSize: number;
  /** 長さ resolution²。0〜1 */
  values: number[];
}

/** 全セル 0 で初期化した FieldGrid を作る */
export function createFieldGrid(resolution: number, cellSize: number): FieldGrid {
  return {
    resolution,
    cellSize,
    values: new Array<number>(resolution * resolution).fill(0),
  };
}

/** セル (ix, iz) の values インデックス */
export function fieldCellIndex(grid: FieldGrid, ix: number, iz: number): number {
  return iz * grid.resolution + ix;
}

function clampIndex(i: number, max: number): number {
  return i < 0 ? 0 : i > max ? max : i;
}

/**
 * ワールド座標 (x, z) の場の値をバイリニア補間でサンプリングする。
 * セル中心を格子点とし、グリッド範囲外は端のセルへクランプする
 * (sampleZoneMask と同じ規約)。結界計画の等値線抽出と区画選別の正とする。
 */
export function sampleFieldGrid(grid: FieldGrid, x: number, z: number): number {
  const { resolution, cellSize, values } = grid;
  const half = (resolution * cellSize) / 2;
  const gx = (x + half) / cellSize - 0.5;
  const gz = (z + half) / cellSize - 0.5;
  const maxI = resolution - 1;
  const ix0 = clampIndex(Math.floor(gx), maxI);
  const iz0 = clampIndex(Math.floor(gz), maxI);
  const ix1 = clampIndex(ix0 + 1, maxI);
  const iz1 = clampIndex(iz0 + 1, maxI);
  const fx = Math.min(1, Math.max(0, gx - ix0));
  const fz = Math.min(1, Math.max(0, gz - iz0));

  const v00 = values[iz0 * resolution + ix0] ?? 0;
  const v10 = values[iz0 * resolution + ix1] ?? 0;
  const v01 = values[iz1 * resolution + ix0] ?? 0;
  const v11 = values[iz1 * resolution + ix1] ?? 0;
  const a = v00 + (v10 - v00) * fx;
  const b = v01 + (v11 - v01) * fx;
  return a + (b - a) * fz;
}
