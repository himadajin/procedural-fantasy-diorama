import { describe, expect, it } from "vitest";
import { DEFAULT_PARAMS, type BuildingRole, type Params } from "../src/model/worldmodel";
import { ZONE_COUNT, sampleZoneMask } from "../src/model/zonemask";
import { buildGalleryWorld, GALLERY_TARGET_IDS } from "../src/pipeline/gallery";
import { runPipeline } from "../src/pipeline/run";
import { hashWorldModel } from "../src/model/hash";
import { polygonSignedDistance } from "../src/model/waterfield";

const ROLES = [
  "house",
  "waterside",
  "bridgehead",
  "hall",
  "warehouse",
  "outskirt",
] as const satisfies readonly BuildingRole[];

function targetId(role: (typeof ROLES)[number]): string {
  return `building/${role}`;
}

/** Phase D タスク D2b で対象化した farmland 施設 kind */
const FACILITY_TARGETS = ["facility/field", "facility/pasture"] as const;
/** Phase D タスク D3 で対象化した広場施設 kind */
const PLAZA_FACILITY_TARGETS = ["facility/well", "facility/stall"] as const;
/** Phase D タスク D4 で対象化した施設 kind */
const MILL_FACILITY_TARGETS = [
  "facility/windmill",
  "facility/watermill",
] as const;
/** Phase D タスク D5 で対象化した施設 kind */
const PIER_FACILITY_TARGETS = ["facility/pier"] as const;

describe("gallery: 対象idの体系(契約「対象idの体系」)", () => {
  it("対象idは一般建物の全6 role(center を除く)+ 施設の全 7 kind(D5 時点)", () => {
    expect([...GALLERY_TARGET_IDS].sort()).toEqual(
      [
        ...ROLES.map(targetId),
        ...FACILITY_TARGETS,
        ...PLAZA_FACILITY_TARGETS,
        ...MILL_FACILITY_TARGETS,
        ...PIER_FACILITY_TARGETS,
      ].sort(),
    );
  });

  it("未知の対象idは例外を投げる", () => {
    expect(() =>
      buildGalleryWorld("building/center", "seed-x", {}),
    ).toThrow();
    expect(() => buildGalleryWorld("facility/unknown", "seed-x", {})).toThrow();
  });
});

describe("gallery: 決定性(同一入力2回で完全一致。3.6節)", () => {
  for (const role of ROLES) {
    it(`${role}: 同一 seed + params で2回生成してハッシュ・内容が完全一致する`, () => {
      const a = buildGalleryWorld(targetId(role), "everdusk-101", {
        prosperity: 62,
      });
      const b = buildGalleryWorld(targetId(role), "everdusk-101", {
        prosperity: 62,
      });
      expect(a.summary.hash).toBe(b.summary.hash);
      expect(a.summary.hash).toMatch(/^[0-9a-f]{8}$/);
      expect(hashWorldModel(a)).toBe(a.summary.hash);
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    });
  }
});

describe("gallery: スモーク(対象1体・parts 非空・footprint が区画内)", () => {
  for (const role of ROLES) {
    it(`${role}: 対象1体が role どおりに生成され、footprint・parts が妥当`, () => {
      const model = buildGalleryWorld(targetId(role), "everdusk-101", {});
      expect(model.buildings.length).toBe(1);
      const building = model.buildings[0];
      expect(building).toBeDefined();
      if (!building) return;
      expect(building.role).toBe(role);
      expect(building.parts.length).toBeGreaterThan(0);
      expect(building.floors).toBeGreaterThanOrEqual(1);
      expect(building.materials.wall).not.toBe("");
      expect(building.materials.roof).not.toBe("");
      expect(building.footprint.length).toBeGreaterThanOrEqual(4);

      // 区画(間口18・奥行き20。実装詳細だがスモークとして妥当性を確認)内。
      // セットバックにより区画よりわずかに小さいはずだが、揺らぎ(±0.5)・
      // waterside の水上張り出し(最大7.0)を許容する
      const parcel = model.parcels[0];
      expect(parcel).toBeDefined();
      for (const v of building.footprint) {
        expect(Number.isFinite(v.x)).toBe(true);
        expect(Number.isFinite(v.z)).toBe(true);
        expect(v.x).toBeGreaterThanOrEqual(-9 - 8);
        expect(v.x).toBeLessThanOrEqual(9 + 8);
        expect(v.z).toBeGreaterThanOrEqual(-1);
        expect(v.z).toBeLessThanOrEqual(20 + 8);
      }

      if (role === "waterside") {
        // waterside は水上張り出し・杭/石基礎(本番の buildParcelBuilding の
        // 水面探索が機能している=対象生成の目的が達成されていることの検証)
        expect(model.water.ponds.length).toBe(1);
        expect(building.foundation.overWater).toBe(true);
        expect(["piles", "stonebase"]).toContain(building.foundation.kind);
      } else {
        expect(model.water.ponds.length).toBe(0);
      }
    });
  }

  it("WorldModel は three 非依存の純データ(型のみの確認): summary の主要フィールドが妥当", () => {
    const model = buildGalleryWorld("building/hall", "everdusk-101", {});
    expect(model.summary.buildingCounts["hall"]).toBe(1);
    expect(model.meta.seed).toBe("everdusk-101");
    expect(model.meta.params.prosperity).toBe(DEFAULT_PARAMS.prosperity);
  });
});

