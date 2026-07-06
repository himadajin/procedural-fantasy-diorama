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
  // commit 15(PHASE 4b)で全組を更新済み。意図した変更:
  // 段13「小道」の追加により、network.nodes / edges への lane の追記、
  // zoneMask の舗装チャネルの小道被覆の追記、summary.scale.roadLength の
  // 加算が全組に入る(小道は全組で 1 本以上生成される)。
  // 段1〜12 の出力(建物の部品リスト・bridges を含む)は commit 14 と
  // 完全一致(段13 は追記のみ。test/lanes.test.ts で機械照合)。
  // 新旧対応:
  //   everdusk-101 {}              bbbf2f49 → 85234e3f
  //   everdusk-101 {water:0}       a9b3eb16 → 90586daa
  //   everdusk-101 {water:95}      005dc9ad → c6019296
  //   everdusk-101 {worldScale:0}  13481884 → 43094937
  //   everdusk-101 {worldScale:100} aa3e3971 → 18cd6e5f
  //   seed-a {}                    08142bad → a00a17c8
  //   seed-b {}                    56e992f2 → 1386be4e
  //   seed-b {water:70}            abb2ac43 → 909cd4d0
  const SNAPSHOTS: [string, Partial<Params>, string][] = [
    ["everdusk-101", {}, "85234e3f"],
    ["everdusk-101", { water: 0 }, "90586daa"],
    ["everdusk-101", { water: 95 }, "c6019296"],
    ["everdusk-101", { worldScale: 0 }, "43094937"],
    ["everdusk-101", { worldScale: 100 }, "18cd6e5f"],
    ["seed-a", {}, "a00a17c8"],
    ["seed-b", {}, "1386be4e"],
    ["seed-b", { water: 70 }, "909cd4d0"],
  ];

  for (const [seed, over, expected] of SNAPSHOTS) {
    it(`seed=${seed} ${JSON.stringify(over)} → ${expected}`, async () => {
      const model = await runPipeline(seed, withParams(over));
      expect(model.summary.hash).toBe(expected);
    });
  }
});
