import { describe, expect, it } from "vitest";
import {
  DEFAULT_PARAMS,
  createEmptyWorldModel,
  type Params,
  type Vec2,
  type WorldModel,
} from "../src/model/worldmodel";
import {
  createBoundaryRadius,
  createWaterField,
  pointInPolygon,
  polygonArea,
} from "../src/model/waterfield";
import { runDerive } from "../src/pipeline/derive";
import { runGround } from "../src/pipeline/ground";
import { runWater } from "../src/pipeline/water";
import { runSiting } from "../src/pipeline/siting";

const SEEDS = ["seed-a", "seed-b", "everdusk-101"];
/** 川を持つ代表 seed(water=70。事前に確認済み) */
const RIVER_SEEDS = ["seed-a", "seed-b", "seed-c"];

function build(seed: string, over: Partial<Params> = {}): WorldModel {
  const model = createEmptyWorldModel(seed, { ...DEFAULT_PARAMS, ...over });
  runDerive(model);
  runGround(model);
  runWater(model);
  runSiting(model);
  return model;
}

describe("siting: 決定性", () => {
  it("同一 seed + params で centerPlan と entryPoints が完全一致する", () => {
    for (const seed of SEEDS) {
      const a = build(seed, { water: 70 });
      const b = build(seed, { water: 70 });
      expect(a.centerPlan).toEqual(b.centerPlan);
      expect(a.network.entryPoints).toEqual(b.network.entryPoints);
    }
  });

  it("seed が異なれば立地が変わる", () => {
    expect(build("seed-a").network.entryPoints).not.toEqual(
      build("seed-b").network.entryPoints,
    );
  });
});

describe("siting: 進入点", () => {
  it("derived.entryPointCount 点(2〜4)が外縁上の陸に置かれ、id は生成順で安定", () => {
    for (const seed of SEEDS) {
      for (const worldScale of [0, 50, 100]) {
        const model = build(seed, { worldScale, water: 70 });
        const entries = model.network.entryPoints;
        expect(entries.length).toBe(model.meta.derived.entryPointCount);
        expect(entries.length).toBeGreaterThanOrEqual(2);
        expect(entries.length).toBeLessThanOrEqual(4);
        const radius = createBoundaryRadius(model.ground.boundary);
        const field = createWaterField(
          model.ground.boundary,
          model.water.rivers,
          model.water.lakes,
        );
        entries.forEach((e, i) => {
          expect(e.id).toBe(`entry/${i}`);
          // 外縁上(星形半径関数との差がほぼ 0)
          const theta = Math.atan2(e.position.z, e.position.x);
          const r = Math.hypot(e.position.x, e.position.z);
          expect(Math.abs(r - radius(theta))).toBeLessThan(1e-6);
          // 水域(河口)を避ける
          expect(
            field.waterSdf(e.position.x, e.position.z),
          ).toBeGreaterThanOrEqual(0);
        });
      }
    }
  });

  it("主河川があるとき進入点は両岸に分かれる(橋の必然性)", () => {
    for (const seed of RIVER_SEEDS) {
      const model = build(seed, { water: 70 });
      const river = model.water.rivers[0];
      if (!river) throw new Error(`seed=${seed} に川がない`);
      const head = river.points[0];
      const tail = river.points[river.points.length - 1];
      if (!head || !tail) throw new Error("river endpoints missing");
      const side = (p: Vec2): number =>
        Math.sign(
          (tail.x - head.x) * (p.z - head.z) - (tail.z - head.z) * (p.x - head.x),
        );
      const sides = new Set(
        model.network.entryPoints.map((e) => side(e.position)).filter((s) => s !== 0),
      );
      expect(sides.size, `seed=${seed} 進入点が同じ岸に偏っている`).toBe(2);
    }
  });
});

