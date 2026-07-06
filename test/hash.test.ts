import { describe, expect, it } from "vitest";
import { DEFAULT_PARAMS, type Params } from "../src/model/worldmodel";
import { hashWorldModel } from "../src/model/hash";
import { runPipeline } from "../src/pipeline/run";

function withParams(over: Partial<Params>): Params {
  return { ...DEFAULT_PARAMS, ...over };
}

describe("hashWorldModel: 決定性(contracts/pipeline.md)", () => {
  it("同一入力の2回生成でハッシュが一致し、summary.hash に格納される", async () => {
    const a = await runPipeline("everdusk-101", DEFAULT_PARAMS);
    const b = await runPipeline("everdusk-101", DEFAULT_PARAMS);
    expect(a.summary.hash).toBe(b.summary.hash);
    expect(a.summary.hash).toMatch(/^[0-9a-f]{8}$/);
  });

  it("summary.hash 自身はハッシュ計算から除外される(格納後も不変)", async () => {
    const model = await runPipeline("everdusk-101", DEFAULT_PARAMS);
    const stored = model.summary.hash;
    // 格納済みの状態で再計算しても同じ値になる
    expect(hashWorldModel(model)).toBe(stored);
    model.summary.hash = "ffffffff";
    expect(hashWorldModel(model)).toBe(stored);
  });

  it("seed・params が違えばハッシュが変わる", async () => {
    const base = await runPipeline("everdusk-101", DEFAULT_PARAMS);
    const otherSeed = await runPipeline("seed-a", DEFAULT_PARAMS);
    const otherParams = await runPipeline(
      "everdusk-101",
      withParams({ water: 51 }),
    );
    expect(otherSeed.summary.hash).not.toBe(base.summary.hash);
    expect(otherParams.summary.hash).not.toBe(base.summary.hash);
  });
});

describe("hashWorldModel: 代表 seed×params のスナップショット固定", () => {
  // 意図した生成変更でこの表が変わる場合は、スナップショット更新を同一commitに
  // 含め、意図を commit メッセージに記す(implementation-spec 1.10節)
  // commit 16(PHASE 5a)で全組を更新済み。意図した変更:
  // 段12「建物」の中心建築展開の追加により、buildings 末尾への
  // role "center" の 1 棟(専用の拡張文法・スカイライン引き上げ込み)と、
  // 中庭の Plaza(kind "courtyard"。成立する組のみ)が全組に入る。
  // 一般建物・区画・道路・結界など段1〜11 と段12 の一般建物ぶんの出力は
  // commit 15 と完全一致(中心建築は独立サブストリーム "building/center" 系
  // のみを消費する追記。test/center.test.ts で機械検証)。
  // 新旧対応:
  //   everdusk-101 {}              85234e3f → 0ad4197f
  //   everdusk-101 {water:0}       90586daa → c34855b1
  //   everdusk-101 {water:95}      c6019296 → f0ddcce4
  //   everdusk-101 {worldScale:0}  43094937 → afcc7682
  //   everdusk-101 {worldScale:100} 18cd6e5f → 0a6e0424
  //   seed-a {}                    a00a17c8 → 63531fdd
  //   seed-b {}                    1386be4e → cd969f29
  //   seed-b {water:70}            909cd4d0 → b2e8a70d
  const SNAPSHOTS: [string, Partial<Params>, string][] = [
    ["everdusk-101", {}, "0ad4197f"],
    ["everdusk-101", { water: 0 }, "c34855b1"],
    ["everdusk-101", { water: 95 }, "f0ddcce4"],
    ["everdusk-101", { worldScale: 0 }, "afcc7682"],
    ["everdusk-101", { worldScale: 100 }, "0a6e0424"],
    ["seed-a", {}, "63531fdd"],
    ["seed-b", {}, "cd969f29"],
    ["seed-b", { water: 70 }, "b2e8a70d"],
  ];

  for (const [seed, over, expected] of SNAPSHOTS) {
    it(`seed=${seed} ${JSON.stringify(over)} → ${expected}`, async () => {
      const model = await runPipeline(seed, withParams(over));
      expect(model.summary.hash).toBe(expected);
    });
  }
});
