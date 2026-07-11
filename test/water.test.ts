import { describe, expect, it } from "vitest";
import {
  DEFAULT_PARAMS,
  createEmptyWorldModel,
  type Params,
  type Polygon,
  type WorldModel,
} from "../src/model/worldmodel";
import { ZONE_KINDS } from "../src/model/zonemask";
import {
  createWaterField,
  estimateWaterArea,
  polygonArea,
  waterBodies,
} from "../src/model/waterfield";
import { runDerive } from "../src/pipeline/derive";
import { runGround } from "../src/pipeline/ground";
import { runWater } from "../src/pipeline/water";

const SEEDS = ["seed-a", "seed-b", "everdusk-101"];
/** 湖・池が確実に生じる代表 seed(water=70。事前に確認済み) */
const WATER_SEEDS = ["seed-b", "seed-c"];

function build(seed: string, over: Partial<Params> = {}): WorldModel {
  const model = createEmptyWorldModel(seed, { ...DEFAULT_PARAMS, ...over });
  runDerive(model);
  runGround(model);
  runWater(model);
  return model;
}

describe("water: 決定性", () => {
  it("同一 seed + params で lakes / ponds / shoreline / zoneMask が完全一致する", () => {
    for (const seed of SEEDS) {
      const a = build(seed, { water: 70 });
      const b = build(seed, { water: 70 });
      expect(a.water).toEqual(b.water);
      expect(a.ground.zoneMask).toEqual(b.ground.zoneMask);
      expect(a.ground.edgeStyle).toEqual(b.ground.edgeStyle);
    }
  });

  it("seed が異なれば水系が変わる", () => {
    expect(build("seed-a", { water: 70 }).water.lakes).not.toEqual(
      build("seed-b", { water: 70 }).water.lakes,
    );
  });
});

describe("water: Water 0(乾いた土地)", () => {
  it("水域ゼロ・edgeStyle は fog 固定・zoneMask の砂洲/湿地は 0 のまま", () => {
    for (const seed of SEEDS) {
      const model = build(seed, { water: 0 });
      expect(model.water.lakes).toEqual([]);
      expect(model.water.ponds).toEqual([]);
      expect(model.water.shoreline.loops).toEqual([]);
      expect(model.ground.edgeStyle).toBe("fog");
      const mask = model.ground.zoneMask;
      const cells = mask.resolution * mask.resolution;
      for (let c = 0; c < cells; c++) {
        expect(mask.weights[c * ZONE_KINDS.length + 2]).toBe(0); // sandbar
        expect(mask.weights[c * ZONE_KINDS.length + 3]).toBe(0); // marsh
      }
    }
  });

  it("Water 15 未満では edgeStyle が常に fog", () => {
    for (const seed of SEEDS) {
      for (const water of [0, 5, 14]) {
        expect(build(seed, { water }).ground.edgeStyle).toBe("fog");
      }
    }
  });
});

