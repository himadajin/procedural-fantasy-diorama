import { describe, expect, it } from "vitest";
import { DEFAULT_PARAMS, type Params, type WorldModel } from "../src/model/worldmodel";
import {
  createWaterField,
  distToPolyline,
  pointInPolygon,
} from "../src/model/waterfield";
import { runPipeline } from "../src/pipeline/run";

const SEEDS = ["everdusk-101", "seed-a", "seed-b"];

/** テストは読み取りのみのため、同一入力の生成結果をキャッシュして共有する */
const cache = new Map<string, Promise<WorldModel>>();

async function build(seed: string, over: Partial<Params> = {}): Promise<WorldModel> {
  const key = `${seed}|${JSON.stringify(over)}`;
  let promise = cache.get(key);
  if (!promise) {
    promise = runPipeline(seed, { ...DEFAULT_PARAMS, ...over });
    cache.set(key, promise);
  }
  return promise;
}

/** 決定性テスト用: キャッシュを使わず独立に生成する */
async function buildFresh(seed: string, over: Partial<Params> = {}): Promise<WorldModel> {
  return runPipeline(seed, { ...DEFAULT_PARAMS, ...over });
}

/** 湖・池・水路を合成した水域 sdf(正=陸側) */
function combinedWaterSdf(model: WorldModel): (x: number, z: number) => number {
  const field = createWaterField(model.ground.boundary, [
    ...model.water.lakes,
    ...model.water.ponds,
  ]);
  return (x, z) => {
    let d = field.waterSdf(x, z);
    for (const canal of model.water.canals) {
      d = Math.min(d, distToPolyline(x, z, canal.points) - canal.width / 2);
    }
    return d;
  };
}

describe("plazas: 決定性", () => {
  it("同一 seed + params で plazas / centerPlan が完全一致する", async () => {
    for (const seed of SEEDS) {
      const a = await buildFresh(seed);
      const b = await buildFresh(seed);
      expect(a.plazas).toEqual(b.plazas);
      expect(a.centerPlan).toEqual(b.centerPlan);
    }
  });
});

describe("plazas: 空地ポリゴンの確定(contracts/network-plaza.md Plaza 節)", () => {
  it("中心前広場が存在し、種別が契約の範囲(courtyard は段12 の中庭のみ)", async () => {
    for (const seed of SEEDS) {
      for (const over of [{}, { water: 70 }, { monumentality: 95 }]) {
        const model = await build(seed, over);
        const kinds = model.plazas.map((p) => p.kind);
        expect(kinds).toContain("center");
        expect(kinds.filter((k) => k === "center").length).toBe(1);
        for (const p of model.plazas) {
          expect(["center", "gate", "bridgehead", "crossing", "courtyard"]).toContain(
            p.kind,
          );
          expect(p.radius).toBeGreaterThan(0);
          if (p.kind === "courtyard") {
            // 中庭は段12 の中心建築展開が追加する矩形(契約の例外)
            expect(p.id).toBe("plaza/courtyard");
            expect(p.polygon.length).toBe(4);
          } else {
            expect(p.polygon.length).toBeGreaterThanOrEqual(8);
          }
          expect(p.id).toMatch(/^plaza\//);
        }
        expect(new Set(model.plazas.map((p) => p.id)).size).toBe(
          model.plazas.length,
        );
      }
    }
  });

  it("広場どうしが重ならない(円距離 ≥ 半径和)", async () => {
    for (const seed of SEEDS) {
      for (const over of [{}, { water: 95 }, { arcana: 95 }]) {
        const model = await build(seed, over);
        for (let i = 0; i < model.plazas.length; i++) {
          const a = model.plazas[i];
          // 中庭(courtyard)は中心建築の中庭壁の内側にあり、
          // 段9 の円距離規約の対象外(contracts「中心建築」)
          if (!a || a.kind === "courtyard") continue;
          for (let j = i + 1; j < model.plazas.length; j++) {
            const b = model.plazas[j];
            if (!b || b.kind === "courtyard") continue;
            const d = Math.hypot(
              a.position.x - b.position.x,
              a.position.z - b.position.z,
            );
            expect(
              d,
              `seed=${seed} ${a.id} と ${b.id} が重なる`,
            ).toBeGreaterThanOrEqual(a.radius + b.radius);
          }
        }
      }
    }
  });

  it("広場が水域(水路を含む)・centerPlan.footprint と重ならない", async () => {
    for (const seed of SEEDS) {
      for (const over of [{}, { water: 70 }, { water: 95, settlement: 95 }]) {
        const model = await build(seed, over);
        const wsdf = combinedWaterSdf(model);
        const foot = model.centerPlan.footprint;
        for (const plaza of model.plazas) {
          // 中庭(courtyard)は centerPlan.footprint の内側に置かれる設計
          // (contracts「中心建築」)のため footprint 検査の対象外
          if (plaza.kind === "courtyard") continue;
          for (const v of plaza.polygon) {
            expect(
              wsdf(v.x, v.z),
              `seed=${seed} ${plaza.id} の頂点が水中`,
            ).toBeGreaterThanOrEqual(0);
            expect(
              pointInPolygon(v.x, v.z, foot),
              `seed=${seed} ${plaza.id} の頂点が footprint 内`,
            ).toBe(false);
          }
        }
      }
    }
  });

  it("結界門前広場は wardLevel ≥ 2 の門に対応して現れる", async () => {
    for (const seed of SEEDS) {
      const none = await build(seed, { arcana: 0 });
      expect(none.plazas.some((p) => p.kind === "gate")).toBe(false);
      const high = await build(seed, { arcana: 95 });
      if (high.wards.gates.length > 0) {
        expect(high.plazas.some((p) => p.kind === "gate")).toBe(true);
      }
    }
  });
});

describe("plazas: centerPlan 後半(facing / heightHint)", () => {
  it("facing / heightHint が確定している(0 のままでない)", async () => {
    for (const seed of SEEDS) {
      for (const over of [{}, { water: 0 }, { monumentality: 0 }]) {
        const model = await build(seed, over);
        expect(Number.isFinite(model.centerPlan.facing)).toBe(true);
        expect(model.centerPlan.facing).not.toBe(0);
        expect(model.centerPlan.heightHint).toBeGreaterThan(0);
      }
    }
  });

  it("facing は中心前広場の方位と一致する", async () => {
    for (const seed of SEEDS) {
      const model = await build(seed);
      const centerPlaza = model.plazas.find((p) => p.kind === "center");
      expect(centerPlaza).toBeDefined();
      if (!centerPlaza) continue;
      const c = model.centerPlan.position;
      const expected = Math.atan2(
        centerPlaza.position.z - c.z,
        centerPlaza.position.x - c.x,
      );
      expect(model.centerPlan.facing).toBeCloseTo(expected, 9);
    }
  });

  it("heightHint は centerHeight × 支配軸係数(Monumentality に単調)", async () => {
    for (const seed of SEEDS) {
      const low = await build(seed, { monumentality: 20 });
      const high = await build(seed, { monumentality: 90 });
      expect(high.centerPlan.heightHint).toBeGreaterThan(
        low.centerPlan.heightHint,
      );
      // 係数の範囲(0.7〜1.15)に収まる
      for (const model of [low, high]) {
        const ratio =
          model.centerPlan.heightHint / model.meta.derived.centerHeight;
        expect(ratio).toBeGreaterThanOrEqual(0.7 - 1e-9);
        expect(ratio).toBeLessThanOrEqual(1.15 + 1e-9);
      }
    }
  });
});