describe("gallery: zoneMask の非退化(G1b 再発防止。契約「極小ワールドの合成規約」)", () => {
  // G1 の実バグ: ground.zoneMask が createEmptyWorldModel の初期値
  // (createZoneMask(0, 0))のまま返され、mesh/build.ts のサンプリング
  // (zoneColorAt / sampleZoneMask)が cellSize=0 で退化して地面が全対象で
  // 真っ黒に描画された。pipeline 境界(three 非依存)の範囲で、mesh 側が
  // 使うサンプリングの正(model/zonemask.ts の sampleZoneMask)が健全に
  // 動く状態であることを検証する。
  for (const role of ROLES) {
    it(`${role}: ground.zoneMask が退化していない(cellSize > 0・データ非空・実寸整合)`, () => {
      const model = buildGalleryWorld(targetId(role), "everdusk-101", {});
      const mask = model.ground.zoneMask;
      expect(mask.resolution).toBeGreaterThan(0);
      expect(mask.cellSize).toBeGreaterThan(0);
      const cells = mask.resolution * mask.resolution;
      expect(mask.weights.length).toBe(cells * ZONE_COUNT);
      expect(mask.brightness.length).toBe(cells);
      // マスクの覆う実寸が地面の実寸と一致する(mesh 側のワールド座標
      // サンプリングが地面全域で有効)
      expect(mask.resolution * mask.cellSize).toBeCloseTo(model.ground.size, 6);
    });
  }

  it("mesh 側のサンプリングの正(sampleZoneMask)が区画中心で健全な値を返す", () => {
    const model = buildGalleryWorld("building/house", "everdusk-101", {});
    const parcel = model.parcels[0];
    expect(parcel).toBeDefined();
    if (!parcel) return;
    let cx = 0;
    let cz = 0;
    for (const v of parcel.polygon) {
      cx += v.x;
      cz += v.z;
    }
    cx /= parcel.polygon.length;
    cz /= parcel.polygon.length;
    const sample = sampleZoneMask(model.ground.zoneMask, cx, cz);
    // 草地ベース+土の斑の下地(段2 と同じ generateZoneMask): 材質重みの
    // 合計が正で、明度ムラが ±8% の帯域内(art-direction 5.2節)
    const total = sample.weights.reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(0);
    expect(sample.brightness).toBeGreaterThanOrEqual(0.92 - 1e-9);
    expect(sample.brightness).toBeLessThanOrEqual(1.08 + 1e-9);
  });
});

describe("gallery: 自明でない生成(seed・params で結果が変わる)", () => {
  it("seed を変えるとハッシュが変わる(house)", () => {
    const a = buildGalleryWorld("building/house", "everdusk-101", {});
    const b = buildGalleryWorld("building/house", "seed-b", {});
    expect(a.summary.hash).not.toBe(b.summary.hash);
  });

  it("造形に効くパラメータ(prosperity)を変えるとハッシュが変わる(house)", () => {
    const a = buildGalleryWorld("building/house", "everdusk-101", {
      prosperity: 10,
    });
    const b = buildGalleryWorld("building/house", "everdusk-101", {
      prosperity: 90,
    });
    expect(a.summary.hash).not.toBe(b.summary.hash);
  });

  it("省略項目は既定値50を補う(design.md)", () => {
    const withDefault = buildGalleryWorld("building/house", "everdusk-101", {});
    const explicit50: Params = { ...DEFAULT_PARAMS };
    const withExplicit = buildGalleryWorld(
      "building/house",
      "everdusk-101",
      explicit50,
    );
    expect(withDefault.summary.hash).toBe(withExplicit.summary.hash);
  });
});

