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
  // commit 9(段4「立地評価」・段5「道路網」の追加)で全組を更新済み
  const SNAPSHOTS: [string, Partial<Params>, string][] = [
    ["everdusk-101", {}, "b7cc33e3"],
    ["everdusk-101", { water: 0 }, "f1e45e44"],
    ["everdusk-101", { water: 95 }, "ad1bea94"],
    ["everdusk-101", { worldScale: 0 }, "5d4ace64"],
    ["everdusk-101", { worldScale: 100 }, "316465ef"],
    ["seed-a", {}, "0df7c817"],
    ["seed-b", {}, "15ae959d"],
    ["seed-b", { water: 70 }, "52caebc3"],
  ];

  for (const [seed, over, expected] of SNAPSHOTS) {
    it(`seed=${seed} ${JSON.stringify(over)} → ${expected}`, async () => {
      const model = await runPipeline(seed, withParams(over));
      expect(model.summary.hash).toBe(expected);
    });
  }
});
