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
  // commit 19(PHASE 6)で水辺拡張ぶんを更新。意図した変更:
  // 段12「建物」が waterside 建物へ水辺拡張の部品(杭繋ぎ梁・杭支持デッキ・
  // 張り出し部屋・水路裏口。params.waterfront = 1)を追記する
  // (contracts/worldmodel.md「水辺建築の拡張」)。乱数は独立サブストリーム
  // "building/<id>/waterfront" のみ消費する追記のため、waterside 建物が
  // 無い組・水辺拡張が一つも採択されない組のハッシュは commit 16 から不変
  // (下表で値が変わらない 5 組)。
  // 新旧対応(commit 16 → commit 19):
  //   everdusk-101 {}              0ad4197f → 5d0f8d8a
  //   everdusk-101 {water:0}       c34855b1 → c34855b1(不変)
  //   everdusk-101 {water:95}      f0ddcce4 → f0ddcce4(不変。岸沿い道の
  //     向こうに水がある家並みで、張り出し・水路裏口の対象が無い)
  //   everdusk-101 {worldScale:0}  afcc7682 → afcc7682(不変)
  //   everdusk-101 {worldScale:100} 0a6e0424 → 7973e55b
  //   seed-a {}                    63531fdd → 63531fdd(不変)
  //   seed-b {}                    cd969f29 → 544a44f9
  //   seed-b {water:70}            b2e8a70d → 333123e8
  const SNAPSHOTS: [string, Partial<Params>, string][] = [
    ["everdusk-101", {}, "5d0f8d8a"],
    ["everdusk-101", { water: 0 }, "c34855b1"],
    ["everdusk-101", { water: 95 }, "f0ddcce4"],
    ["everdusk-101", { worldScale: 0 }, "afcc7682"],
    ["everdusk-101", { worldScale: 100 }, "7973e55b"],
    ["seed-a", {}, "63531fdd"],
    ["seed-b", {}, "544a44f9"],
    ["seed-b", { water: 70 }, "333123e8"],
  ];

  for (const [seed, over, expected] of SNAPSHOTS) {
    it(`seed=${seed} ${JSON.stringify(over)} → ${expected}`, async () => {
      const model = await runPipeline(seed, withParams(over));
      expect(model.summary.hash).toBe(expected);
    });
  }
});
