/**
 * 決定論的な格子バリューノイズ。
 * 乱数ストリームを消費せず、格子点座標の整数ハッシュのみから値を得るため、
 * 評価順序・評価回数に依存しない(implementation-spec 1.4節の順序非依存規約)。
 * 空間的に連続な場(材質ゾーンの斑・境界の揺らぎ・明度ムラ)に使う。
 */
import { hashString } from "../rng";

/** ノイズ場の識別子。seed と用途ラベルから 32bit のノイズシードを得る */
export function noiseSeed(seed: string, label: string): number {
  return hashString(seed + "/" + label);
}

/** 格子点 (ix, iz) の決定論的な値 [0, 1) */
function lattice(seedHash: number, ix: number, iz: number): number {
  let h = seedHash ^ Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iz, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

/** 2Dバリューノイズ [0, 1)。座標1.0がおよそ1波長 */
export function valueNoise2D(seedHash: number, x: number, z: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = smooth(x - ix);
  const fz = smooth(z - iz);
  const v00 = lattice(seedHash, ix, iz);
  const v10 = lattice(seedHash, ix + 1, iz);
  const v01 = lattice(seedHash, ix, iz + 1);
  const v11 = lattice(seedHash, ix + 1, iz + 1);
  const a = v00 + (v10 - v00) * fx;
  const b = v01 + (v11 - v01) * fx;
  return a + (b - a) * fz;
}

/** フラクタル(fBm)バリューノイズ。振幅の合計で正規化した [0, 1) */
export function fbm2D(
  seedHash: number,
  x: number,
  z: number,
  octaves: number,
  lacunarity = 2,
  gain = 0.5,
): number {
  let sum = 0;
  let amp = 1;
  let total = 0;
  let fx = x;
  let fz = z;
  for (let o = 0; o < octaves; o++) {
    // オクターブごとにシードをずらし、格子の重なりによる縞を避ける
    sum += amp * valueNoise2D((seedHash + o * 0x9e3779b9) >>> 0, fx, fz);
    total += amp;
    amp *= gain;
    fx *= lacunarity;
    fz *= lacunarity;
  }
  return sum / total;
}
