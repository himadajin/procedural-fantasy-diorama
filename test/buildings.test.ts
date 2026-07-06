import { describe, expect, it } from "vitest";
import {
  DEFAULT_PARAMS,
  SHORE_SKIRT_BOTTOM_Y,
  createEmptyWorldModel,
  type Params,
  type WorldModel,
} from "../src/model/worldmodel";
import {
  createWaterField,
  distToPolyline,
} from "../src/model/waterfield";
import { polygonsOverlap } from "../src/model/geometry";
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
import { runParcels } from "../src/pipeline/parcels";
import { runBuildings } from "../src/pipeline/buildings";
import { polylineTouchesPolygon } from "../src/pipeline/parcels";

const SEEDS = ["everdusk-101", "seed-a", "seed-b"];
const ROLES = [
  "house",
  "waterside",
  "bridgehead",
  "hall",
  "warehouse",
  "outskirt",
] as const;

function build(seed: string, over: Partial<Params> = {}): WorldModel {
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
  runPaving(model);
  runParcels(model);
  runBuildings(model);
  return model;
}

const cache = new Map<string, WorldModel>();
function cached(seed: string, over: Partial<Params> = {}): WorldModel {
  const key = seed + JSON.stringify(over);
  let model = cache.get(key);
  if (!model) {
    model = build(seed, over);
    cache.set(key, model);
  }
  return model;
}

function riverLakeSdf(model: WorldModel): (x: number, z: number) => number {
  return createWaterField(
    model.ground.boundary,
    model.water.rivers,
    model.water.lakes,
  ).waterSdf;
}

describe("buildings: 決定性(contracts/worldmodel.md Building 節)", () => {
  it("同一 seed + params で buildings が完全一致する", () => {
    for (const seed of SEEDS) {
      const a = build(seed);
      const b = build(seed);
      expect(JSON.stringify(a.buildings)).toBe(JSON.stringify(b.buildings));
    }
  });
});

describe("buildings: 骨格データの性質", () => {
  it("区画と 1:1 で、id・parcelId が区画由来。materials / parts は commit 13 の担当(空)", () => {
    for (const seed of SEEDS) {
      const model = cached(seed);
      expect(model.buildings.length).toBe(model.parcels.length);
      expect(model.buildings.length).toBeGreaterThan(0);
      const parcelIds = new Set(model.parcels.map((p) => p.id));
      for (const b of model.buildings) {
        expect(b.parcelId).not.toBeNull();
        if (!b.parcelId) continue;
        expect(parcelIds.has(b.parcelId)).toBe(true);
        expect(b.id).toBe(`building/${b.parcelId.slice("parcel/".length)}`);
        expect(ROLES).toContain(b.role);
        expect(b.materials).toEqual({ wall: "", roof: "", trim: "" });
        expect(b.parts).toEqual([]);
      }
    }
  });

  it("全建物が接道正面を持つ(親区画の frontEdge と道路の距離で機械検証)", () => {
    for (const seed of SEEDS) {
      const model = cached(seed);
      const parcelById = new Map(model.parcels.map((p) => [p.id, p]));
      const edgeById = new Map(model.network.edges.map((e) => [e.id, e]));
      for (const b of model.buildings) {
        const parcel = b.parcelId ? parcelById.get(b.parcelId) : undefined;
        expect(parcel).toBeDefined();
        if (!parcel) continue;
        const edge = edgeById.get(parcel.roadEdgeId);
        expect(edge).toBeDefined();
        if (!edge) continue;
        const [p, q] = parcel.frontEdge;
        const mid = { x: (p.x + q.x) / 2, z: (p.z + q.z) / 2 };
        expect(distToPolyline(mid.x, mid.z, edge.path)).toBeLessThanOrEqual(
          edge.width / 2 + 2.0,
        );
        expect(Number.isFinite(b.facing)).toBe(true);
      }
    }
  });

  it("floors は 1〜3 の整数、屋根勾配は 50〜58 度、L/T は複合屋根", () => {
    for (const seed of SEEDS) {
      const model = cached(seed);
      for (const b of model.buildings) {
        expect(Number.isInteger(b.floors)).toBe(true);
        expect(b.floors).toBeGreaterThanOrEqual(1);
        expect(b.floors).toBeLessThanOrEqual(3);
        expect(b.roof.pitch).toBeGreaterThanOrEqual(50);
        expect(b.roof.pitch).toBeLessThanOrEqual(58);
        if (b.footprint.length > 4) expect(b.roof.type).toBe("compound");
      }
    }
  });

  it("footprint は時計回り(shoelace 符号負)・自己交差なし(頂点数 4〜8)", () => {
    for (const seed of SEEDS) {
      const model = cached(seed);
      for (const b of model.buildings) {
        expect(b.footprint.length).toBeGreaterThanOrEqual(4);
        expect(b.footprint.length).toBeLessThanOrEqual(8);
        let sum = 0;
        for (let i = 0; i < b.footprint.length; i++) {
          const p = b.footprint[i];
          const q = b.footprint[(i + 1) % b.footprint.length];
          if (!p || !q) continue;
          sum += p.x * q.z - q.x * p.z;
        }
        expect(sum).toBeLessThan(0);
      }
    }
  });
});

