/**
 * 材質ゾーングリッド(ZoneMask)の実体表現とアクセスヘルパー。
 * 表現の正は docs/internal/contracts/worldmodel.md(Ground 節)。
 * プレーンな JSON シリアライズ可能データと純関数のみで構成する(three 非依存)。
 */

/**
 * 材質ゾーンの種類。この並びが weights のチャネル順の正。
 * grass/dirt は地面段、sandbar/marsh は水系段、paved は段10「舗装」が書く
 * (contracts/worldmodel.md ZoneMask 節)。
 */
export const ZONE_KINDS = ["grass", "dirt", "sandbar", "marsh", "paved"] as const;
export type ZoneKind = (typeof ZONE_KINDS)[number];
export const ZONE_COUNT = ZONE_KINDS.length;

/**
 * 材質ゾーンのブレンドを持つグリッド。
 * グリッド全体は原点中心の正方 [-resolution×cellSize/2, +resolution×cellSize/2]²。
 * セルは行優先(z 外側 → x 内側)、セル内は ZONE_KINDS 順。
 */
export interface ZoneMask {
  /** 一辺セル数 */
  resolution: number;
  /** セル一辺の実寸 */
  cellSize: number;
  /** 長さ resolution²×4。各セルの重みは非負・合計1 */
  weights: number[];
  /** 長さ resolution²。明度ムラ係数(1±0.08。art-direction 5.2節) */
  brightness: number[];
}

/** 全セル草地(grass=1)・明度ムラなしで初期化した ZoneMask を作る */
export function createZoneMask(resolution: number, cellSize: number): ZoneMask {
  const cells = resolution * resolution;
  const weights = new Array<number>(cells * ZONE_COUNT).fill(0);
  for (let c = 0; c < cells; c++) weights[c * ZONE_COUNT] = 1;
  return {
    resolution,
    cellSize,
    weights,
    brightness: new Array<number>(cells).fill(1),
  };
}

/** セル (ix, iz) の weights 先頭インデックス */
export function zoneCellIndex(mask: ZoneMask, ix: number, iz: number): number {
  return (iz * mask.resolution + ix) * ZONE_COUNT;
}

/** サンプリング結果。weights は ZONE_KINDS 順(長さ ZONE_COUNT) */
export interface ZoneSample {
  weights: number[];
  brightness: number;
}

function clampIndex(i: number, max: number): number {
  return i < 0 ? 0 : i > max ? max : i;
}

/**
 * ワールド座標 (x, z) の材質ゾーンをバイリニア補間でサンプリングする。
 * セル中心を格子点とし、グリッド範囲外は端のセルへクランプする。
 * メッシュビルダーが頂点カラーへ変換する際の正とする(contracts/worldmodel.md)。
 */
export function sampleZoneMask(mask: ZoneMask, x: number, z: number): ZoneSample {
  const { resolution, cellSize, weights, brightness } = mask;
  const half = (resolution * cellSize) / 2;
  // セル中心座標系(セル ix の中心は x = (ix + 0.5)×cellSize − half)
  const gx = (x + half) / cellSize - 0.5;
  const gz = (z + half) / cellSize - 0.5;
  const maxI = resolution - 1;
  const ix0 = clampIndex(Math.floor(gx), maxI);
  const iz0 = clampIndex(Math.floor(gz), maxI);
  const ix1 = clampIndex(ix0 + 1, maxI);
  const iz1 = clampIndex(iz0 + 1, maxI);
  const fx = Math.min(1, Math.max(0, gx - ix0));
  const fz = Math.min(1, Math.max(0, gz - iz0));

  const c00 = iz0 * resolution + ix0;
  const c10 = iz0 * resolution + ix1;
  const c01 = iz1 * resolution + ix0;
  const c11 = iz1 * resolution + ix1;
  const w00 = (1 - fx) * (1 - fz);
  const w10 = fx * (1 - fz);
  const w01 = (1 - fx) * fz;
  const w11 = fx * fz;

  const out = new Array<number>(ZONE_COUNT).fill(0);
  for (let k = 0; k < ZONE_COUNT; k++) {
    out[k] =
      (weights[c00 * ZONE_COUNT + k] ?? 0) * w00 +
      (weights[c10 * ZONE_COUNT + k] ?? 0) * w10 +
      (weights[c01 * ZONE_COUNT + k] ?? 0) * w01 +
      (weights[c11 * ZONE_COUNT + k] ?? 0) * w11;
  }
  const b =
    (brightness[c00] ?? 1) * w00 +
    (brightness[c10] ?? 1) * w10 +
    (brightness[c01] ?? 1) * w01 +
    (brightness[c11] ?? 1) * w11;
  return { weights: out, brightness: b };
}