describe("gallery: 施設対象(facility/field・facility/pasture。Phase D D2b)", () => {
  for (const id of FACILITY_TARGETS) {
    const kind = id.split("/")[1] as "field" | "pasture";
    it(`${id}: 同一入力2回で完全一致し、kind どおりの施設1件が生成される`, () => {
      const a = buildGalleryWorld(id, "everdusk-101", {});
      const b = buildGalleryWorld(id, "everdusk-101", {});
      expect(a.summary.hash).toBe(b.summary.hash);
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));

      expect(a.buildings.length).toBe(0);
      expect(a.facilities.length).toBe(1);
      const facility = a.facilities[0];
      expect(facility).toBeDefined();
      if (!facility) return;
      expect(facility.kind).toBe(kind);
      expect(facility.parts.length).toBeGreaterThan(0);
      expect(facility.origin).toEqual({
        type: "parcel",
        parcelId: "parcel/gallery/L/farm0",
      });
      // footprint は農地区画そのもの(契約: 区画 = 施設の帰属領域)
      const parcel = a.parcels[0];
      expect(parcel).toBeDefined();
      if (!parcel) return;
      expect(parcel.kind).toBe("farmland");
      expect(facility.footprint).toEqual(parcel.polygon);
    });

    it(`${id}: seed を変えるとハッシュが変わる`, () => {
      const a = buildGalleryWorld(id, "everdusk-101", {});
      const b = buildGalleryWorld(id, "seed-b", {});
      expect(a.summary.hash).not.toBe(b.summary.hash);
    });
  }

  it("field は畝(ground-patch)の列、pasture は単一パッチ+横木2本の柵(D1b 造形)", () => {
    const field = buildGalleryWorld("facility/field", "everdusk-101", {})
      .facilities[0]!;
    const pasture = buildGalleryWorld("facility/pasture", "everdusk-101", {})
      .facilities[0]!;
    const patches = (parts: typeof field.parts): typeof field.parts =>
      parts.filter((p) => p.type === "ground-patch");
    // field: 基盤 1 + 畝 N(≥ 2)。畝は params.top を持つ
    expect(patches(field.parts).length).toBeGreaterThan(2);
    expect(
      patches(field.parts).filter((p) => p.params?.top !== undefined).length,
    ).toBeGreaterThan(1);
    // pasture: パッチはちょうど 1(牧草)
    expect(patches(pasture.parts).length).toBe(1);
    expect(patches(pasture.parts)[0]?.materialId).toBe("meadow");
    // 柵はどちらも beam(木)のみで構成される
    for (const f of [field, pasture]) {
      for (const p of f.parts) {
        expect(["ground-patch", "beam"]).toContain(p.type);
        if (p.type === "beam") expect(p.materialId).toBe("wood");
      }
    }
  });
});

