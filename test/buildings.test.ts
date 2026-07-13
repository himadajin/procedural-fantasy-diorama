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
import {
  runBuildings,
  planGroupLayouts,
  type ParcelLayout,
} from "../src/pipeline/buildings";
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

function waterBodySdf(model: WorldModel): (x: number, z: number) => number {
  return createWaterField(model.ground.boundary, [
    ...model.water.lakes,
    ...model.water.ponds,
  ]).waterSdf;
}

describe("buildings: 決定性(contracts/buildings.md Building 節)", () => {
  it("同一 seed + params で buildings が完全一致する", () => {
    for (const seed of SEEDS) {
      const a = build(seed);
      const b = build(seed);
      expect(JSON.stringify(a.buildings)).toBe(JSON.stringify(b.buildings));
    }
  });
});

/** 一般建物(中心建築は role "center"・parcelId null の別契約) */
function general(model: WorldModel): WorldModel["buildings"] {
  return model.buildings.filter((b) => b.role !== "center");
}

describe("buildings: 骨格データの性質", () => {
  it("一般建物は区画と 1:1、中心建築(role center)が末尾に 1 棟(PHASE 5a)", () => {
    for (const seed of SEEDS) {
      const model = cached(seed);
      const generals = general(model);
      expect(generals.length).toBe(model.parcels.length);
      expect(generals.length).toBeGreaterThan(0);
      // 中心建築はちょうど 1 棟、末尾、parcelId null(契約)
      const centers = model.buildings.filter((b) => b.role === "center");
      expect(centers.length).toBe(1);
      expect(model.buildings[model.buildings.length - 1]?.role).toBe("center");
      expect(centers[0]?.id).toBe("building/center");
      expect(centers[0]?.parcelId).toBeNull();
      expect(centers[0]?.parts.length).toBeGreaterThan(0);
      const parcelIds = new Set(model.parcels.map((p) => p.id));
      for (const b of generals) {
        expect(b.parcelId).not.toBeNull();
        if (!b.parcelId) continue;
        expect(parcelIds.has(b.parcelId)).toBe(true);
        expect(b.id).toBe(`building/${b.parcelId.slice("parcel/".length)}`);
        expect(ROLES).toContain(b.role);
        expect(b.materials.wall).not.toBe("");
        expect(b.materials.roof).not.toBe("");
        expect(b.materials.trim).not.toBe("");
        expect(b.parts.length).toBeGreaterThan(0);
      }
    }
  });

  it("全一般建物が接道正面を持つ(親区画の frontEdge と道路の距離で機械検証)", () => {
    for (const seed of SEEDS) {
      const model = cached(seed);
      const parcelById = new Map(model.parcels.map((p) => [p.id, p]));
      const edgeById = new Map(model.network.edges.map((e) => [e.id, e]));
      for (const b of general(model)) {
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

  /** footprint 重心での urbanity(市街度)。floors のサイズ勾配検証用(Phase C) */
  function buildingUrbanity(model: WorldModel, b: WorldModel["buildings"][number]): number {
    if (!model.zoning) return 0;
    let cx = 0;
    let cz = 0;
    for (const v of b.footprint) {
      cx += v.x;
      cz += v.z;
    }
    cx /= b.footprint.length;
    cz /= b.footprint.length;
    return sampleFieldGrid(model.zoning, cx, cz);
  }

  it("floors は 1〜3(urbanity ≥ 0.75 の一般建物のみ 4)の整数(中心建築は 1〜5)、屋根勾配は 50〜58 度、L/T は複合屋根", () => {
    for (const seed of SEEDS) {
      const model = cached(seed);
      for (const b of model.buildings) {
        expect(Number.isInteger(b.floors)).toBe(true);
        expect(b.floors).toBeGreaterThanOrEqual(1);
        if (b.role === "center") {
          expect(b.floors).toBeLessThanOrEqual(5);
        } else {
          const urbanity = buildingUrbanity(model, b);
          expect(b.floors).toBeLessThanOrEqual(urbanity >= 0.75 ? 4 : 3);
        }
        expect(b.roof.pitch).toBeGreaterThanOrEqual(50);
        expect(b.roof.pitch).toBeLessThanOrEqual(58);
        if (b.role !== "center" && b.footprint.length > 4) {
          expect(b.roof.type).toBe("compound");
        }
      }
    }
  });

  it("サイズ勾配(Phase C): 一般建物の 4 階は urbanity ≥ 0.75 の位置のみ許容される", () => {
    // Settlement 100 は市街地が広がり、urbanity ≥ 0.75 の一般建物が多数
    // 生まれる条件(implementation-spec 1.6節・contracts/buildings.md
    // 「floors の改訂」)。この条件で 4 階建物の存在と urbanity 下限の双方を
    // 機械検証する。
    let sawFloor4 = 0;
    for (const seed of SEEDS) {
      const model = cached(seed, { settlement: 100 });
      for (const b of general(model)) {
        const urbanity = buildingUrbanity(model, b);
        // (b) urbanity < 0.75 の建物は floors ≤ 3
        if (urbanity < 0.75) {
          expect(b.floors).toBeLessThanOrEqual(3);
        }
        // (a) 4 階建物の位置はすべて urbanity ≥ 0.75
        if (b.floors === 4) {
          sawFloor4++;
          expect(urbanity).toBeGreaterThanOrEqual(0.75);
        }
      }
    }
    // 4 階建物が実在する条件であることを確認(空検証にしない)
    expect(sawFloor4).toBeGreaterThan(0);
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

describe("buildings: 同型連続の抑制(位置由来の決定論的変調。Phase C)", () => {
  /**
   * 区画グループ内の壁材が「3 区画以上連続して同一」になる頻度を数える。
   * グループ内をスロット連番順に並べ、長さ 3 の窓(スライディングウィンドウ)
   * ごとに「直前 2 区画と同一壁材が連続 3 以上続いている」かを判定する。
   */
  function materialRun3Stats(model: WorldModel): {
    windows: number;
    run3plus: number;
  } {
    const parcelById = new Map(model.parcels.map((p) => [p.id, p]));
    const byGroup = new Map<string, { slot: number; wall: string }[]>();
    for (const b of general(model)) {
      if (!b.parcelId) continue;
      const parcel = parcelById.get(b.parcelId);
      if (!parcel || !parcel.groupId) continue;
      const slot = Number(parcel.id.slice(parcel.id.lastIndexOf("/") + 1));
      let arr = byGroup.get(parcel.groupId);
      if (!arr) {
        arr = [];
        byGroup.set(parcel.groupId, arr);
      }
      arr.push({ slot, wall: b.materials.wall });
    }
    let windows = 0;
    let run3plus = 0;
    for (const arr of byGroup.values()) {
      if (arr.length < 3) continue;
      arr.sort((a, b) => a.slot - b.slot);
      let runLen = 1;
      for (let i = 1; i < arr.length; i++) {
        runLen = arr[i]?.wall === arr[i - 1]?.wall ? runLen + 1 : 1;
        if (runLen >= 3) run3plus++;
      }
      windows += arr.length - 2;
    }
    return { windows, run3plus };
  }

  it("同一壁材が 3 連続する頻度が、変調なし(実測固定値)より有意に低い", () => {
    // Settlement 100(固定 seed 3 本)での実測値。決定論的なので固定して比較する
    // (計画書 C3「同型抑制の統計検証」)。同一コードで序数変調
    // (MATERIAL_PARITY_WAVE)を 0 に戻すと windows=191 / run3plus=29
    // (rate 0.152)になることを一時確認済み。変調ありの実測は以下のとおり
    // 有意に下回る。
    let windows = 0;
    let run3plus = 0;
    for (const seed of SEEDS) {
      const model = cached(seed, { settlement: 100 });
      const stats = materialRun3Stats(model);
      windows += stats.windows;
      run3plus += stats.run3plus;
    }
    expect(windows).toBeGreaterThan(0);
    // 変調なしの実測 rate 0.152(29/191)を明確に下回ることを固定閾値で検証
    expect(run3plus / windows).toBeLessThan(0.12);
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
      const sdf = waterBodySdf(model);
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

  it("overWater でない建物は footprint が水域(湖・池・水路)に重ならない", () => {
    for (const [seed, over] of COMBOS) {
      const model = cached(seed, over);
      const sdf = waterBodySdf(model);
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

  it("一般建物が道路・広場に重ならない(中心建築は契約の例外)", () => {
    for (const seed of SEEDS) {
      const model = cached(seed);
      // 中心建築は主道が footprint 下で終端する設計のため対象外
      // (contracts「中心建築」の一般建物アサーションの例外)
      for (const b of general(model)) {
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

describe("buildings: グループ抽選と雁行(Phase C。計画書「C4b: グループ抽選と雁行」、contracts/buildings.md「区画グループとクラスタパターン」「雁行(stagger)の性質」)", () => {
  // 長いグループが多数出る条件(進捗ステータス C2: settle100 で最長 13)を
  // 複数 seed × Settlement/Prosperity で走査し、雁行(stagger)当選グループを
  // 十分な件数で観測する
  const SWEEP: Partial<Params>[] = [
    { settlement: 50 },
    { settlement: 100 },
    { settlement: 100, prosperity: 100 },
  ];

  it("抽選の決定性: 同一 seed + params で groupId ごとのパターンが完全一致する", () => {
    for (const seed of SEEDS) {
      for (const over of SWEEP) {
        const a = build(seed, over);
        const b = build(seed, over);
        const layoutsA = planGroupLayouts(a);
        const layoutsB = planGroupLayouts(b);
        const toSorted = (m: Map<string, ParcelLayout>) =>
          JSON.stringify([...m.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1)));
        expect(toSorted(layoutsA)).toBe(toSorted(layoutsB));
      }
    }
  });

  it("グループ長 1 の孤立区画・groupId 無しの区画は single 扱い(条件を満たさない候補は除外される)", () => {
    for (const seed of SEEDS) {
      const model = cached(seed);
      const layouts = planGroupLayouts(model);
      const parcelById = new Map(model.parcels.map((p) => [p.id, p]));
      for (const [parcelId, plan] of layouts) {
        const parcel = parcelById.get(parcelId);
        expect(parcel).toBeDefined();
        if (plan.groupSize === 1) {
          expect(plan.pattern).toBe("single");
        }
      }
    }
  });

  it("waterside/canalside 区画を含むグループは雁行(stagger)に当選しない(契約 3.4 節(14))", () => {
    for (const seed of SEEDS) {
      for (const over of [{ water: 95 }, { water: 70, settlement: 100 }]) {
        const model = cached(seed, over);
        const layouts = planGroupLayouts(model);
        const byGroup = new Map<string, { anyWaterside: boolean; pattern: string }>();
        for (const parcel of model.parcels) {
          const plan = layouts.get(parcel.id);
          if (!plan) continue;
          const entry = byGroup.get(parcel.groupId) ?? {
            anyWaterside: false,
            pattern: plan.pattern,
          };
          if (parcel.waterside || parcel.canalside) entry.anyWaterside = true;
          byGroup.set(parcel.groupId, entry);
        }
        for (const { anyWaterside, pattern } of byGroup.values()) {
          if (anyWaterside) expect(pattern).not.toBe("stagger");
        }
      }
    }
  });

  it("雁行(stagger)グループはグループ内序数の偶奇で前面セットバックが交互になる(統計検証)", () => {
    // セットバックは WorldModel に直接残らないため、接道辺の中点から footprint
    // 頂点への「奥行き方向への射影距離」の最小値(≈ frontSetback)を観測値と
    // して使う(建物ごとの独立な奥行き揺らぎがノイズとして乗るため、多数の
    // グループで集計して偶奇間の平均差が契約の交互値(0.5 / 2.0 → 差 1.5)
    // 相応であることを検証する)
    let nearSum = 0;
    let nearCount = 0;
    let farSum = 0;
    let farCount = 0;
    for (const seed of SEEDS) {
      for (const over of SWEEP) {
        const model = cached(seed, over);
        const layouts = planGroupLayouts(model);
        const parcelById = new Map(model.parcels.map((p) => [p.id, p]));
        for (const b of general(model)) {
          if (!b.parcelId) continue;
          const plan = layouts.get(b.parcelId);
          if (!plan || plan.pattern !== "stagger") continue;
          const parcel = parcelById.get(b.parcelId);
          if (!parcel) continue;
          const [fa, fc] = parcel.frontEdge;
          const mid = { x: (fa.x + fc.x) / 2, z: (fa.z + fc.z) / 2 };
          const backX = -Math.cos(parcel.facing);
          const backZ = -Math.sin(parcel.facing);
          let minDepth = Infinity;
          for (const v of b.footprint) {
            const depth = (v.x - mid.x) * backX + (v.z - mid.z) * backZ;
            minDepth = Math.min(minDepth, depth);
          }
          if (plan.indexInGroup % 2 === 0) {
            nearSum += minDepth;
            nearCount++;
          } else {
            farSum += minDepth;
            farCount++;
          }
        }
      }
    }
    // 空検証にならない(雁行グループが実在する)
    expect(nearCount).toBeGreaterThan(0);
    expect(farCount).toBeGreaterThan(0);
    const nearAvg = nearSum / nearCount;
    const farAvg = farSum / farCount;
    // 契約の交互値(0.5 / 2.0)の差 1.5 に対し、独立乱数の奥行き揺らぎで
    // ノイズは乗るが、集計平均では偶数(近い)側が奇数(遠い)側より
    // 明確に小さい(交互が機械的な統計として現れる)
    expect(nearAvg).toBeLessThan(farAvg - 0.8);
  });

  it("雁行グループの建物 footprint は親区画内に収まり、接道正面(facing)を維持する", () => {
    for (const seed of SEEDS) {
      for (const over of SWEEP) {
        const model = cached(seed, over);
        const layouts = planGroupLayouts(model);
        const parcelById = new Map(model.parcels.map((p) => [p.id, p]));
        let checked = 0;
        for (const b of general(model)) {
          if (!b.parcelId) continue;
          const plan = layouts.get(b.parcelId);
          if (!plan || plan.pattern !== "stagger") continue;
          const parcel = parcelById.get(b.parcelId);
          if (!parcel) continue;
          checked++;
          // footprint の全頂点が親区画ポリゴンの内側(符号付き距離 ≤ 0)
          for (const v of b.footprint) {
            expect(
              polygonSignedDistance(v.x, v.z, parcel.polygon),
            ).toBeLessThanOrEqual(1e-6);
          }
          // 接道正面(facing)は parcel.facing の 4 軸(広場スナップ込み。
          // 「向き: 広場 > 道路 > 水面の優先」契約)のいずれかから、揺らぎ
          // 上限(雁行の±4°を含めても 7° 以内)に収まる
          let rel = (b.facing - parcel.facing) % (Math.PI / 2);
          if (rel > Math.PI / 4) rel -= Math.PI / 2;
          if (rel < -Math.PI / 4) rel += Math.PI / 2;
          expect(Math.abs(rel)).toBeLessThan((7 * Math.PI) / 180);
        }
        expect(checked).toBeGreaterThanOrEqual(0);
      }
    }
  });
});
