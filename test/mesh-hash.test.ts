import { describe, expect, it } from "vitest";
import { hash3 } from "../src/mesh/buildings";
import { hash2 } from "../src/mesh/paving";

// 位置ハッシュの返り値域の契約(0 ≤ h < 1)を機械検証する。
// commit 18 のレビューで wardHash に見つかった符号バグ(最終段の XOR が
// 符号付き 32bit を返し約半数が負値になる)と同一パターンが hash3 / hash2
// にも残っていた。修正は最終演算後に `>>> 0` で符号なしへ正規化してから
// 除算する。負値が混じると明度ムラ `1 + AMP*(2h-1)` がムラ振幅の帯域
// (±8%。art-direction 5.1/5.2節)を超えて暗くなる。
describe("mesh 位置ハッシュ: 返り値域の契約(0 ≤ h < 1)", () => {
  // 符号バグは特定の入力で負の 32bit を出す。負座標・大座標を含む広い格子で
  // 走査し、旧実装なら約半数が負になる範囲を確実に踏む。
  const coords: number[] = [];
  for (let i = -80; i <= 80; i++) coords.push(i * 0.37);

  it("hash3: 全入力で 0 ≤ h < 1(負値・1 以上が出ない)", () => {
    let min = Infinity;
    let max = -Infinity;
    for (const x of coords) {
      for (const y of coords) {
        const z = x - y * 0.5;
        const h = hash3(x, y, z);
        expect(h).toBeGreaterThanOrEqual(0);
        expect(h).toBeLessThan(1);
        if (h < min) min = h;
        if (h > max) max = h;
      }
    }
    // 分布が 0〜1 に広く行き渡っていること(定数化・退化していない)
    expect(min).toBeLessThan(0.1);
    expect(max).toBeGreaterThan(0.9);
  });

  it("hash2: 全入力で 0 ≤ h < 1(負値・1 以上が出ない)", () => {
    let min = Infinity;
    let max = -Infinity;
    for (const x of coords) {
      for (const z of coords) {
        const h = hash2(x, z);
        expect(h).toBeGreaterThanOrEqual(0);
        expect(h).toBeLessThan(1);
        if (h < min) min = h;
        if (h > max) max = h;
      }
    }
    expect(min).toBeLessThan(0.1);
    expect(max).toBeGreaterThan(0.9);
  });

  it("明度ムラ 1 + AMP*(2h-1) がムラ帯域(±AMP)内に収まる", () => {
    // h ∈ [0,1) なら 2h-1 ∈ [-1,1) となり、ムラは [1-AMP, 1+AMP) に収まる。
    // 負の h だと 1-AMP を下回り帯域を割る(修正前のバグ)。
    const AMP = 0.08;
    for (const x of coords) {
      for (const z of coords) {
        const mottle3 = 1 + AMP * (hash3(x, 0, z) * 2 - 1);
        const mottle2 = 1 + AMP * (hash2(x, z) * 2 - 1);
        expect(mottle3).toBeGreaterThanOrEqual(1 - AMP);
        expect(mottle3).toBeLessThan(1 + AMP);
        expect(mottle2).toBeGreaterThanOrEqual(1 - AMP);
        expect(mottle2).toBeLessThan(1 + AMP);
      }
    }
  });
});
