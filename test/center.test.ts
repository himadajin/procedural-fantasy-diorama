/**
 * PHASE 5a commit 16: 中心建築の拡張文法のテスト。
 * 契約は docs/internal/contracts/worldmodel.md「中心建築(PHASE 5a commit 16)」
 * (スカイライン契約・4軸→骨格/装飾・発光の規律)、
 * 設計は implementation-spec 1.7節・PHASE 5a。
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PARAMS,
  FLOOR_HEIGHT,
  createEmptyWorldModel,
  type Building,
  type Params,
  type Part,
  type WorldModel,
} from "../src/model/worldmodel";
import { polygonArea, polygonSignedDistance } from "../src/model/waterfield";
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
import {
  CENTER_GLOW_SHARE,
  buildingTopY,
  glowPartArea,
  rankCenterAxes,
} from "../src/pipeline/center";

const SEEDS = ["everdusk-101", "seed-a", "seed-b"];

/** 中心建築の追加語彙+再利用語彙(contracts「PHASE 5a commit 16 の追加語彙」) */
const CENTER_PART_TYPES = new Set([
  "plinth",
  "wall",
  "gable",
  "hip",
  "window",
  "door",
  "chimney",
  "stair",
  "tower",
  "spire",
  "crystal",
  "glow-window",
  "sigil",
  "rose-window",
  "arch-window",
  "courtyard-wall",
]);
const GLOW_TYPES = new Set(["crystal", "sigil", "glow-window"]);

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

function center(model: WorldModel): Building {
  const b = model.buildings.find((x) => x.role === "center");
  if (!b) throw new Error("center building not found");
  return b;
}

function partsOf(b: Building, type: string): Part[] {
  return b.parts.filter((p) => p.type === type);
}

function peripheralTop(model: WorldModel): number {
  let top = 0;
  for (const b of model.buildings) {
    if (b.role !== "center") top = Math.max(top, buildingTopY(b));
  }
  return top;
}

/** 4類型の組み合わせ(implementation-spec PHASE 5a の完了条件) */
const ARCANE: Partial<Params> = { monumentality: 90, arcana: 90 };
const AUTHORITY: Partial<Params> = {
  monumentality: 90,
  arcana: 0,
  prosperity: 90,
};
const WATERSIDE: Partial<Params> = {
  monumentality: 60,
  water: 90,
  arcana: 0,
  prosperity: 30,
  settlement: 60,
};
const RUSTIC: Partial<Params> = { monumentality: 10, settlement: 10, arcana: 0 };

describe("center: 決定性", () => {
  it("同一 seed + params で中心建築(部品リスト込み)が完全一致する", () => {
    for (const seed of SEEDS) {
      const a = center(build(seed, ARCANE));
      const b = center(build(seed, ARCANE));
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    }
  });
});

