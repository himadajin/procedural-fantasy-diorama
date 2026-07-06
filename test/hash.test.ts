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
  // commit 11 で全組を更新済み。意図した変更は次の2点:
  // (1) 段10「舗装」の追加: zoneMask へ舗装チャネル("paved")が加わり
  //     weights の長さと値が変わる(water:0 を含む全組に影響)
  // (2) 水路経路の陸上化(contracts/worldmodel.md Water 節 2026-07-07 追記):
  //     川筋の中に沈んでいた水路が岸へ押し出され、canals・bridges・
  //     wards(overwater 判定)・plazas(水域回避)が連鎖して変わる
  const SNAPSHOTS: [string, Partial<Params>, string][] = [
    ["everdusk-101", {}, "a109c58b"],
    ["everdusk-101", { water: 0 }, "78ff489c"],
    ["everdusk-101", { water: 95 }, "5927c4ad"],
    ["everdusk-101", { worldScale: 0 }, "f4a22478"],
    ["everdusk-101", { worldScale: 100 }, "285fb032"],
    ["seed-a", {}, "985fd8dd"],
    ["seed-b", {}, "62e76f63"],
    ["seed-b", { water: 70 }, "4ce5cde1"],
  ];

  for (const [seed, over, expected] of SNAPSHOTS) {
    it(`seed=${seed} ${JSON.stringify(over)} → ${expected}`, async () => {
      const model = await runPipeline(seed, withParams(over));
      expect(model.summary.hash).toBe(expected);
    });
  }
});