describe("water: 湖・池の本数・形状の不変条件", () => {
  it("湖は 0〜1 個・池は 0〜4 個", () => {
    for (const seed of SEEDS) {
      for (const water of [0, 25, 50, 75, 100]) {
        const model = build(seed, { water });
        expect(model.water.lakes.length).toBeGreaterThanOrEqual(0);
        expect(model.water.lakes.length).toBeLessThanOrEqual(1);
        expect(model.water.ponds.length).toBeGreaterThanOrEqual(0);
        expect(model.water.ponds.length).toBeLessThanOrEqual(4);
      }
    }
  });

  it("全ポリゴンの頂点が境界内(boundarySdf >= 0)に収まる", () => {
    for (const seed of WATER_SEEDS) {
      const model = build(seed, { water: 70 });
      const field = createWaterField(model.ground.boundary, []);
      const bodies: Polygon[] = [...model.water.lakes, ...model.water.ponds];
      expect(bodies.length).toBeGreaterThan(0);
      for (const body of bodies) {
        for (const v of body) {
          expect(field.boundarySdf(v.x, v.z)).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });

  it("池どうし・池と湖の中心間距離は最小間隔(実効半径和 × 1.6 目安)を概ね満たす", () => {
    // 実効半径は頂点-重心の平均距離で近似する(星形ブロブの調和波込み)。
    // 目安は contracts/ground-water.md「(b) 既存水域との最小間隔」。
    // 面積クリップ後の縮小は湖・池を一括で同率スケールするため、この近似のまま
    // 相対比較が成り立つ
    for (const seed of WATER_SEEDS) {
      const model = build(seed, { water: 100 });
      const bodies: Polygon[] = [...model.water.lakes, ...model.water.ponds];
      const shapes = bodies.map((poly) => {
        let x = 0;
        let z = 0;
        for (const p of poly) {
          x += p.x;
          z += p.z;
        }
        const center = { x: x / poly.length, z: z / poly.length };
        let radiusSum = 0;
        for (const p of poly) radiusSum += Math.hypot(p.x - center.x, p.z - center.z);
        return { center, radius: radiusSum / poly.length };
      });
      for (let i = 0; i < shapes.length; i++) {
        for (let j = i + 1; j < shapes.length; j++) {
          const a = shapes[i];
          const b = shapes[j];
          if (!a || !b) continue;
          const dist = Math.hypot(a.center.x - b.center.x, a.center.z - b.center.z);
          // 許容誤差込み(実効半径は近似のため 20% のマージンを取る)
          expect(dist).toBeGreaterThanOrEqual((a.radius + b.radius) * 1.6 * 0.8);
        }
      }
    }
  });
});

describe("water: 面積上限(waterAreaCap)", () => {
  it("Water 95 で水域合計面積が ground 面積の 35% 以下", () => {
    for (const seed of SEEDS) {
      for (const worldScale of [0, 50]) {
        const model = build(seed, { water: 95, worldScale });
        const field = createWaterField(model.ground.boundary, waterBodies(model.water));
        const area = estimateWaterArea(field, model.ground.size);
        const groundArea = polygonArea(model.ground.boundary);
        expect(area).toBeLessThanOrEqual(
          groundArea * model.meta.derived.waterAreaCap,
        );
        // 水域が広がっても陸地(建築可能域)は過半を保つ
        expect(area).toBeLessThan(groundArea * 0.5);
      }
    }
  });

  it("導出値が上限を超える入力でも湖・池の半径縮小でクリップされる", () => {
    for (const seed of SEEDS) {
      const model = createEmptyWorldModel(seed, { ...DEFAULT_PARAMS, water: 95 });
      runDerive(model);
      runGround(model);
      // 意図的に過大な水域を要求する(段契約上 runWater は meta と ground のみ読む)。
      // 単体では境界内に配置できる程度の半径(0.2)にしつつ、湖+池4個の合計で
      // waterAreaCap(0.35)を大きく超えさせ、面積クリップの縮小を誘発する
      model.meta.derived.lakeArea = 0.2;
      model.meta.derived.lakeChance = 1;
      model.meta.derived.pondArea = 0.2;
      model.meta.derived.pondCount = 4;
      runWater(model);
      const field = createWaterField(model.ground.boundary, waterBodies(model.water));
      const area = estimateWaterArea(field, model.ground.size);
      const groundArea = polygonArea(model.ground.boundary);
      expect(model.water.lakes.length).toBe(1);
      // クリップの見積もり自体がグリッド標本化のため、僅かな超過は許容する
      expect(area).toBeLessThanOrEqual(
        groundArea * model.meta.derived.waterAreaCap * 1.02,
      );
    }
  });
});

describe("water: 岸線(shoreline)", () => {
  it("水域があれば岸線ループがあり、点は水際・法線は陸向きの単位ベクトル", () => {
    for (const seed of WATER_SEEDS) {
      const model = build(seed, { water: 70 });
      const { cellSize, loops } = model.water.shoreline;
      expect(loops.length).toBeGreaterThan(0);
      expect(cellSize).toBeGreaterThan(0);
      const field = createWaterField(model.ground.boundary, waterBodies(model.water));
      for (const loop of loops) {
        expect(loop.points.length).toBeGreaterThanOrEqual(2);
        expect(loop.normals.length).toBe(loop.points.length);
        for (let i = 0; i < loop.points.length; i++) {
          const p = loop.points[i];
          const nrm = loop.normals[i];
          if (!p || !nrm) throw new Error("shoreline point missing");
          // 点は陸地関数の零等値線上(グリッド線形補間の範囲内)
          expect(Math.abs(field.landSdf(p.x, p.z))).toBeLessThan(cellSize);
          expect(Math.hypot(nrm.x, nrm.z)).toBeCloseTo(1, 5);
          // 法線は水域から陸側を向く: 法線方向に進むと waterSdf が増える
          const step = cellSize;
          expect(
            field.waterSdf(p.x + nrm.x * step, p.z + nrm.z * step),
          ).toBeGreaterThan(field.waterSdf(p.x - nrm.x * step, p.z - nrm.z * step));
        }
      }
    }
  });

  it("岸線の id は抽出順で安定し、一意である", () => {
    const model = build("seed-b", { water: 70 });
    const ids = model.water.shoreline.loops.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
    ids.forEach((id, i) => expect(id).toBe(`shore/${i}`));
  });
});

describe("water: Water 増で水域面積が概ね単調増", () => {
  it("複数 seed の平均水域面積は water の増加とともに単調に増える(緩い検証)", () => {
    const waters = [0, 30, 60, 90];
    const avgAreas = waters.map((water) => {
      let total = 0;
      for (const seed of SEEDS) {
        const model = build(seed, { water });
        const field = createWaterField(model.ground.boundary, waterBodies(model.water));
        total += estimateWaterArea(field, model.ground.size);
      }
      return total / SEEDS.length;
    });
    for (let i = 0; i + 1 < avgAreas.length; i++) {
      expect(avgAreas[i + 1]).toBeGreaterThanOrEqual(avgAreas[i] ?? 0);
    }
  });
});

describe("water: サマリーと後段予約", () => {
  it("waterOverview に湖・池の数が入り、canals / bridges は空のまま(PHASE 3 担当)", () => {
    const model = build("seed-b", { water: 70 });
    expect(model.summary.waterOverview.lakes).toBe(model.water.lakes.length);
    expect(model.summary.waterOverview.ponds).toBe(model.water.ponds.length);
    expect(model.water.canals).toEqual([]);
    expect(model.water.bridges).toEqual([]);
  });
});
