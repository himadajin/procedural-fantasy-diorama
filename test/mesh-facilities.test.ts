/**
 * mesh/facilities.ts の回帰テスト。
 * 施設が生成する全部品型(contracts/facilities.md「施設部品の語彙」)が
 * mesh/facilities.ts で処理され、未知の部品型の読み飛ばし警告
 * (pipeline.md「モジュール境界規則」の防御 warn)が 0 件であることを
 * 検証する。
 */
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_PARAMS, type Params, type WorldModel } from "../src/model/worldmodel";
import { DEFAULT_SEED } from "../src/defaults";
import { runFacilities } from "../src/pipeline/facilities";
import { buildGalleryWorld } from "../src/pipeline/gallery";
import { buildFacilities } from "../src/mesh/facilities";
import { buildUpTo } from "./helpers";

function build(seed: string, over: Partial<Params> = {}): WorldModel {
  return buildUpTo(runFacilities, seed, over);
}

/** facility の全部品型(順序非依存の集合として比較するため Set で返す) */
function facilityPartTypes(model: WorldModel): Set<string> {
  return new Set(model.facilities.flatMap((f) => f.parts.map((p) => p.type)));
}

/** buildFacilities を呼び、未知の部品型の console.warn 回数を返す */
function unknownPartWarnings(model: WorldModel): number {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    buildFacilities(model);
    return warn.mock.calls.length;
  } finally {
    warn.mockRestore();
  }
}

describe("mesh/facilities: 部品型の網羅(未知の部品型の読み飛ばし 0 件)", () => {
  it("既定 seed・既定 params(door / window を含む)で読み飛ばしが 0 件", () => {
    const model = build(DEFAULT_SEED);
    const types = facilityPartTypes(model);
    // door / window が実際に生成されていることを確認したうえで検証する
    // (生成されない seed では本テストが誤って素通りしてしまうため)
    expect(types.has("door")).toBe(true);
    expect(types.has("window")).toBe(true);
    expect(unknownPartWarnings(model)).toBe(0);
  });

  it("ギャラリー facility/windmill・facility/watermill でも読み飛ばしが 0 件", () => {
    for (const targetId of ["facility/windmill", "facility/watermill"] as const) {
      const model = buildGalleryWorld(targetId, DEFAULT_SEED, DEFAULT_PARAMS);
      const types = facilityPartTypes(model);
      expect(types.has("door")).toBe(true);
      expect(types.has("window")).toBe(true);
      expect(unknownPartWarnings(model)).toBe(0);
    }
  });

  it("複数 seed で全施設部品型(door/window 以外を含む)の読み飛ばしが 0 件", () => {
    for (const seed of ["everdusk-102", "seed-a", "seed-b", "seed-c"]) {
      const model = build(seed);
      expect(model.facilities.length).toBeGreaterThan(0);
      expect(unknownPartWarnings(model)).toBe(0);
    }
  });
});