describe("siting: 主中心と占有範囲", () => {
  it("主中心は水中になく、footprint の全頂点が境界内に収まる", () => {
    for (const seed of SEEDS) {
      for (const water of [0, 50, 95]) {
        const model = build(seed, { water });
        const field = createWaterField(
          model.ground.boundary,
          model.water.rivers,
          model.water.lakes,
        );
        const c = model.centerPlan.position;
        expect(field.waterSdf(c.x, c.z), `seed=${seed} water=${water}`).toBeGreaterThan(0);
        expect(model.centerPlan.footprint.length).toBe(4);
        for (const v of model.centerPlan.footprint) {
          expect(
            pointInPolygon(v.x, v.z, model.ground.boundary),
            `seed=${seed} water=${water} footprint 頂点が境界外`,
          ).toBe(true);
        }
      }
    }
  });

  it("footprint は position 中心・一辺 centerFootprint の正方形(時計回り)", () => {
    for (const monumentality of [0, 50, 100]) {
      const model = build("seed-a", { monumentality });
      const side = model.meta.derived.centerFootprint;
      const fp = model.centerPlan.footprint;
      expect(polygonArea(fp)).toBeCloseTo(side * side, 6);
      // 重心 = position
      const cx = fp.reduce((s, p) => s + p.x, 0) / fp.length;
      const cz = fp.reduce((s, p) => s + p.z, 0) / fp.length;
      expect(cx).toBeCloseTo(model.centerPlan.position.x, 9);
      expect(cz).toBeCloseTo(model.centerPlan.position.z, 9);
      // 時計回り(shoelace 符号負。contracts/worldmodel.md 基本型)
      let shoelace = 0;
      for (let i = 0; i < fp.length; i++) {
        const p = fp[i];
        const q = fp[(i + 1) % fp.length];
        if (!p || !q) continue;
        shoelace += p.x * q.z - q.x * p.z;
      }
      expect(shoelace).toBeLessThan(0);
    }
  });

  it("Water の微小変化で主中心が跳ばない(√Water の飽和)", () => {
    for (const seed of SEEDS) {
      const a = build(seed, { water: 60 }).centerPlan.position;
      const b = build(seed, { water: 61 }).centerPlan.position;
      const size = build(seed, { water: 60 }).ground.size;
      expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeLessThan(size * 0.15);
    }
  });
});

describe("siting: 4軸スコア(implementation-spec 1.7節)", () => {
  const maxAxis = (model: WorldModel): string => {
    const axes = model.centerPlan.axes;
    return (Object.entries(axes) as [string, number][]).reduce((a, b) =>
      b[1] > a[1] ? b : a,
    )[0];
  };

  it("Monumentality 高 × Arcana 高 → 魔導軸が最大", () => {
    for (const seed of SEEDS) {
      const model = build(seed, { monumentality: 90, arcana: 90 });
      expect(maxAxis(model), `seed=${seed}`).toBe("arcane");
    }
  });

  it("Monumentality 高 × Prosperity 高(Arcana 低)→ 権威軸が最大", () => {
    for (const seed of SEEDS) {
      const model = build(seed, { monumentality: 90, prosperity: 95, arcana: 5 });
      expect(maxAxis(model), `seed=${seed}`).toBe("authority");
    }
  });

  it("Monumentality 低 × Settlement 低 → 素朴軸が最大", () => {
    for (const seed of SEEDS) {
      const model = build(seed, { monumentality: 5, settlement: 10 });
      expect(maxAxis(model), `seed=${seed}`).toBe("rustic");
    }
  });

  it("Monumentality 高 × Water 高(他が低)→ 水辺軸が最大", () => {
    for (const seed of SEEDS) {
      const model = build(seed, {
        monumentality: 90,
        water: 95,
        arcana: 5,
        prosperity: 5,
        settlement: 90,
      });
      expect(maxAxis(model), `seed=${seed}`).toBe("waterside");
    }
  });

  it("全軸が非負で、facing / heightHint は 0 のまま(段9の担当)", () => {
    for (const seed of SEEDS) {
      const model = build(seed);
      const axes = model.centerPlan.axes;
      for (const v of Object.values(axes)) expect(v).toBeGreaterThanOrEqual(0);
      expect(model.centerPlan.facing).toBe(0);
      expect(model.centerPlan.heightHint).toBe(0);
    }
  });
});
