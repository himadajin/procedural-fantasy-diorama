import { describe, expect, it } from "vitest";
import {
  DEFAULT_PARAMS,
  createEmptyWorldModel,
  type Params,
  type WorldModel,
} from "../src/model/worldmodel";
import { ZONE_KINDS } from "../src/model/zonemask";
import {
  createWaterField,
  estimateWaterArea,
  pointInPolygon,
  polygonArea,
} from "../src/model/waterfield";
import { runDerive } from "../src/pipeline/derive";
import { runGround } from "../src/pipeline/ground";
import { runWater } from "../src/pipeline/water";

const SEEDS = ["seed-a", "seed-b", "everdusk-101"];
/** 川と湖が共存する代表 seed(water=70。事前に確認済み) */
const RIVER_AND_LAKE_SEEDS = ["seed-b", "seed-c"];

function build(seed: string, over: Partial<Params> = {}): WorldModel {
  const model = createEmptyWorldModel(seed, { ...DEFAULT_PARAMS, ...over });
  runDerive(model);
  runGround(model);
  runWater(model);
  return model;
}

describe("water: 決定性", () => {
  it("同一 seed + params で rivers / lakes / shoreline / zoneMask が完全一致する", () => {
    for (const seed of SEEDS) {
      const a = build(seed, { water: 70 });
      const b = build(seed, { water: 70 });
      expect(a.water).toEqual(b.water);
      expect(a.ground.zoneMask).toEqual(b.ground.zoneMask);
      expect(a.ground.edgeStyle).toEqual(b.ground.edgeStyle);
    }
  });

  it("seed が異なれば水系が変わる", () => {
    expect(build("seed-a", { water: 70 }).water.rivers).not.toEqual(
      build("seed-b", { water: 70 }).water.rivers,
    );
  });
});