describe("gallery: 広場施設対象(facility/well・facility/stall。Phase D D3)", () => {
  for (const id of PLAZA_FACILITY_TARGETS) {
    it(`${id}: 同一入力2回で完全一致する`, () => {
      const a = buildGalleryWorld(id, "everdusk-101", {});
      const b = buildGalleryWorld(id, "everdusk-101", {});
      expect(a.summary.hash).toBe(b.summary.hash);
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    });

    it(`${id}: seed を変えるとハッシュが変わる`, () => {
      const a = buildGalleryWorld(id, "everdusk-101", {});
      const b = buildGalleryWorld(id, "seed-b", {});
      expect(a.summary.hash).not.toBe(b.summary.hash);
    });
  }

  it("well: 広場 1 枚に井戸 1 基(採否強制)。footprint は広場 polygon 内", () => {
    const model = buildGalleryWorld("facility/well", "everdusk-101", {});
    expect(model.buildings.length).toBe(0);
    expect(model.facilities.length).toBe(1);
    const well = model.facilities[0]!;
    expect(well.kind).toBe("well");
    expect(well.origin).toEqual({ type: "plaza", plazaId: "plaza/gallery" });
    // 造形(D1b): 石環 fence×4 + 内面 + 柱2 + 轆轤 + 小屋根
    const types = well.parts.map((p) => p.type);
    expect(types.filter((t) => t === "fence").length).toBe(4);
    expect(types.filter((t) => t === "beam").length).toBe(3);
    expect(types.filter((t) => t === "gable").length).toBe(1);
    expect(types.filter((t) => t === "ground-patch").length).toBe(1);
    const plaza = model.plazas[0]!;
    for (const v of well.footprint) {
      expect(polygonSignedDistance(v.x, v.z, plaza.polygon)).toBeLessThan(0);
    }
  });

  it("stall: 広場の縁帯に列(prosper 駆動)。全コーナーが広場内・天幕は3色の語彙", () => {
    const model = buildGalleryWorld("facility/stall", "everdusk-101", {
      prosperity: 100,
    });
    expect(model.facilities.length).toBeGreaterThanOrEqual(3);
    const plaza = model.plazas[0]!;
    const awnings = new Set<string>();
    for (const stall of model.facilities) {
      expect(stall.kind).toBe("stall");
      const canopy = stall.parts.find((p) => p.type === "canopy");
      expect(canopy).toBeDefined();
      if (canopy) awnings.add(canopy.materialId);
      for (const v of stall.footprint) {
        expect(polygonSignedDistance(v.x, v.z, plaza.polygon)).toBeLessThan(0);
      }
      // 縁帯(広場縁から 1.0〜2.5)に立つ
      let cx = 0;
      let cz = 0;
      for (const v of stall.footprint) {
        cx += v.x;
        cz += v.z;
      }
      cx /= stall.footprint.length;
      cz /= stall.footprint.length;
      const edge = -polygonSignedDistance(cx, cz, plaza.polygon);
      expect(edge).toBeGreaterThanOrEqual(1.0 - 1e-9);
      expect(edge).toBeLessThanOrEqual(2.5 + 1e-9);
    }
    for (const id of awnings) {
      expect(["canvas", "awning-madder", "awning-slate"]).toContain(id);
    }
  });

  it("stall: prosperity が屋台の数を駆動する", () => {
    const low = buildGalleryWorld("facility/stall", "everdusk-101", {
      prosperity: 0,
    });
    const high = buildGalleryWorld("facility/stall", "everdusk-101", {
      prosperity: 100,
    });
    expect(high.facilities.length).toBeGreaterThan(low.facilities.length);
  });
});

describe("gallery: 風車・水車対象(facility/windmill・facility/watermill。Phase D D4)", () => {
  for (const id of MILL_FACILITY_TARGETS) {
    it(`${id}: 同一入力2回で完全一致し、seed でハッシュが変わる`, () => {
      const a = buildGalleryWorld(id, "everdusk-101", {});
      const b = buildGalleryWorld(id, "everdusk-101", {});
      expect(a.summary.hash).toBe(b.summary.hash);
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
      const c = buildGalleryWorld(id, "seed-b", {});
      expect(c.summary.hash).not.toBe(a.summary.hash);
    });
  }

  it("windmill: 塔 + キャップ + ロータ(4 枚羽根・静的 phase)+ 扉・窓(D1b 造形)", () => {
    const model = buildGalleryWorld("facility/windmill", "everdusk-101", {});
    expect(model.facilities.length).toBe(1);
    const windmill = model.facilities[0]!;
    expect(windmill.kind).toBe("windmill");
    const types = windmill.parts.map((p) => p.type);
    expect(types).toEqual(["tower", "gable", "windmill-rotor", "door", "window"]);
    const rotor = windmill.parts.find((p) => p.type === "windmill-rotor")!;
    expect(rotor.params?.blades).toBe(4);
    expect(rotor.params?.phase).toBeGreaterThanOrEqual(0);
    expect(rotor.params?.phase).toBeLessThanOrEqual(Math.PI / 2);
    // ロータ直径 = 塔高の約 1.2 倍の誇張(D1b。±8% 揺らぎ込みの帯)
    const dia = rotor.transform.scale[0];
    expect(dia).toBeGreaterThanOrEqual(9.0 * 0.92 - 1e-9);
    expect(dia).toBeLessThanOrEqual(9.0 * 1.08 + 1e-9);
    // footprint 長軸 = 直径 + 0.6(ロータ掃引域込み)
    let maxSpan = 0;
    for (const a of windmill.footprint) {
      for (const b of windmill.footprint) {
        maxSpan = Math.max(maxSpan, Math.hypot(a.x - b.x, a.z - b.z));
      }
    }
    expect(maxSpan).toBeGreaterThan(dia);
  });

  it("watermill: 小屋 + 軸 + 水輪(下端が水面下)。footprint 頂点は陸上(D1a 水域例外)", () => {
    const model = buildGalleryWorld("facility/watermill", "everdusk-101", {});
    expect(model.facilities.length).toBe(1);
    const mill = model.facilities[0]!;
    expect(mill.kind).toBe("watermill");
    const types = mill.parts.map((p) => p.type);
    expect(types).toEqual([
      "plinth",
      "wall",
      "gable",
      "door",
      "window",
      "beam",
      "water-wheel",
    ]);
    const wheel = mill.parts.find((p) => p.type === "water-wheel")!;
    expect(wheel.materialId).toBe("wet-wood");
    expect(wheel.params?.paddles).toBe(8);
    // 軸 y 0.70・下端 = 0.70 − 直径/2 が水面(−0.6)より下
    const axleY = wheel.transform.position[1];
    const dia = wheel.transform.scale[1];
    expect(axleY).toBeCloseTo(0.7, 6);
    expect(axleY - dia / 2).toBeLessThan(-0.6);
    // footprint(小屋)は全頂点が陸上 = 池の外
    const pond = model.water.ponds[0]!;
    for (const v of mill.footprint) {
      expect(polygonSignedDistance(v.x, v.z, pond)).toBeGreaterThanOrEqual(
        -1e-9,
      );
    }
  });
});

