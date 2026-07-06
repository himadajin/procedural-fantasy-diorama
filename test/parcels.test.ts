import { describe, expect, it } from "vitest";
import {
  DEFAULT_PARAMS,
  createEmptyWorldModel,
  type Params,
  type WorldModel,
} from "../src/model/worldmodel";
import {
  createWaterField,
  distToPolyline,
  polygonSignedDistance,
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

const SEEDS = ["everdusk-101", "seed-a", "seed-b"];

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

/** 河川・湖+水路の合成水域 sdf(正=陸側) */
function combinedWaterSdf(model: WorldModel): (x: number, z: number) => number {
  const field = createWaterField(
    model.ground.boundary,
    model.water.rivers,
    model.water.lakes,
  );
  return (x, z) => {
    let d = field.waterSdf(x, z);
    for (const canal of model.water.canals) {
      d = Math.min(d, distToPolyline(x, z, canal.points) - canal.width / 2);
    }
    return d;
  };
}

describe("parcels: 決定性(contracts/worldmodel.md Parcel 節)", () => {
  it("同一 seed + params で parcels と density.final が完全一致する", () => {
    for (const seed of SEEDS) {
      const a = build(seed);
      const b = build(seed);
      expect(JSON.stringify(a.parcels)).toBe(JSON.stringify(b.parcels));
      expect(JSON.stringify(a.density.final)).toBe(
        JSON.stringify(b.density.final),
      );
    }
  });
});

describe("density.final: 一次+結界内ブースト(contracts/worldmodel.md Density 節)", () => {
  it("primary と同じ張りで、primary 以上・0〜1 の値を持つ", () => {
    for (const seed of SEEDS) {
      const model = cached(seed);
      const final = model.density.final;
      const primary = model.density.primary;
      expect(final).not.toBeNull();
      expect(primary).not.toBeNull();
      if (!final || !primary) continue;
      expect(final.resolution).toBe(primary.resolution);
      expect(final.cellSize).toBe(primary.cellSize);
      expect(final.values.length).toBe(primary.values.length);
      for (let i = 0; i < final.values.length; i++) {
        const f = final.values[i] ?? 0;
        expect(f).toBeGreaterThanOrEqual(0);
        expect(f).toBeLessThanOrEqual(1);
        expect(f).toBeGreaterThanOrEqual((primary.values[i] ?? 0) - 1e-9);
      }
    }
  });

  it("結界がない(Arcana 0)とき final は primary と同値", () => {
    for (const seed of SEEDS) {
      const model = cached(seed, { arcana: 0 });
      expect(model.wards.ringPath.length).toBe(0);
      expect(model.density.final?.values).toEqual(
        model.density.primary?.values,
      );
    }
  });

  it("結界がある(デフォルト)とき ringPath 内側が持ち上がる", () => {
    for (const seed of SEEDS) {
      const model = cached(seed);
      const final = model.density.final;
      const primary = model.density.primary;
      if (!final || !primary) throw new Error("密度場が生成されていない");
      expect(model.wards.ringPath.length).toBeGreaterThan(0);
      // 環の内側の多数のセルでブーストが乗る(中心付近は clamp で飽和する
      // ため、点ではなく総量で検証する)
      let totalDiff = 0;
      let boostedCells = 0;
      for (let i = 0; i < final.values.length; i++) {
        const d = (final.values[i] ?? 0) - (primary.values[i] ?? 0);
        totalDiff += d;
        if (d > 0.05) boostedCells++;
      }
      expect(totalDiff).toBeGreaterThan(1);
      expect(boostedCells).toBeGreaterThan(10);
    }
  });
});

describe("parcels: 敷地の性質(接道・衝突・上限)", () => {
  it("全区画が接道正面を持つ(frontEdge 中点と接道 edge の距離 ≤ width/2 + 2)", () => {
    for (const seed of SEEDS) {
      const model = cached(seed);
      expect(model.parcels.length).toBeGreaterThan(0);
      const edgeById = new Map(model.network.edges.map((e) => [e.id, e]));
      for (const parcel of model.parcels) {
        const edge = edgeById.get(parcel.roadEdgeId);
        expect(edge).toBeDefined();
        if (!edge) continue;
        const [a, b] = parcel.frontEdge;
        const mid = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
        expect(distToPolyline(mid.x, mid.z, edge.path)).toBeLessThanOrEqual(
          edge.width / 2 + 2.0,
        );
      }
    }
  });

  it("id は一意で、区画数は parcelCountMax 以下", () => {
    for (const seed of SEEDS) {
      for (const over of [{}, { worldScale: 0 }, { settlement: 100 }] as const) {
        const model = cached(seed, over);
        const ids = new Set(model.parcels.map((p) => p.id));
        expect(ids.size).toBe(model.parcels.length);
        expect(model.parcels.length).toBeLessThanOrEqual(
          model.meta.derived.parcelCountMax,
        );
      }
    }
  });

  it("polygon は時計回り(shoelace 符号負)の矩形", () => {
    for (const seed of SEEDS) {
      const model = cached(seed);
      for (const parcel of model.parcels) {
        expect(parcel.polygon.length).toBe(4);
        let sum = 0;
        for (let i = 0; i < 4; i++) {
          const p = parcel.polygon[i];
          const q = parcel.polygon[(i + 1) % 4];
          if (!p || !q) continue;
          sum += p.x * q.z - q.x * p.z;
        }
        expect(sum).toBeLessThan(0);
      }
    }
  });

  it("区画どうし・水域・広場・道路と重ならない(衝突棄却の検証)", () => {
    for (const seed of SEEDS) {
      const model = cached(seed, { water: 70 });
      const waterSdf = combinedWaterSdf(model);
      for (let i = 0; i < model.parcels.length; i++) {
        const a = model.parcels[i];
        if (!a) continue;
        // 水域: 全頂点が陸上
        for (const v of a.polygon) {
          expect(waterSdf(v.x, v.z)).toBeGreaterThanOrEqual(0);
        }
        // 広場: 全頂点が広場の外
        for (const plaza of model.plazas) {
          for (const v of a.polygon) {
            expect(
              polygonSignedDistance(v.x, v.z, plaza.polygon),
            ).toBeGreaterThanOrEqual(0);
          }
        }
        // 道路: 中心線が区画を通らない
        for (const edge of model.network.edges) {
          for (const p of edge.path) {
            const inside = polygonSignedDistance(p.x, p.z, a.polygon) < 0;
            expect(inside).toBe(false);
          }
        }
        // 既存区画: 相互に重ならない
        for (let j = i + 1; j < model.parcels.length; j++) {
          const b = model.parcels[j];
          if (!b) continue;
          expect(polygonsOverlap(a.polygon, b.polygon)).toBe(false);
        }
      }
    }
  });

  it("Settlement 20/55/90 で区画数が単調に増える", () => {
    for (const seed of SEEDS) {
      const n20 = cached(seed, { settlement: 20 }).parcels.length;
      const n55 = cached(seed, { settlement: 55 }).parcels.length;
      const n90 = cached(seed, { settlement: 90 }).parcels.length;
      expect(n20).toBeLessThan(n55);
      expect(n55).toBeLessThan(n90);
    }
  });

  it("Water が高いと waterside / canalside 区画が現れる", () => {
    let found = 0;
    for (const seed of SEEDS) {
      const model = cached(seed, { water: 95 });
      found += model.parcels.filter((p) => p.waterside || p.canalside).length;
    }
    expect(found).toBeGreaterThan(0);
  });
});

describe("parcels: 岸線占有率 40% 上限(契約の測り方)", () => {
  const OCCUPY_DIST = 6;
  const CAP = 0.4;

  it("waterside 区画が占有する岸線点の割合 ≤ 0.40", () => {
    for (const seed of SEEDS) {
      for (const over of [{}, { water: 70 }, { water: 95 }] as const) {
        const model = cached(seed, over);
        const shorePoints = model.water.shoreline.loops.flatMap(
          (l) => l.points,
        );
        if (shorePoints.length === 0) continue;
        const watersides = model.parcels.filter((p) => p.waterside);
        let occupied = 0;
        for (const pt of shorePoints) {
          for (const parcel of watersides) {
            if (
              polygonSignedDistance(pt.x, pt.z, parcel.polygon) <= OCCUPY_DIST
            ) {
              occupied++;
              break;
            }
          }
        }
        expect(occupied / shorePoints.length).toBeLessThanOrEqual(CAP);
      }
    }
  });
});
