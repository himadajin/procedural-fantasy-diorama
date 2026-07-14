import { describe, expect, it } from "vitest";
import { DEFAULT_SEED } from "../src/defaults";
import { DEFAULT_PARAMS } from "../src/model/worldmodel";
import { runPipeline } from "../src/pipeline/run";

/**
 * デフォルト seed の意図の恒久検証(implementation-spec 8章「総合検証」)。
 * デフォルト(全パラメータ 50 + 選定 seed)の初回表示が design.md の
 * 「各傾向の中間にある、破綻のない中立な集落」であることの機械検証可能な
 * 部分: 水路 1 本以上・wardLevel 2(部分結界)・部分的な結界壁+魔導塔。
 * DEFAULT_SEED を選定し直した場合はこのテストが新しい seed で成立することを
 * 確認する(成立しない seed は選定できない)。
 */
describe("デフォルト seed(全パラメータ 50)の生成内容", () => {
  it("水路 1 本以上・wardLevel 2・部分結界壁+魔導塔 1 基以上", async () => {
    const model = await runPipeline(DEFAULT_SEED, DEFAULT_PARAMS);

    // 水路が 1 本以上現れる(街の中の水路。design.md「水辺の表現」)
    expect(model.water.canals.length).toBeGreaterThanOrEqual(1);

    // Arcana 50 は wardLevel 2(閾値 15/45/75。implementation-spec 1.6節)
    expect(model.wards.wardLevel).toBe(2);

    // 部分結界壁: 壁セグメントと途切れ(gap)の両方を持つ
    // (完全閉環ではない部分的な結界壁。design.md「結界と魔法構造の表現」)
    const kinds = model.wards.ringSegments.map((s) => s.kind);
    expect(kinds).toContain("wall");
    expect(kinds).toContain("gap");

    // 魔導塔が 1 基以上見える
    expect(model.wards.towers.length).toBeGreaterThanOrEqual(1);

    // 破綻のない集落として建物と街が成立している(建物と街が主役)
    expect(model.buildings.length).toBeGreaterThan(10);
  });
});
