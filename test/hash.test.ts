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
  // commit 20(PHASE 6)で植生ぶんを更新。意図した変更:
  // 段14「植生」が vegetation(trees / shrubs / grassPatches)を埋める
  // (contracts/worldmodel.md Vegetation 節)。乱数はセルごとの独立
  // サブストリーム "vegetation/<ix>_<iz>" のみ消費する追記のため、
  // vegetation 以外のフィールドは commit 19 から不変だが、vegetation は
  // 全組で非空になるため 8 組すべてのハッシュが変わる。
  // 新旧対応(commit 19 → commit 20):
  //   everdusk-101 {}              5d0f8d8a → 884882c7
  //   everdusk-101 {water:0}       c34855b1 → f1a62db2
  //   everdusk-101 {water:95}      f0ddcce4 → 58609e07
  //   everdusk-101 {worldScale:0}  afcc7682 → cd8205af
  //   everdusk-101 {worldScale:100} 7973e55b → 06acdfcb
  //   seed-a {}                    63531fdd → 413344bc
  //   seed-b {}                    544a44f9 → 360ce1b7
  //   seed-b {water:70}            333123e8 → 37add040
  const SNAPSHOTS: [string, Partial<Params>, string][] = [
    ["everdusk-101", {}, "884882c7"],
    ["everdusk-101", { water: 0 }, "f1a62db2"],
    ["everdusk-101", { water: 95 }, "58609e07"],
    ["everdusk-101", { worldScale: 0 }, "cd8205af"],
    ["everdusk-101", { worldScale: 100 }, "06acdfcb"],
    ["seed-a", {}, "413344bc"],
    ["seed-b", {}, "360ce1b7"],
    ["seed-b", { water: 70 }, "37add040"],
  ];

  for (const [seed, over, expected] of SNAPSHOTS) {
    it(`seed=${seed} ${JSON.stringify(over)} → ${expected}`, async () => {
      const model = await runPipeline(seed, withParams(over));
      expect(model.summary.hash).toBe(expected);
    });
  }
});