describe("center: 基本契約(contracts「中心建築」)", () => {
  it("id / parcelId / role / footprint / floors / 語彙が契約どおり", () => {
    for (const seed of SEEDS) {
      for (const over of [{}, ARCANE, AUTHORITY, WATERSIDE, RUSTIC]) {
        const model = cached(seed, over);
        const b = center(model);
        expect(b.id).toBe("building/center");
        expect(b.parcelId).toBeNull();
        expect(b.facing).toBe(model.centerPlan.facing);
        expect([4, 6, 8]).toContain(b.footprint.length);
        expect(Number.isInteger(b.floors)).toBe(true);
        expect(b.floors).toBeGreaterThanOrEqual(1);
        expect(b.floors).toBeLessThanOrEqual(5);
        expect(b.roof.pitch).toBeGreaterThanOrEqual(50);
        expect(b.roof.pitch).toBeLessThanOrEqual(58);
        for (const p of b.parts) {
          expect(CENTER_PART_TYPES.has(p.type), `型 ${p.type}`).toBe(true);
        }
        // footprint は時計回り(shoelace 符号負)
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

  it("全部品が centerPlan.footprint 内に収まる(前庭階段込み)", () => {
    for (const seed of SEEDS) {
      for (const over of [ARCANE, AUTHORITY, RUSTIC]) {
        const model = cached(seed, over);
        const b = center(model);
        const foot = model.centerPlan.footprint;
        for (const p of b.parts) {
          const [px, , pz] = p.transform.position;
          const [sx, , sz] = p.transform.scale;
          const cos = Math.cos(p.transform.rotation);
          const sin = Math.sin(p.transform.rotation);
          for (const [lx, lz] of [
            [-0.5, -0.5],
            [0.5, -0.5],
            [0.5, 0.5],
            [-0.5, 0.5],
          ] as const) {
            const x = lx * sx;
            const z = lz * sz;
            const wx = px + x * cos + z * sin;
            const wz = pz - x * sin + z * cos;
            // 軒・張り出しぶんのわずかな超過のみ許す
            expect(
              polygonSignedDistance(wx, wz, foot),
              `seed=${seed} type=${p.type}`,
            ).toBeLessThanOrEqual(0.9);
          }
        }
      }
    }
  });

  it("中庭(kind courtyard)は中心建築の footprint と重ならない", () => {
    let courtyards = 0;
    for (const seed of SEEDS) {
      for (const over of [{}, ARCANE, AUTHORITY, WATERSIDE, RUSTIC]) {
        const model = cached(seed, over);
        const b = center(model);
        for (const plaza of model.plazas) {
          if (plaza.kind !== "courtyard") continue;
          courtyards++;
          expect(plaza.id).toBe("plaza/courtyard");
          expect(polygonsOverlap(plaza.polygon, b.footprint)).toBe(false);
        }
      }
    }
    // 中庭が空検証にならない(規模の大きい類型では現れる)
    expect(courtyards).toBeGreaterThan(0);
  });
});

describe("center: スカイライン契約(周辺最高点 × skylineRatio)", () => {
  it("Monumentality 30/75/95 と各類型で中心最高点が契約を満たす", () => {
    for (const seed of SEEDS) {
      for (const over of [
        {},
        { monumentality: 30 },
        { monumentality: 75 },
        { monumentality: 95 },
        ARCANE,
        AUTHORITY,
        WATERSIDE,
        RUSTIC,
      ] as Partial<Params>[]) {
        const model = cached(seed, over);
        const ratio = model.meta.derived.skylineRatio;
        const required = peripheralTop(model) * ratio;
        expect(
          buildingTopY(center(model)),
          `seed=${seed} over=${JSON.stringify(over)}`,
        ).toBeGreaterThanOrEqual(required - 1e-6);
      }
    }
  });

  it("Monumentality 30 → 95 で footprint の規模が広がる", () => {
    for (const seed of SEEDS) {
      const small = Math.abs(
        polygonArea(center(cached(seed, { monumentality: 30 })).footprint),
      );
      const large = Math.abs(
        polygonArea(center(cached(seed, { monumentality: 95 })).footprint),
      );
      expect(small).toBeLessThan(large);
    }
  });
});

describe("center: 4軸の組み合わせ分岐(implementation-spec 1.7節・PHASE 5a)", () => {
  it("(Mon高, Arc高) → 魔導系: 支配軸 arcane、水晶+細長い主塔+発光開口+紋様", () => {
    for (const seed of SEEDS) {
      const model = cached(seed, ARCANE);
      const b = center(model);
      expect(rankCenterAxes(model.centerPlan.axes).dominant).toBe("arcane");
      expect(partsOf(b, "crystal").length).toBeGreaterThanOrEqual(1);
      expect(partsOf(b, "glow-window").length).toBeGreaterThanOrEqual(1);
      expect(partsOf(b, "sigil").length).toBeGreaterThanOrEqual(1);
      // 主塔は細長い(様式言語: 高さ / 幅 ≥ 5)
      const towers = partsOf(b, "tower");
      expect(towers.length).toBeGreaterThanOrEqual(1);
      const tallest = towers.reduce((a, t) =>
        t.transform.scale[1] > a.transform.scale[1] ? t : a,
      );
      expect(
        tallest.transform.scale[1] / tallest.transform.scale[0],
      ).toBeGreaterThanOrEqual(5);
      // 素材は石造系+スレート(契約の表)
      expect(["stone", "ashlar"]).toContain(b.materials.wall);
      expect(b.materials.roof).toBe("slate");
    }
  });

  it("(Mon高, Arc低, Pro高) → 権威系: 支配軸 authority、双塔+尖塔+大型開口、発光なし", () => {
    for (const seed of SEEDS) {
      const model = cached(seed, AUTHORITY);
      const b = center(model);
      expect(rankCenterAxes(model.centerPlan.axes).dominant).toBe("authority");
      expect(partsOf(b, "tower").length).toBeGreaterThanOrEqual(2);
      expect(partsOf(b, "spire").length).toBeGreaterThanOrEqual(2);
      // 大型開口(薔薇窓または尖頭窓)が整列して現れる
      const bigOpenings =
        partsOf(b, "rose-window").length + partsOf(b, "arch-window").length;
      expect(bigOpenings).toBeGreaterThanOrEqual(2);
      // 2位軸が arcane にならない設定のため発光部品は持たない
      expect(b.parts.filter((p) => GLOW_TYPES.has(p.type)).length).toBe(0);
      expect(b.materials.wall).toBe("ashlar");
      expect(b.materials.roof).toBe("slate");
    }
  });

  it("(Mon中, Water高) → 水辺系: 支配軸 waterside、館+塔(瓦屋根)", () => {
    for (const seed of SEEDS) {
      const model = cached(seed, WATERSIDE);
      const b = center(model);
      expect(rankCenterAxes(model.centerPlan.axes).dominant).toBe("waterside");
      expect(partsOf(b, "tower").length).toBeGreaterThanOrEqual(1);
      expect(partsOf(b, "spire").length).toBeGreaterThanOrEqual(1);
      expect(b.materials.wall).toBe("stone");
      expect(b.materials.roof).toBe("tile");
    }
  });

  it("(Mon低, Set低) → 素朴系: 支配軸 rustic、大農家+物見塔(木造)", () => {
    for (const seed of SEEDS) {
      const model = cached(seed, RUSTIC);
      const b = center(model);
      expect(rankCenterAxes(model.centerPlan.axes).dominant).toBe("rustic");
      expect(b.floors).toBeLessThanOrEqual(2);
      expect(["rough-wood", "plaster"]).toContain(b.materials.wall);
      expect(["thatch", "shingle"]).toContain(b.materials.roof);
      // 物見塔(木造)+ 尖り屋根
      const towers = partsOf(b, "tower");
      expect(towers.some((t) => t.materialId === "rough-wood")).toBe(true);
      expect(partsOf(b, "spire").length).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("center: 発光の規律(art-direction 5.4節)", () => {
  it("発光面積の合計が glowAreaCap × 箱庭面積 × 中心の取り分以下", () => {
    for (const seed of SEEDS) {
      for (const over of [
        ARCANE,
        { monumentality: 100, arcana: 100 },
      ] as Partial<Params>[]) {
        const model = cached(seed, over);
        const b = center(model);
        let area = 0;
        for (const p of b.parts) area += glowPartArea(p);
        expect(area).toBeGreaterThan(0);
        const budget =
          Math.abs(polygonArea(model.ground.boundary)) *
          model.meta.derived.glowAreaCap *
          CENTER_GLOW_SHARE;
        expect(area).toBeLessThanOrEqual(budget + 1e-6);
      }
    }
  });

  it("発光開口の寸法は 1 階高の 1/3 以下、水晶は幅 1.0 以下の細身", () => {
    for (const seed of SEEDS) {
      const b = center(cached(seed, { monumentality: 100, arcana: 100 }));
      const capped = FLOOR_HEIGHT / 3;
      for (const p of partsOf(b, "glow-window")) {
        // 発光面 = 開口 − 枠(0.13 × 2)。開口自体を 1 階高の 1/3 に抑える
        expect(p.transform.scale[0]).toBeLessThanOrEqual(capped + 2 * 0.13 + 1e-6);
        expect(p.transform.scale[1]).toBeLessThanOrEqual(capped + 2 * 0.13 + 1e-6);
      }
      for (const p of partsOf(b, "crystal")) {
        expect(p.transform.scale[0]).toBeLessThanOrEqual(1.0 + 1e-6);
        expect(p.transform.scale[2]).toBeLessThanOrEqual(1.0 + 1e-6);
      }
    }
  });

  it("Arcana 低(権威・素朴系)では発光部品が存在しない(発光は魔法のみ)", () => {
    for (const seed of SEEDS) {
      for (const over of [AUTHORITY, RUSTIC]) {
        const b = center(cached(seed, over));
        expect(b.parts.filter((p) => GLOW_TYPES.has(p.type)).length).toBe(0);
      }
    }
  });
});
