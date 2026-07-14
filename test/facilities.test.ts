/**
 * 段14「施設」(field / pasture)のテスト。
 * 契約は docs/internal/contracts/facilities.md(kind 一覧・配置条件・
 * 衝突/帯検証則・順序非依存の走査順・RNG ラベル体系・kind ごとの造形の
 * 性質)と contracts/pipeline.md の段契約表(段14)。
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PARAMS,
  createEmptyWorldModel,
  type Facility,
  type Params,
  type Part,
  type WorldModel,
} from "../src/model/worldmodel";
import { distToPolyline, polygonSignedDistance } from "../src/model/waterfield";
import { ensureClockwise, polygonsOverlap } from "../src/model/geometry";
import { sampleFieldGrid } from "../src/model/fieldgrid";
import { createWaterField, waterBodies } from "../src/model/waterfield";
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
  waterfrontClaimedRegions,
} from "../src/pipeline/buildings";
import { runLanes } from "../src/pipeline/lanes";
import {
  buildFarmlandFacility,
  plazaInflowAzimuths,
  runFacilities,
} from "../src/pipeline/facilities";

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
  runLanes(model);
  runFacilities(model);
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

/** 部品の回転込みの xz 4 隅(帯検証と同じ保守的な見積もり)。
 * canopy はローカル z 0〜+1 の非対称レンジ(契約「施設部品の語彙」) */
function partCorners(part: Part): { x: number; z: number }[] {
  const [px, , pz] = part.transform.position;
  const [sx, , sz] = part.transform.scale;
  const cos = Math.cos(part.transform.rotation);
  const sin = Math.sin(part.transform.rotation);
  const z0 = part.type === "canopy" ? 0 : -sz / 2;
  const z1 = part.type === "canopy" ? sz : sz / 2;
  const corners: { x: number; z: number }[] = [];
  for (const [lx, lz] of [
    [-sx / 2, z0],
    [sx / 2, z0],
    [sx / 2, z1],
    [-sx / 2, z1],
  ] as const) {
    corners.push({ x: px + lx * cos + lz * sin, z: pz - lx * sin + lz * cos });
  }
  return corners;
}

/** テスト用の farmland 区画(ギャラリーと同じ軸平行矩形) */
function farmParcel(frontage = 24, depth = 38): Parameters<
  typeof buildFarmlandFacility
>[1] {
  const half = frontage / 2;
  const fl = { x: -half, z: 0 };
  const fr = { x: half, z: 0 };
  const br = { x: half, z: depth };
  const bl = { x: -half, z: depth };
  return {
    id: "parcel/test/L/farm0",
    roadEdgeId: "test",
    polygon: ensureClockwise([fl, fr, br, bl]),
    frontEdge: [fl, fr],
    facing: -Math.PI / 2,
    waterside: false,
    canalside: false,
    groupId: "",
    kind: "farmland",
  };
}

describe("段14 施設: farmland 区画との 1:1(契約「field・pasture」)", () => {
  const CASES: [string, Partial<Params>][] = [
    ["everdusk-101", { settlement: 0 }],
    ["everdusk-101", { settlement: 20 }],
    ["seed-a", { settlement: 0 }],
    ["seed-b", { settlement: 20 }],
  ];
  for (const [seed, over] of CASES) {
    it(`${seed} ${JSON.stringify(over)}: 全 farmland 区画がちょうど 1 件の施設を持つ`, () => {
      const model = cached(seed, over);
      const farmland = model.parcels.filter((p) => p.kind === "farmland");
      expect(farmland.length).toBeGreaterThan(0);
      // farmland 由来の施設(field / pasture)は配列の先頭に並ぶ
      // (well / stall 等は後続に加わる。contracts/facilities.md
      // 「Facility スキーマ」節末尾の配列順)
      const farmFacilities = model.facilities.filter(
        (f) => f.kind === "field" || f.kind === "pasture",
      );
      expect(farmFacilities.length).toBe(farmland.length);
      for (let i = 0; i < farmland.length; i++) {
        const parcel = farmland[i]!;
        const facility = farmFacilities[i]!;
        expect(["field", "pasture"]).toContain(facility.kind);
        expect(facility.id).toBe(`facility/${facility.kind}/${parcel.id}`);
        expect(facility.origin).toEqual({
          type: "parcel",
          parcelId: parcel.id,
        });
        // footprint は区画 polygon そのもの(区画 = 帰属領域)
        expect(facility.footprint).toEqual(parcel.polygon);
        expect(facility.facing).toBe(parcel.facing);
        expect(facility.parts.length).toBeGreaterThan(0);
      }
    });
  }

  it("順序非依存の走査順: facilities は farmland 区画の parcels 配列内出現順", () => {
    const model = cached("everdusk-101", { settlement: 0 });
    const farmlandIds = model.parcels
      .filter((p) => p.kind === "farmland")
      .map((p) => p.id);
    const originIds = model.facilities
      .filter((f) => f.kind === "field" || f.kind === "pasture")
      .map((f) => (f.origin as { type: "parcel"; parcelId: string }).parcelId);
    expect(originIds).toEqual(farmlandIds);
  });

  it("settle 100(全面市街)では farmland も field / pasture も 0 件", () => {
    const model = cached("everdusk-101", { settlement: 100 });
    expect(model.parcels.filter((p) => p.kind === "farmland").length).toBe(0);
    expect(
      model.facilities.filter(
        (f) => f.kind === "field" || f.kind === "pasture",
      ).length,
    ).toBe(0);
  });
});

