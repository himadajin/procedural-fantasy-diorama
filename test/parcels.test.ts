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
import { sampleFieldGrid } from "../src/model/fieldgrid";
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

/** 湖・池+水路の合成水域 sdf(正=陸側) */
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

describe("parcels: 決定性(contracts/buildings.md Parcel 節)", () => {
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

describe("density.final: 一次+結界内ブースト(contracts/network-plaza.md Density 節)", () => {
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

describe("parcels: 区画グループ(groupId。契約「区画グループとクラスタパターン」)", () => {
  // residential は <slot>、farmland は farm<slot>
  // (contracts/facilities.md「field(畑)・pasture(牧草地)」実装補足)
  const PARCEL_ID_RE = /^parcel\/(.+)\/(L|R)\/(farm)?(\d+)$/;
  const GROUP_ID_RE = /^block\/(.+)\/(L|R)\/(\d+)$/;

  function parseParcelId(id: string): { edgeId: string; side: "L" | "R"; slot: number } {
    const m = PARCEL_ID_RE.exec(id);
    if (!m) throw new Error(`unexpected parcel id: ${id}`);
    const edgeId = m[1];
    const side = m[2];
    const slot = m[4];
    if (edgeId === undefined || (side !== "L" && side !== "R") || slot === undefined) {
      throw new Error(`unexpected parcel id: ${id}`);
    }
    return { edgeId, side, slot: Number(slot) };
  }

  it("全区画に groupId が付与される", () => {
    for (const seed of SEEDS) {
      const model = cached(seed, { settlement: 100 });
      expect(model.parcels.length).toBeGreaterThan(0);
      for (const parcel of model.parcels) {
        expect(typeof parcel.groupId).toBe("string");
        expect(parcel.groupId.length).toBeGreaterThan(0);
      }
    }
  });

  it("groupId の形式は block/<roadEdgeId>/<L|R>/<runIndex>", () => {
    for (const seed of SEEDS) {
      const model = cached(seed, { settlement: 100 });
      for (const parcel of model.parcels) {
        const m = GROUP_ID_RE.exec(parcel.groupId);
        expect(m).not.toBeNull();
        if (!m) continue;
        expect(m[1]).toBe(parcel.roadEdgeId);
      }
    }
  });

  it("同一グループ内の区画は同一 edge・同一側かつスロット連番が連続する", () => {
    for (const seed of SEEDS) {
      const model = cached(seed, { settlement: 100 });
      const byGroup = new Map<string, typeof model.parcels>();
      for (const parcel of model.parcels) {
        let arr = byGroup.get(parcel.groupId);
        if (!arr) {
          arr = [];
          byGroup.set(parcel.groupId, arr);
        }
        arr.push(parcel);
      }
      expect(byGroup.size).toBeGreaterThan(0);
      for (const [groupId, members] of byGroup) {
        const groupMatch = GROUP_ID_RE.exec(groupId);
        expect(groupMatch).not.toBeNull();
        if (!groupMatch) continue;
        const [, groupEdgeId, groupSide] = groupMatch;
        const slots = members
          .map((p) => {
            const parsed = parseParcelId(p.id);
            // 同一 edge・同一側であること
            expect(parsed.edgeId).toBe(groupEdgeId);
            expect(parsed.side).toBe(groupSide);
            expect(p.roadEdgeId).toBe(groupEdgeId);
            return parsed.slot;
          })
          .sort((a, b) => a - b);
        // スロット連番が連続すること(欠番なし)
        for (let i = 1; i < slots.length; i++) {
          expect(slots[i]).toBe((slots[i - 1] ?? 0) + 1);
        }
      }
    }
  });

  it("孤立区画(前後が非採択)は長さ1のグループになる", () => {
    let foundSingleton = false;
    for (const seed of SEEDS) {
      const model = cached(seed);
      const counts = new Map<string, number>();
      for (const parcel of model.parcels) {
        counts.set(parcel.groupId, (counts.get(parcel.groupId) ?? 0) + 1);
      }
      for (const count of counts.values()) {
        if (count === 1) foundSingleton = true;
      }
    }
    expect(foundSingleton).toBe(true);
  });

  it("決定性: 同一 seed + params で groupId を含む parcels が完全一致する", () => {
    for (const seed of SEEDS) {
      const a = build(seed, { settlement: 100 });
      const b = build(seed, { settlement: 100 });
      expect(JSON.stringify(a.parcels)).toBe(JSON.stringify(b.parcels));
    }
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

describe("parcels: 農地区画(contracts/facilities.md「field(畑)・pasture(牧草地)」)", () => {
  function polygonCentroid(polygon: WorldModel["parcels"][number]["polygon"]) {
    let x = 0;
    let z = 0;
    for (const p of polygon) {
      x += p.x;
      z += p.z;
    }
    return { x: x / polygon.length, z: z / polygon.length };
  }
  function frontageOf(parcel: WorldModel["parcels"][number]): number {
    const [a, b] = parcel.frontEdge;
    return Math.hypot(b.x - a.x, b.z - a.z);
  }

  function median(values: number[]): number {
    const s = [...values].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 === 1
      ? (s[m] ?? 0)
      : ((s[m - 1] ?? 0) + (s[m] ?? 0)) / 2;
  }

  it("Settlement=0 で全 seed に農地区画が 2 件以上、Settlement=50 でも合計 1 件以上生じる", () => {
    // 実測(6 seed): settle0 は 7〜18 件/seed、settle50 は
    // 1〜4 件/seed。閾値は変動に堅牢な下限に取る
    let settle50Total = 0;
    for (const seed of SEEDS) {
      const model0 = cached(seed, { settlement: 0 });
      const farm0 = model0.parcels.filter((p) => p.kind === "farmland").length;
      expect(farm0).toBeGreaterThanOrEqual(2);
      const model50 = cached(seed, { settlement: 50 });
      settle50Total += model50.parcels.filter(
        (p) => p.kind === "farmland",
      ).length;
    }
    expect(settle50Total).toBeGreaterThanOrEqual(1);
  });

  it("農地区画の中心は農村ゾーン(urbanity < 0.45)にある(確定判定の機械検証)", () => {
    // 実装は縮小ステップごとの実候補の中心(= 矩形の重心)で農村ゾーンを
    // 確定判定する(contracts/facilities.md「農村ゾーン判定の基準点」)
    for (const seed of SEEDS) {
      for (const settle of [0, 50]) {
        const model = cached(seed, { settlement: settle });
        const zoning = model.zoning;
        if (!zoning) continue;
        for (const parcel of model.parcels) {
          if (parcel.kind !== "farmland") continue;
          const c = polygonCentroid(parcel.polygon);
          expect(sampleFieldGrid(zoning, c.x, c.z)).toBeLessThan(0.45);
        }
      }
    }
  });

  it("農地区画の寸法帯: 間口はワールド内で共通・[14, 40]・residential 実測中央値の 1.5 倍以上、奥行きは下限 4.5 以上", () => {
    // 間口 = clamp(1.7 × residential 候補間口の中央値, 14, 40)
    // (contracts/facilities.md「農地区画の寸法帯」)。候補中央値は
    // テストから再現しにくいため、機械検証は「採択 residential の実測
    // 中央値の 1.5 倍以上」という契約の下限(絵の意図の数値化)で行う
    for (const seed of SEEDS) {
      for (const settle of [0, 20, 50]) {
        const model = cached(seed, { settlement: settle });
        const farmlands = model.parcels.filter((p) => p.kind === "farmland");
        if (farmlands.length === 0) continue;
        const residentials = model.parcels.filter(
          (p) => p.kind === "residential",
        );
        const resMedian = median(residentials.map(frontageOf));
        const frontages = farmlands.map(frontageOf);
        const first = frontages[0] ?? 0;
        for (const f of frontages) {
          expect(f).toBeCloseTo(first, 6); // ワールド内で共通
          expect(f).toBeGreaterThanOrEqual(14 - 1e-6);
          expect(f).toBeLessThanOrEqual(40 + 1e-6);
          expect(f).toBeGreaterThanOrEqual(1.5 * resMedian);
        }
        for (const parcel of farmlands) {
          // 奥行き = 矩形面積(shoelace)/ 間口(頂点順序に依存しない導出)
          let area2 = 0;
          for (let i = 0; i < parcel.polygon.length; i++) {
            const p = parcel.polygon[i];
            const q = parcel.polygon[(i + 1) % parcel.polygon.length];
            if (!p || !q) continue;
            area2 += p.x * q.z - q.x * p.z;
          }
          const depth = Math.abs(area2) / 2 / frontageOf(parcel);
          expect(depth).toBeGreaterThanOrEqual(4.5 - 1e-6);
          // 上限 = 間口 × 奥行き比 1.6 × 揺らぎ上限 1.1
          expect(depth).toBeLessThanOrEqual(first * 1.6 * 1.1 + 1e-6);
        }
      }
    }
  });

  it("農地区画は residential 区画・道路・水域・広場と重ならない(kind によらぬ既存の衝突検証を再確認)", () => {
    for (const seed of SEEDS) {
      const model = cached(seed, { settlement: 0 });
      const farmlands = model.parcels.filter((p) => p.kind === "farmland");
      for (const f of farmlands) {
        for (const other of model.parcels) {
          if (other.id === f.id) continue;
          expect(polygonsOverlap(f.polygon, other.polygon)).toBe(false);
        }
      }
    }
  });

  it("farmland 区画にも groupId が付与され、residential の groupId と混在しない(block/<edge>/<L|R>/<n> 形式)", () => {
    const GROUP_ID_RE = /^block\/(.+)\/(L|R)\/(\d+)$/;
    for (const seed of SEEDS) {
      const model = cached(seed, { settlement: 0 });
      const byGroup = new Map<string, WorldModel["parcels"]>();
      for (const parcel of model.parcels) {
        let arr = byGroup.get(parcel.groupId);
        if (!arr) {
          arr = [];
          byGroup.set(parcel.groupId, arr);
        }
        arr.push(parcel);
      }
      for (const [groupId, members] of byGroup) {
        expect(GROUP_ID_RE.test(groupId)).toBe(true);
        const kinds = new Set(members.map((p) => p.kind));
        // 同一グループ内は kind が単一(residential と farmland が混在しない)
        expect(kinds.size).toBe(1);
      }
    }
  });
});
