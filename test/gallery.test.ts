import { describe, expect, it } from "vitest";
import { DEFAULT_PARAMS, type BuildingRole, type Params } from "../src/model/worldmodel";
import { ZONE_COUNT, sampleZoneMask } from "../src/model/zonemask";
import { buildGalleryWorld, GALLERY_TARGET_IDS } from "../src/pipeline/gallery";
import { runPipeline } from "../src/pipeline/run";
import { hashWorldModel } from "../src/model/hash";

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

describe("gallery: 対象idの体系(契約「対象idの体系」)", () => {
  it("MVP の対象idは一般建物の全6 role(center を除く)", () => {
    expect([...GALLERY_TARGET_IDS].sort()).toEqual(
      ROLES.map(targetId).sort(),
    );
  });

  it("未知の対象idは例外を投げる", () => {
    expect(() =>
      buildGalleryWorld("building/center", "seed-x", {}),
    ).toThrow();
    expect(() => buildGalleryWorld("facility/well", "seed-x", {})).toThrow();
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