describe("段14 施設: 帯検証・衝突(契約「衝突・帯検証則」)", () => {
  it("全 parts が footprint から 0.9 を超えてはみ出さない", () => {
    const model = cached("everdusk-101", { settlement: 0 });
    for (const facility of model.facilities) {
      for (const part of facility.parts) {
        for (const c of partCorners(part)) {
          expect(
            polygonSignedDistance(c.x, c.z, facility.footprint),
          ).toBeLessThanOrEqual(0.9 + 1e-9);
        }
      }
    }
  });

  it("段14 は facilities 以外のフィールドに触れない", () => {
    const model = cached("everdusk-101", { settlement: 0 });
    const before = createEmptyWorldModel("everdusk-101", {
      ...DEFAULT_PARAMS,
      settlement: 0,
    });
    runDerive(before);
    runGround(before);
    runWater(before);
    runSiting(before);
    runNetwork(before);
    runCanals(before);
    runDensity(before);
    runWards(before);
    runPlazas(before);
    runPaving(before);
    runParcels(before);
    runBuildings(before);
    runLanes(before);
    const beforeJson = JSON.stringify({ ...before, facilities: null });
    expect(JSON.stringify({ ...model, facilities: null })).toBe(beforeJson);
  });
});

describe("段14 施設: 決定性(RNG ラベル体系)", () => {
  it("同一 seed・params で facilities が完全一致する", () => {
    const a = build("everdusk-101", { settlement: 0 });
    const b = build("everdusk-101", { settlement: 0 });
    expect(JSON.stringify(a.facilities)).toBe(JSON.stringify(b.facilities));
  });

  it("造形純関数は同一区画・同一 seed で同一の Part[] を返す", () => {
    const parcel = farmParcel();
    const a = buildFarmlandFacility("seed-x", parcel);
    const b = buildFarmlandFacility("seed-x", parcel);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("kind の強制(ギャラリー)は抽選消費を保ったまま値だけ置き換える", () => {
    const parcel = farmParcel();
    const rolled = buildFarmlandFacility("seed-x", parcel);
    const forced = buildFarmlandFacility(
      "seed-x",
      parcel,
      rolled.kind as "field" | "pasture",
    );
    // 同じ kind を強制すれば完全一致(抽選消費が同一である証拠)
    expect(JSON.stringify(forced)).toBe(JSON.stringify(rolled));
  });
});

describe("段14 施設: field / pasture の造形(契約「kind ごとの造形の性質」)", () => {
  /** kind を強制した施設(造形検証用) */
  function make(kind: "field" | "pasture", seed = "seed-x"): Facility {
    return buildFarmlandFacility(seed, farmParcel(), kind);
  }

  it("field: 基盤+畝(ground-patch)の列と、木の柵(beam)で構成される", () => {
    const field = make("field");
    const patches = field.parts.filter((p) => p.type === "ground-patch");
    const beams = field.parts.filter((p) => p.type === "beam");
    expect(patches.length + beams.length).toBe(field.parts.length);
    // 先頭は基盤パッチ(params なし)、続いて畝(params.top を持つ)
    expect(patches[0]?.params).toBeUndefined();
    const ridges = patches.slice(1);
    expect(ridges.length).toBeGreaterThan(5);
    for (const ridge of ridges) {
      expect(ridge.materialId).toBe("tilled-soil");
      expect([0, 1, 2]).toContain(ridge.params?.top);
      // 幅 1.0 の畝(contracts/facilities.md「field(畑)」節「プロポーションの狙い」)
      expect(ridge.transform.scale[2]).toBeCloseTo(1.0, 6);
    }
    // 畝の作物の有無は畑ごとに揃う(全畝が同じ top)
    const tops = new Set(ridges.map((r) => r.params?.top ?? 0));
    expect(tops.size).toBe(1);
    for (const beam of beams) expect(beam.materialId).toBe("wood");
  });

  it("pasture: 牧草パッチ 1 枚+一段高い柵(横木 2 本)で構成される", () => {
    const pasture = make("pasture");
    const patches = pasture.parts.filter((p) => p.type === "ground-patch");
    expect(patches.length).toBe(1);
    expect(patches[0]?.materialId).toBe("meadow");

    // 柵の高さの読み分け(contracts/facilities.md「pasture(牧草地)」節): pasture の柱は field より高い
    const postHeights = (f: Facility): number[] =>
      f.parts
        .filter((p) => p.type === "beam" && p.transform.scale[0] < 0.2)
        .map((p) => p.transform.scale[1]);
    const field = make("field");
    const maxFieldPost = Math.max(...postHeights(field));
    const minPasturePost = Math.min(...postHeights(pasture));
    expect(minPasturePost).toBeGreaterThan(maxFieldPost * 0.9);

    // 横木(長い beam)の本数: pasture は field の約 2 倍(2 本/辺)
    const rails = (f: Facility): number =>
      f.parts.filter((p) => p.type === "beam" && p.transform.scale[0] >= 0.5)
        .length;
    expect(rails(pasture)).toBeGreaterThan(rails(field));
  });

  it("field / pasture とも部品は低い(横木の下端 < 1.1、パッチ・畝は薄い)", () => {
    for (const kind of ["field", "pasture"] as const) {
      const f = make(kind);
      for (const p of f.parts) {
        expect(p.transform.position[1]).toBeGreaterThanOrEqual(0);
        // 最も高い部品は柵の上段横木の下端(< 1.1。屋根を持たない施設)
        expect(p.transform.position[1]).toBeLessThan(1.1);
        if (p.type === "ground-patch") {
          expect(p.transform.scale[1]).toBeLessThanOrEqual(0.4);
        }
      }
    }
  });

  it("kind 抽選はおおむね field 0.68 / pasture 0.32(局所多様性のコイン)", () => {
    let fields = 0;
    const n = 200;
    for (let i = 0; i < n; i++) {
      const parcel = farmParcel();
      parcel.id = `parcel/test/L/farm${i}`;
      if (buildFarmlandFacility("seed-ratio", parcel).kind === "field") {
        fields++;
      }
    }
    expect(fields / n).toBeGreaterThan(0.55);
    expect(fields / n).toBeLessThan(0.8);
  });
});


describe("段14 施設: well / stall(契約「well」「stall」「衝突・帯検証則」)", () => {
  /** 通行帯セクターの検算用: 施設の方位と流入方位の最小角差 */
  function minAngleDiff(angle: number, azimuths: readonly number[]): number {
    let best = Infinity;
    for (const az of azimuths) {
      let d = Math.abs(angle - az) % (Math.PI * 2);
      if (d > Math.PI) d = Math.PI * 2 - d;
      best = Math.min(best, d);
    }
    return best;
  }

  const CASES: [string, Partial<Params>][] = [
    ["everdusk-101", {}],
    ["everdusk-101", { prosperity: 100 }],
    ["seed-a", { settlement: 100, prosperity: 100 }],
    ["seed-b", { settlement: 0 }],
  ];

  for (const [seed, over] of CASES) {
    it(`${seed} ${JSON.stringify(over)}: 広場施設は center/crossing のみ・帯と通行帯を守る`, () => {
      const model = cached(seed, over);
      const plazaById = new Map(model.plazas.map((p) => [p.id, p]));
      for (const f of model.facilities) {
        if (f.origin.type !== "plaza") continue;
        const plaza = plazaById.get(f.origin.plazaId);
        expect(plaza).toBeDefined();
        if (!plaza) continue;
        // 対象は市街の表の広場のみ(courtyard・gate・bridgehead は対象外)
        expect(["center", "crossing"]).toContain(plaza.kind);
        // footprint 全コーナーが広場 polygon の内側(帰属領域帯)
        for (const v of f.footprint) {
          expect(polygonSignedDistance(v.x, v.z, plaza.polygon)).toBeLessThan(0);
        }
        const center = {
          x: f.footprint.reduce((a, v) => a + v.x, 0) / f.footprint.length,
          z: f.footprint.reduce((a, v) => a + v.z, 0) / f.footprint.length,
        };
        const edgeDist = -polygonSignedDistance(center.x, center.z, plaza.polygon);
        const distC = Math.hypot(
          center.x - plaza.position.x,
          center.z - plaza.position.z,
        );
        const angle = Math.atan2(
          center.z - plaza.position.z,
          center.x - plaza.position.x,
        );
        const azimuths = plazaInflowAzimuths(model, plaza);
        if (f.kind === "stall") {
          // 縁帯(1.0〜2.5)・通行帯セクター外(±20°)
          expect(edgeDist).toBeGreaterThanOrEqual(1.0 - 1e-9);
          expect(edgeDist).toBeLessThanOrEqual(2.5 + 1e-9);
          expect(minAngleDiff(angle, azimuths)).toBeGreaterThanOrEqual(
            (20 * Math.PI) / 180 - 1e-9,
          );
        } else if (f.kind === "well") {
          // 縁帯より内側(2.7 以上)・中央円の外・通行帯セクター外
          expect(edgeDist).toBeGreaterThanOrEqual(2.7 - 0.2);
          expect(distC).toBeGreaterThanOrEqual(plaza.radius * 0.45 - 1e-9);
          expect(minAngleDiff(angle, azimuths)).toBeGreaterThanOrEqual(
            (20 * Math.PI) / 180 - 1e-9,
          );
        }
      }
    });

    it(`${seed} ${JSON.stringify(over)}: 広場井戸は 1 広場 1 基・屋台数は数量式以内`, () => {
      const model = cached(seed, over);
      const prosper = (model.meta.params.prosperity ?? 50) / 100;
      const stallCap = Math.round(Math.min(12, Math.max(3, 3 + 9 * prosper)));
      const wellsByPlaza = new Map<string, number>();
      const stallsByPlaza = new Map<string, number>();
      for (const f of model.facilities) {
        if (f.origin.type !== "plaza") continue;
        const key = f.origin.plazaId;
        if (f.kind === "well") {
          wellsByPlaza.set(key, (wellsByPlaza.get(key) ?? 0) + 1);
        }
        if (f.kind === "stall") {
          stallsByPlaza.set(key, (stallsByPlaza.get(key) ?? 0) + 1);
        }
      }
      for (const n of wellsByPlaza.values()) expect(n).toBe(1);
      for (const n of stallsByPlaza.values()) {
        expect(n).toBeLessThanOrEqual(stallCap);
      }
    });
  }

  it("農村井戸: 上限以内・農村ゾーン・道路/区画/水域とのクリアランス", () => {
    const model = cached("everdusk-101", {});
    const settle = model.meta.params.settlement / 100;
    const cap = Math.ceil(2 + 4 * settle);
    const ruralWells = model.facilities.filter(
      (f) => f.kind === "well" && f.origin.type === "node",
    );
    expect(ruralWells.length).toBeLessThanOrEqual(cap);
    for (const well of ruralWells) {
      const center = {
        x: well.footprint.reduce((a, v) => a + v.x, 0) / well.footprint.length,
        z: well.footprint.reduce((a, v) => a + v.z, 0) / well.footprint.length,
      };
      // 道路と重ならない(縁 + 1.0 − footprint 半径ぶんの余裕で検算)
      for (const edge of model.network.edges) {
        expect(
          distToPolyline(center.x, center.z, edge.path) - edge.width / 2,
        ).toBeGreaterThan(0);
      }
      // 区画・広場と重ならない
      for (const parcel of model.parcels) {
        expect(
          polygonSignedDistance(center.x, center.z, parcel.polygon),
        ).toBeGreaterThan(0);
      }
      for (const plaza of model.plazas) {
        expect(
          polygonSignedDistance(center.x, center.z, plaza.polygon),
        ).toBeGreaterThan(0);
      }
    }
  });

  it("配列順序: field/pasture → well(広場 → 農村)→ stall(契約「Facility スキーマ」)", () => {
    const model = cached("everdusk-101", {});
    const rank = (f: (typeof model.facilities)[number]): number => {
      if (f.kind === "field" || f.kind === "pasture") return 0;
      if (f.kind === "well") return f.origin.type === "plaza" ? 1 : 2;
      if (f.kind === "stall") return 3;
      if (f.kind === "windmill") return 4;
      if (f.kind === "watermill") return 5;
      return 6; // pier
    };
    const ranks = model.facilities.map(rank);
    for (let i = 1; i < ranks.length; i++) {
      expect(ranks[i]!).toBeGreaterThanOrEqual(ranks[i - 1]!);
    }
  });

  it("settle 100 × prosper 100: 市街広場に井戸と屋台列が現れる", () => {
    const model = cached("seed-a", { settlement: 100, prosperity: 100 });
    const stalls = model.facilities.filter((f) => f.kind === "stall");
    const plazaWells = model.facilities.filter(
      (f) => f.kind === "well" && f.origin.type === "plaza",
    );
    expect(stalls.length).toBeGreaterThan(3);
    expect(plazaWells.length).toBeGreaterThanOrEqual(1);
  });
});


describe("段14 施設: windmill / watermill(契約「windmill」「watermill」)", () => {
  it("windmill: prosper/scale 高で少数(≤2)が農村外縁の帯に立つ", () => {
    const model = cached("everdusk-101", { prosperity: 100 });
    const windmills = model.facilities.filter((f) => f.kind === "windmill");
    expect(windmills.length).toBeGreaterThanOrEqual(1);
    expect(windmills.length).toBeLessThanOrEqual(2);
    const field = createWaterField(
      model.ground.boundary,
      waterBodies(model.water),
    );
    const { marginWidth } = model.meta.derived;
    for (const windmill of windmills) {
      const c = {
        x:
          windmill.footprint.reduce((a, v) => a + v.x, 0) /
          windmill.footprint.length,
        z:
          windmill.footprint.reduce((a, v) => a + v.z, 0) /
          windmill.footprint.length,
      };
      // 外縁帯(marginWidth × [0.3, 1.8))かつ農村ゾーン
      const bSdf = field.boundarySdf(c.x, c.z);
      expect(bSdf).toBeGreaterThanOrEqual(marginWidth * 0.3 - 1e-9);
      expect(bSdf).toBeLessThan(marginWidth * 1.8);
      if (model.zoning) {
        expect(sampleFieldGrid(model.zoning, c.x, c.z)).toBeLessThan(0.45);
      }
      // 水域から 4.5(windmill の例外帯)
      expect(field.waterSdf(c.x, c.z)).toBeGreaterThanOrEqual(4.5 - 1e-9);
      // 道路・区画と重ならない(中心点の検算)
      for (const parcel of model.parcels) {
        expect(
          polygonSignedDistance(c.x, c.z, parcel.polygon),
        ).toBeGreaterThan(0);
      }
      // origin はセル由来
      expect(windmill.origin.type).toBe("site");
      expect(windmill.id).toMatch(/^facility\/windmill\/\d+_\d+$/);
    }
  });

  it("windmill: prosper 0 × scale 0 では 0 基(数量式)", () => {
    const model = cached("everdusk-101", { prosperity: 0, worldScale: 0 });
    expect(model.facilities.filter((f) => f.kind === "windmill").length).toBe(
      0,
    );
  });

  it("watermill: water 高で少数(≤2)が岸・水路沿いに立ち、本体は陸上", () => {
    const model = cached("everdusk-101", { water: 95 });
    const mills = model.facilities.filter((f) => f.kind === "watermill");
    expect(mills.length).toBeGreaterThanOrEqual(1);
    expect(mills.length).toBeLessThanOrEqual(2);
    const field = createWaterField(
      model.ground.boundary,
      waterBodies(model.water),
    );
    for (const mill of mills) {
      // footprint 頂点はすべて陸上(waterSdf ≥ 0)・水路にも重ならない
      for (const v of mill.footprint) {
        expect(field.waterSdf(v.x, v.z)).toBeGreaterThanOrEqual(-1e-6);
        for (const canal of model.water.canals) {
          let d = Infinity;
          for (let i = 0; i + 1 < canal.points.length; i++) {
            const a = canal.points[i]!;
            const b = canal.points[i + 1]!;
            const dx = b.x - a.x;
            const dz = b.z - a.z;
            const len2 = dx * dx + dz * dz;
            const t =
              len2 > 0
                ? Math.max(
                    0,
                    Math.min(1, ((v.x - a.x) * dx + (v.z - a.z) * dz) / len2),
                  )
                : 0;
            d = Math.min(
              d,
              Math.hypot(v.x - (a.x + dx * t), v.z - (a.z + dz * t)),
            );
          }
          expect(d - canal.width / 2).toBeGreaterThanOrEqual(-1e-6);
        }
      }
      // 水輪のハブは水側(facing 方向)にある
      const wheel = mill.parts.find((p) => p.type === "water-wheel");
      expect(wheel).toBeDefined();
      // origin は canal / shore 由来
      expect(["canal", "shore"]).toContain(mill.origin.type);
    }
  });

  it("watermill: water 0(水域なし)では 0 基", () => {
    const model = cached("everdusk-101", { water: 0 });
    expect(model.facilities.filter((f) => f.kind === "watermill").length).toBe(
      0,
    );
  });
});


describe("段14 施設: pier(契約「pier(桟橋)」「waterfront claimed 検査への参加」)", () => {
  const CASES: [string, Partial<Params>][] = [
    ["everdusk-101", { water: 95 }],
    ["harbor-2", { water: 90 }],
    ["seed-b", { water: 70 }],
  ];

  for (const [seed, over] of CASES) {
    it(`${seed} ${JSON.stringify(over)}: 板+杭の構成・天端 0.35・岸から水面へ突き出す`, () => {
      const model = cached(seed, over);
      const piers = model.facilities.filter((f) => f.kind === "pier");
      expect(piers.length).toBeGreaterThanOrEqual(1);
      expect(piers.length).toBeLessThanOrEqual(4);
      const field = createWaterField(
        model.ground.boundary,
        waterBodies(model.water),
      );
      for (const pier of piers) {
        // origin・id は汀線由来(契約「RNG ラベル体系」)
        expect(pier.origin.type).toBe("shore");
        expect(pier.id).toMatch(/^facility\/pier\/.+\/\d+$/);
        // 板 1 枚(粗い木)+ 杭(木)のみで構成される
        const decks = pier.parts.filter((p) => p.type === "deck");
        const piles = pier.parts.filter((p) => p.type === "pile");
        expect(decks.length).toBe(1);
        expect(piles.length).toBeGreaterThanOrEqual(4);
        expect(decks.length + piles.length).toBe(pier.parts.length);
        const deck = decks[0]!;
        expect(deck.materialId).toBe("rough-wood");
        for (const pile of piles) expect(pile.materialId).toBe("wood");
        // 天端 y 0.35(建物デッキ = 基壇天端より低い「岸から一段降りた」高さ)
        expect(
          deck.transform.position[1] + deck.transform.scale[1],
        ).toBeCloseTo(0.35, 6);
        // 板の幅・長さ(contracts/facilities.md「pier(桟橋)」節の寸法帯)
        expect(deck.transform.scale[0]).toBeGreaterThanOrEqual(6 - 1e-9);
        expect(deck.transform.scale[0]).toBeLessThanOrEqual(10 + 1e-9);
        expect(deck.transform.scale[2]).toBeGreaterThanOrEqual(1.6 - 1e-9);
        expect(deck.transform.scale[2]).toBeLessThanOrEqual(2.0 + 1e-9);
        // 杭は水底側(y −1.6)から立ち、係船柱があれば板の上 0.55 まで
        for (const pile of piles) {
          expect(pile.transform.position[1]).toBeCloseTo(-1.6, 6);
          const top =
            pile.transform.position[1] + pile.transform.scale[1];
          expect(
            Math.abs(top - 0.9) < 1e-6 || Math.abs(top - 0.13) < 1e-6,
          ).toBe(true);
        }
        // 陸側端は陸上・先端は水上(「岸から水面へ直交に伸びる」の検算):
        // footprint 頂点を facing 方向の座標で並べ、陸側 2 隅は waterSdf ≥ 0
        // 寄り、先端 2 隅は水面(waterSdf < 0)
        const f = { x: Math.cos(pier.facing), z: Math.sin(pier.facing) };
        const sorted = [...pier.footprint].sort(
          (a, b) => a.x * f.x + a.z * f.z - (b.x * f.x + b.z * f.z),
        );
        for (const tip of sorted.slice(2)) {
          expect(field.waterSdf(tip.x, tip.z)).toBeLessThan(0);
        }
        for (const land of sorted.slice(0, 2)) {
          expect(field.waterSdf(land.x, land.z)).toBeGreaterThan(-1e-6);
        }
      }
    });

    it(`${seed} ${JSON.stringify(over)}: claimed 領域・橋・水路と重ならず、桟橋どうしは離れる`, () => {
      const model = cached(seed, over);
      const piers = model.facilities.filter((f) => f.kind === "pier");
      // waterfront claimed 領域(建物のデッキ・張り出し部屋)と非重複
      const claimed = waterfrontClaimedRegions(model);
      for (const pier of piers) {
        for (const region of claimed) {
          expect(polygonsOverlap(pier.footprint, region)).toBe(false);
        }
        // 橋と非重複
        for (const bridge of model.water.bridges) {
          const bf = { x: Math.cos(bridge.angle), z: Math.sin(bridge.angle) };
          const bs = { x: -bf.z, z: bf.x };
          const rect = [
            { x: bridge.position.x + bs.x * (bridge.width / 2) + bf.x * (bridge.length / 2), z: bridge.position.z + bs.z * (bridge.width / 2) + bf.z * (bridge.length / 2) },
            { x: bridge.position.x - bs.x * (bridge.width / 2) + bf.x * (bridge.length / 2), z: bridge.position.z - bs.z * (bridge.width / 2) + bf.z * (bridge.length / 2) },
            { x: bridge.position.x - bs.x * (bridge.width / 2) - bf.x * (bridge.length / 2), z: bridge.position.z - bs.z * (bridge.width / 2) - bf.z * (bridge.length / 2) },
            { x: bridge.position.x + bs.x * (bridge.width / 2) - bf.x * (bridge.length / 2), z: bridge.position.z + bs.z * (bridge.width / 2) - bf.z * (bridge.length / 2) },
          ];
          expect(polygonsOverlap(pier.footprint, rect)).toBe(false);
        }
        // 水路と非重複(footprint 頂点が水路の水面に入らない)
        for (const canal of model.water.canals) {
          for (const v of pier.footprint) {
            expect(
              distToPolyline(v.x, v.z, canal.points) - canal.width / 2,
            ).toBeGreaterThan(0);
          }
        }
        // 他の建物・区画と重ならない(汎用クリアランスの検算)
        for (const parcel of model.parcels) {
          expect(polygonsOverlap(pier.footprint, parcel.polygon)).toBe(false);
        }
      }
      // 桟橋どうしのアンカー間隔 ≥ 8.0(アンカー = footprint 重心 +
      // 陸方向 × (長さ/2 − 1.0)。契約「pier(桟橋)」実装補足の測点)
      const anchors = piers.map((pier) => {
        const f = { x: Math.cos(pier.facing), z: Math.sin(pier.facing) };
        const c = {
          x: pier.footprint.reduce((a, v) => a + v.x, 0) / pier.footprint.length,
          z: pier.footprint.reduce((a, v) => a + v.z, 0) / pier.footprint.length,
        };
        let eMin = Infinity;
        let eMax = -Infinity;
        for (const v of pier.footprint) {
          const e = (v.x - c.x) * f.x + (v.z - c.z) * f.z;
          eMin = Math.min(eMin, e);
          eMax = Math.max(eMax, e);
        }
        const halfLen = (eMax - eMin) / 2;
        return {
          x: c.x - f.x * (halfLen - 1.0),
          z: c.z - f.z * (halfLen - 1.0),
        };
      });
      for (let i = 0; i < anchors.length; i++) {
        for (let j = i + 1; j < anchors.length; j++) {
          expect(
            Math.hypot(
              anchors[i]!.x - anchors[j]!.x,
              anchors[i]!.z - anchors[j]!.z,
            ),
          ).toBeGreaterThanOrEqual(8.0 - 1e-6);
        }
      }
    });
  }

  it("pier: water 0(汀線なし)では 0 基", () => {
    const model = cached("everdusk-101", { water: 0 });
    expect(model.facilities.filter((f) => f.kind === "pier").length).toBe(0);
  });

  it("pier: 決定性(同一 seed・params で完全一致)", () => {
    const a = build("harbor-2", { water: 90 });
    const b = build("harbor-2", { water: 90 });
    expect(JSON.stringify(a.facilities)).toBe(JSON.stringify(b.facilities));
  });
});
