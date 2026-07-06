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
  // commit 13 で全組を更新済み。意図した変更:
  // 段12「建物」の commit 13 分(materials / parts の展開と
  // zoneMask の建物 footprint 上書き)により、全建物の materials / parts が
  // 新たに埋まり、zoneMask の重みが建物足元で変わる(全組に影響。
  // commit 12 までの骨格データ・乱数消費は不変で、部品の乱数は派生
  // サブストリーム "building/<id>/parts" のみ消費する)
  const SNAPSHOTS: [string, Partial<Params>, string][] = [
    ["everdusk-101", {}, "7c989ebe"],
    ["everdusk-101", { water: 0 }, "0437a8b0"],
    ["everdusk-101", { water: 95 }, "88f24ac2"],
    ["everdusk-101", { worldScale: 0 }, "93c689e9"],
    ["everdusk-101", { worldScale: 100 }, "f9f32fd5"],
    ["seed-a", {}, "5e6a8d20"],
    ["seed-b", {}, "bb3d188f"],
    ["seed-b", { water: 70 }, "75614523"],
  ];

  for (const [seed, over, expected] of SNAPSHOTS) {
    it(`seed=${seed} ${JSON.stringify(over)} → ${expected}`, async () => {
      const model = await runPipeline(seed, withParams(over));
      expect(model.summary.hash).toBe(expected);
    });
  }
});