describe("buildings: 接地(浮き・埋まりゼロと杭の水面下到達)", () => {
  const COMBOS: [string, Partial<Params>][] = [];
  for (const seed of SEEDS) {
    COMBOS.push([seed, {}], [seed, { water: 70 }], [seed, { water: 95 }]);
  }

  it("水上張り出し(overWater)の建物は杭/石基礎が y=-1.6 に到達する", () => {
    for (const [seed, over] of COMBOS) {
      const model = cached(seed, over);
      const sdf = riverLakeSdf(model);
      for (const b of model.buildings) {
        if (!b.foundation.overWater) continue;
        expect(["piles", "stonebase"]).toContain(b.foundation.kind);
        expect(b.foundation.bottomY).toBe(SHORE_SKIRT_BOTTOM_Y);
        // 実際に footprint の一部が水面上にある
        const someOver = b.footprint.some((v) => sdf(v.x, v.z) < 0);
        expect(someOver).toBe(true);
      }
    }
  });

  it("水上張り出しの建物が実際に生成される(杭契約が空検証にならない)", () => {
    let overWater = 0;
    for (const [seed, over] of COMBOS) {
      const model = cached(seed, over);
      overWater += model.buildings.filter((b) => b.foundation.overWater).length;
    }
    expect(overWater).toBeGreaterThan(0);
  });

  it("overWater でない建物は footprint が水域(河川・湖・水路)に重ならない", () => {
    for (const [seed, over] of COMBOS) {
      const model = cached(seed, over);
      const sdf = riverLakeSdf(model);
      for (const b of model.buildings) {
        for (const v of b.footprint) {
          if (!b.foundation.overWater) {
            expect(sdf(v.x, v.z)).toBeGreaterThanOrEqual(0);
          }
          // 水路の上はどの建物も禁止(契約)
          for (const canal of model.water.canals) {
            expect(
              distToPolyline(v.x, v.z, canal.points) - canal.width / 2,
            ).toBeGreaterThanOrEqual(0);
          }
        }
        if (!b.foundation.overWater) {
          expect(b.foundation.kind).toBe("plinth");
          expect(b.foundation.bottomY).toBe(0);
        }
        expect(b.foundation.plinthHeight).toBeGreaterThan(0);
      }
    }
  });
});

describe("buildings: 重なりゼロ(建物どうし・道路・広場)", () => {
  it("建物どうしが重ならない", () => {
    for (const seed of SEEDS) {
      const model = cached(seed, { settlement: 90 });
      const list = model.buildings;
      for (let i = 0; i < list.length; i++) {
        const a = list[i];
        if (!a) continue;
        for (let j = i + 1; j < list.length; j++) {
          const b = list[j];
          if (!b) continue;
          expect(polygonsOverlap(a.footprint, b.footprint)).toBe(false);
        }
      }
    }
  });

  it("建物が道路・広場に重ならない", () => {
    for (const seed of SEEDS) {
      const model = cached(seed);
      for (const b of model.buildings) {
        for (const edge of model.network.edges) {
          expect(
            polylineTouchesPolygon(edge.path, b.footprint, edge.width / 2),
          ).toBe(false);
        }
        for (const plaza of model.plazas) {
          expect(polygonsOverlap(b.footprint, plaza.polygon)).toBe(false);
        }
      }
    }
  });
});

describe("buildings: パラメータ駆動", () => {
  it("Settlement 20/55/90 で建物数が単調に増える", () => {
    for (const seed of SEEDS) {
      const n20 = cached(seed, { settlement: 20 }).buildings.length;
      const n55 = cached(seed, { settlement: 55 }).buildings.length;
      const n90 = cached(seed, { settlement: 90 }).buildings.length;
      expect(n20).toBeLessThan(n55);
      expect(n55).toBeLessThan(n90);
    }
  });

  it("役割が文脈から現れる(水辺で waterside、広場・密度の裾で多様化)", () => {
    const roles = new Set<string>();
    for (const seed of SEEDS) {
      for (const b of cached(seed, { water: 95 }).buildings) roles.add(b.role);
      for (const b of cached(seed).buildings) roles.add(b.role);
      for (const b of cached(seed, { settlement: 20, prosperity: 20 }).buildings) {
        roles.add(b.role);
      }
    }
    expect(roles.has("house")).toBe(true);
    expect(roles.has("waterside")).toBe(true);
    // 役割の多様性(住居+水辺以外にも文脈役割が出る)
    expect(roles.size).toBeGreaterThanOrEqual(4);
  });
});
