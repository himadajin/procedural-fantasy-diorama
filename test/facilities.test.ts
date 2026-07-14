/**
 * 段14「施設」(Phase D タスク D2b: field / pasture)のテスト。
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
import { polygonSignedDistance } from "../src/model/waterfield";
import { ensureClockwise } from "../src/model/geometry";
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
import { runLanes } from "../src/pipeline/lanes";
import {
  buildFarmlandFacility,
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

/** 部品の回転込みの xz 4 隅(帯検証と同じ保守的な見積もり) */
function partCorners(part: Part): { x: number; z: number }[] {
  const [px, , pz] = part.transform.position;
  const [sx, , sz] = part.transform.scale;
  const cos = Math.cos(part.transform.rotation);
  const sin = Math.sin(part.transform.rotation);
  const corners: { x: number; z: number }[] = [];
  for (const [lx, lz] of [
    [-sx / 2, -sz / 2],
    [sx / 2, -sz / 2],
    [sx / 2, sz / 2],
    [-sx / 2, sz / 2],
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
      expect(model.facilities.length).toBe(farmland.length);
      for (let i = 0; i < farmland.length; i++) {
        const parcel = farmland[i]!;
        const facility = model.facilities[i]!;
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
    const originIds = model.facilities.map(
      (f) => (f.origin as { type: "parcel"; parcelId: string }).parcelId,
    );
    expect(originIds).toEqual(farmlandIds);
  });

  it("settle 100(全面市街)では farmland も施設も 0 件", () => {
    const model = cached("everdusk-101", { settlement: 100 });
    expect(model.parcels.filter((p) => p.kind === "farmland").length).toBe(0);
    expect(model.facilities.length).toBe(0);
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
      // 幅 1.0 の畝(D1b: 少なく大きく)
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

    // 柵の高さの読み分け(D1b): pasture の柱は field より高い
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