describe("water: Water 0(乾いた土地)", () => {
  it("水域ゼロ・edgeStyle は fog 固定・zoneMask の砂洲/湿地は 0 のまま", () => {
    for (const seed of SEEDS) {
      const model = build(seed, { water: 0 });
      expect(model.water.rivers).toEqual([]);
      expect(model.water.lakes).toEqual([]);
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

describe("water: Water 70(川と湖の共存)", () => {
  it("代表 seed で川と湖が共存し、川のスプラインが湖を貫通する(流入・流出)", () => {
    for (const seed of RIVER_AND_LAKE_SEEDS) {
      const model = build(seed, { water: 70 });
      expect(model.water.rivers.length).toBeGreaterThanOrEqual(1);
      expect(model.water.lakes.length).toBeGreaterThanOrEqual(1);
      const lake = model.water.lakes[0];
      if (!lake) throw new Error("lake missing");
      const inLake = model.water.rivers.some((river) =>
        river.points.some((p) => pointInPolygon(p.x, p.z, lake)),
      );
      expect(inLake, `seed=${seed} 川が湖を通らない`).toBe(true);
    }
  });

  it("湿地・砂洲が岸辺周辺の zoneMask に書き込まれ、重みは非負・合計1を保つ", () => {
    for (const seed of RIVER_AND_LAKE_SEEDS) {
      const mask = build(seed, { water: 70 }).ground.zoneMask;
      const cells = mask.resolution * mask.resolution;
      let sandTotal = 0;
      let marshTotal = 0;
      for (let c = 0; c < cells; c++) {
        let sum = 0;
        for (let k = 0; k < ZONE_KINDS.length; k++) {
          const w = mask.weights[c * ZONE_KINDS.length + k] ?? -1;
          expect(w).toBeGreaterThanOrEqual(0);
          sum += w;
        }
        expect(sum).toBeCloseTo(1, 6);
        sandTotal += mask.weights[c * ZONE_KINDS.length + 2] ?? 0;
        marshTotal += mask.weights[c * ZONE_KINDS.length + 3] ?? 0;
      }
      expect(sandTotal).toBeGreaterThan(0);
      expect(marshTotal).toBeGreaterThan(0);
    }
  });
});

describe("water: 面積上限(waterAreaCap)", () => {
  it("Water 95 で水域合計面積が ground 面積の 35% 以下", () => {
    for (const seed of SEEDS) {
      for (const worldScale of [0, 50]) {
        const model = build(seed, { water: 95, worldScale });
        const field = createWaterField(
          model.ground.boundary,
          model.water.rivers,
          model.water.lakes,
        );
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

  it("導出値が上限を超える入力でも湖面積・川幅の縮小でクリップされる", () => {
    for (const seed of SEEDS) {
      const model = createEmptyWorldModel(seed, { ...DEFAULT_PARAMS, water: 95 });
      runDerive(model);
      runGround(model);
      // 意図的に過大な水域を要求する(段契約上 runWater は meta と ground のみ読む)
      model.meta.derived.lakeArea = 0.6;
      model.meta.derived.lakeChance = 1;
      model.meta.derived.riverCount = 2;
      model.meta.derived.riverWidth = 24;
      runWater(model);
      const field = createWaterField(
        model.ground.boundary,
        model.water.rivers,
        model.water.lakes,
      );
      const area = estimateWaterArea(field, model.ground.size);
      const groundArea = polygonArea(model.ground.boundary);
      expect(model.water.lakes.length).toBe(1);
      // クリップの見積もり自体がグリッド標本化のため、僅かな超過は許容する
      expect(area).toBeLessThanOrEqual(
        groundArea * model.meta.derived.waterAreaCap * 1.02,
      );
      const width = model.water.rivers[0]?.width ?? 0;
      expect(width).toBeLessThan(24);
    }
  });
});

describe("water: 河川スプライン", () => {
  it("川は境界の外から境界を横断して外へ抜け、点列が途切れない", () => {
    for (const seed of SEEDS) {
      for (const water of [40, 70, 95]) {
        const model = build(seed, { water });
        const field = createWaterField(model.ground.boundary, [], []);
        for (const river of model.water.rivers) {
          const head = river.points[0];
          const tail = river.points[river.points.length - 1];
          if (!head || !tail) throw new Error("river endpoints missing");
          // 両端は境界の外(河口の切れ目を霧・外縁水面の中へ隠す)
          expect(field.boundarySdf(head.x, head.z)).toBeLessThan(0);
          expect(field.boundarySdf(tail.x, tail.z)).toBeLessThan(0);
          // 中間は境界の内側を通る(箱庭を横切る)
          const interior = river.points.filter(
            (p) => field.boundarySdf(p.x, p.z) > model.ground.size * 0.05,
          );
          expect(interior.length).toBeGreaterThan(0);
          // 隣接点間隔が川幅の 1.5 倍以下(contracts/ground-water.md)
          for (let i = 0; i + 1 < river.points.length; i++) {
            const a = river.points[i];
            const b = river.points[i + 1];
            if (!a || !b) continue;
            expect(Math.hypot(b.x - a.x, b.z - a.z)).toBeLessThanOrEqual(
              river.width * 1.5,
            );
          }
        }
      }
    }
  });
});

describe("water: 岸線(shoreline)", () => {
  it("水域があれば岸線ループがあり、点は水際・法線は陸向きの単位ベクトル", () => {
    for (const seed of RIVER_AND_LAKE_SEEDS) {
      const model = build(seed, { water: 70 });
      const { cellSize, loops } = model.water.shoreline;
      expect(loops.length).toBeGreaterThan(0);
      expect(cellSize).toBeGreaterThan(0);
      const field = createWaterField(
        model.ground.boundary,
        model.water.rivers,
        model.water.lakes,
      );
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

describe("water: サマリーと後段予約", () => {
  it("waterOverview に川・湖の数が入り、canals / bridges は空のまま(PHASE 3 担当)", () => {
    const model = build("seed-b", { water: 70 });
    expect(model.summary.waterOverview.rivers).toBe(model.water.rivers.length);
    expect(model.summary.waterOverview.lakes).toBe(model.water.lakes.length);
    expect(model.water.canals).toEqual([]);
    expect(model.water.bridges).toEqual([]);
  });
});
