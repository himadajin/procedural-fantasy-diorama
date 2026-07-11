import { describe, expect, it } from "vitest";
import {
  DEFAULT_PARAMS,
  createEmptyWorldModel,
  type Params,
  type WorldModel,
} from "../src/model/worldmodel";
import { ZONE_KINDS, sampleZoneMask, type ZoneMask } from "../src/model/zonemask";
import { createWaterField, type WaterField } from "../src/model/waterfield";
import { pathLength, pointAlong } from "../src/model/geometry";
import { runDerive } from "../src/pipeline/derive";
import { runGround } from "../src/pipeline/ground";
import { runWater } from "../src/pipeline/water";
import { runSiting } from "../src/pipeline/siting";
import { runNetwork } from "../src/pipeline/network";
import { runCanals } from "../src/pipeline/canals";
import { runDensity } from "../src/pipeline/density";
import { runWards } from "../src/pipeline/wards";
import { runPlazas } from "../src/pipeline/plazas";
import { runPaving } from "../src/pipeline/paving";

const SEEDS = ["everdusk-101", "seed-a", "seed-b"];
const PAVED = ZONE_KINDS.indexOf("paved");

function buildUntilPlazas(seed: string, over: Partial<Params> = {}): WorldModel {
  const model = createEmptyWorldModel(seed, { ...DEFAULT_PARAMS, ...over });
  runDerive(model);
  runGround(model);
  runWater(model);
  runSiting(model);
  runNetwork(model);
  runCanals(model);
  runDensity(model);
  runWards(model);
  runPlazas(model);
  return model;
}

function build(seed: string, over: Partial<Params> = {}): WorldModel {
  const model = buildUntilPlazas(seed, over);
  runPaving(model);
  return model;
}

function field(model: WorldModel): WaterField {
  return createWaterField(model.ground.boundary, [
    ...model.water.lakes,
    ...model.water.ponds,
  ]);
}

function pavedAt(mask: ZoneMask, x: number, z: number): number {
  return sampleZoneMask(mask, x, z).weights[PAVED] ?? 0;
}

describe("paving: 決定性", () => {
  it("同一 seed + params で zoneMask が完全一致する", () => {
    for (const seed of SEEDS) {
      expect(build(seed).ground.zoneMask).toEqual(build(seed).ground.zoneMask);
    }
  });

  it("段5〜9 は zoneMask に触れない(上書きは段10 に集約。contracts/pipeline.md)", () => {
    for (const seed of SEEDS) {
      const model = createEmptyWorldModel(seed, { ...DEFAULT_PARAMS });
      runDerive(model);
      runGround(model);
      runWater(model);
      const afterWater = structuredClone(model.ground.zoneMask);
      runSiting(model);
      runNetwork(model);
      runCanals(model);
      runDensity(model);
      runWards(model);
      runPlazas(model);
      expect(model.ground.zoneMask).toEqual(afterWater);
    }
  });
});

describe("paving: footprint の上書き(contracts/ground-water.md ZoneMask 節)", () => {
  it("道路の経路上(陸上)で舗装チャネルが上書きされている", () => {
    for (const seed of SEEDS) {
      const model = build(seed);
      const f = field(model);
      const mask = model.ground.zoneMask;
      let checked = 0;
      for (const edge of model.network.edges) {
        const total = pathLength(edge.path);
        for (const t of [0.25, 0.5, 0.75]) {
          const { p } = pointAlong(edge.path, total * t);
          if (f.waterSdf(p.x, p.z) < 2) continue; // 渡河部・岸ぎわは除く
          expect(pavedAt(mask, p.x, p.z)).toBeGreaterThan(0.3);
          checked++;
        }
      }
      expect(checked).toBeGreaterThan(5);
    }
  });

  it("広場の中心で舗装チャネルが強く上書きされている", () => {
    for (const seed of SEEDS) {
      const model = build(seed);
      const mask = model.ground.zoneMask;
      expect(model.plazas.length).toBeGreaterThan(0);
      for (const plaza of model.plazas) {
        expect(pavedAt(mask, plaza.position.x, plaza.position.z)).toBeGreaterThan(
          0.5,
        );
      }
    }
  });

  it("水路の経路沿いで舗装チャネルが上書きされている(護岸の縁)", () => {
    // スタンプは水域の有無に依らず経路の全長に入る(護岸の縁まで舗装)
    for (const seed of SEEDS) {
      const model = build(seed);
      const mask = model.ground.zoneMask;
      expect(model.water.canals.length).toBeGreaterThan(0);
      for (const canal of model.water.canals) {
        const total = pathLength(canal.points);
        for (const t of [0.3, 0.5, 0.7]) {
          const { p } = pointAlong(canal.points, total * t);
          expect(pavedAt(mask, p.x, p.z)).toBeGreaterThan(0.3);
        }
      }
    }
  });

  it("上書き後も各セルの重みは非負・合計1を保ち、大半のセルは未舗装のまま", () => {
    for (const seed of SEEDS) {
      const mask = build(seed).ground.zoneMask;
      const cells = mask.resolution * mask.resolution;
      let pavedCells = 0;
      for (let c = 0; c < cells; c++) {
        let sum = 0;
        for (let k = 0; k < ZONE_KINDS.length; k++) {
          const w = mask.weights[c * ZONE_KINDS.length + k] ?? -1;
          expect(w).toBeGreaterThanOrEqual(0);
          sum += w;
        }
        expect(sum).toBeCloseTo(1, 6);
        if ((mask.weights[c * ZONE_KINDS.length + PAVED] ?? 0) > 0.5) pavedCells++;
      }
      // 舗装は骨格(道・広場・水路)に留まり、地面の絵を壊さない
      expect(pavedCells).toBeGreaterThan(0);
      expect(pavedCells / cells).toBeLessThan(0.35);
    }
  });

  it("道路・広場・水路から離れた場所は舗装されない", () => {
    for (const seed of SEEDS) {
      const model = build(seed);
      const mask = model.ground.zoneMask;
      const cells = mask.resolution * mask.resolution;
      let zeroCells = 0;
      for (let c = 0; c < cells; c++) {
        if ((mask.weights[c * ZONE_KINDS.length + PAVED] ?? 0) === 0) zeroCells++;
      }
      expect(zeroCells / cells).toBeGreaterThan(0.4);
    }
  });
});