describe("gallery: 桟橋対象(facility/pier。Phase D D5)", () => {
  it("pier: 同一入力2回で完全一致し、seed でハッシュが変わる", () => {
    const a = buildGalleryWorld("facility/pier", "everdusk-101", {});
    const b = buildGalleryWorld("facility/pier", "everdusk-101", {});
    expect(a.summary.hash).toBe(b.summary.hash);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const c = buildGalleryWorld("facility/pier", "seed-b", {});
    expect(c.summary.hash).not.toBe(a.summary.hash);
  });

  it("pier: 板 1 + 杭のみの構成。天端 0.35・先端が池の上に突き出す(D1b 造形)", () => {
    const model = buildGalleryWorld("facility/pier", "everdusk-101", {});
    expect(model.facilities.length).toBe(1);
    const pier = model.facilities[0]!;
    expect(pier.kind).toBe("pier");
    const decks = pier.parts.filter((p) => p.type === "deck");
    const piles = pier.parts.filter((p) => p.type === "pile");
    expect(decks.length).toBe(1);
    expect(piles.length).toBeGreaterThanOrEqual(4);
    expect(decks.length + piles.length).toBe(pier.parts.length);
    const deck = decks[0]!;
    expect(deck.materialId).toBe("rough-wood");
    // 天端 y 0.35(地面 0 と水面 −0.6 の間 = 建物デッキより低い)
    expect(deck.transform.position[1] + deck.transform.scale[1]).toBeCloseTo(
      0.35,
      6,
    );
    // 先端側の footprint 頂点が池の上(facing = −z = 池側)
    const pond = model.water.ponds[0]!;
    const overWater = pier.footprint.filter(
      (v) => polygonSignedDistance(v.x, v.z, pond) < 0,
    );
    expect(overWater.length).toBeGreaterThanOrEqual(2);
    // 杭は水底(y −1.6)から立つ
    for (const pile of piles) {
      expect(pile.transform.position[1]).toBeCloseTo(-1.6, 6);
    }
  });
});

describe("gallery: 既存ワールド生成(runPipeline)への影響ゼロ(3.6節)", () => {
  it("ギャラリー生成を挟んでも runPipeline の結果は不変(消費列・出力を共有しない)", async () => {
    const before = await runPipeline("everdusk-101", DEFAULT_PARAMS);
    // ギャラリーを複数 role・複数 seed で生成する(runPipeline のグローバル
    // 状態や乱数ストリームに副作用が無いことの確認)
    for (const role of ROLES) {
      buildGalleryWorld(targetId(role), "everdusk-101", {});
      buildGalleryWorld(targetId(role), "unrelated-seed", { water: 80 });
    }
    const after = await runPipeline("everdusk-101", DEFAULT_PARAMS);
    expect(after.summary.hash).toBe(before.summary.hash);
  });
});
