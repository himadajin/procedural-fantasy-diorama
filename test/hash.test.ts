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
  // commit 14(PHASE 4b)で全組を更新済み。意図した変更:
  // 段12「建物」への詳細部品の追加(窓・扉・梁・ジェッティ・煙突・
  // 石垣・外階段・屋根小窓)により、全建物の parts が増える(全組に影響)。
  // 骨格データ(footprint / facing / floors / roof / foundation)と
  // materials は commit 13 と完全一致(機械照合済み)で、詳細の乱数は
  // 派生サブストリーム "building/<id>/details" のみ消費する。
  // 新旧対応:
  //   everdusk-101 {}              7c989ebe → bbbf2f49
  //   everdusk-101 {water:0}       0437a8b0 → a9b3eb16
  //   everdusk-101 {water:95}      88f24ac2 → 005dc9ad
  //   everdusk-101 {worldScale:0}  93c689e9 → 13481884
  //   everdusk-101 {worldScale:100} f9f32fd5 → aa3e3971
  //   seed-a {}                    5e6a8d20 → 08142bad
  //   seed-b {}                    bb3d188f → 56e992f2
  //   seed-b {water:70}            75614523 → abb2ac43
  const SNAPSHOTS: [string, Partial<Params>, string][] = [
    ["everdusk-101", {}, "bbbf2f49"],
    ["everdusk-101", { water: 0 }, "a9b3eb16"],
    ["everdusk-101", { water: 95 }, "005dc9ad"],
    ["everdusk-101", { worldScale: 0 }, "13481884"],
    ["everdusk-101", { worldScale: 100 }, "aa3e3971"],
    ["seed-a", {}, "08142bad"],
    ["seed-b", {}, "56e992f2"],
    ["seed-b", { water: 70 }, "abb2ac43"],
  ];

  for (const [seed, over, expected] of SNAPSHOTS) {
    it(`seed=${seed} ${JSON.stringify(over)} → ${expected}`, async () => {
      const model = await runPipeline(seed, withParams(over));
      expect(model.summary.hash).toBe(expected);
    });
  }
});
