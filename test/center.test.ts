/**
 * 中心建築(建築群)の拡張文法のテスト。
 * 契約は docs/internal/contracts/buildings.md「中心建築」
 * (スカイライン契約・4軸→敷地計画の型/装飾・発光の規律・建築群の 4 原則)、
 * 設計は implementation-spec 1.7節。
 */
import { describe, expect, it } from "vitest";
import {
  FLOOR_HEIGHT,
  type Building,
  type Params,
  type Part,
  type WorldModel,
} from "../src/model/worldmodel";
import { polygonArea, polygonSignedDistance } from "../src/model/waterfield";
import { polygonsOverlap } from "../src/model/geometry";
import { runBuildings } from "../src/pipeline/buildings";
import {
  CENTER_GLOW_SHARE,
  buildingTopY,
  glowPartArea,
  rankCenterAxes,
} from "../src/pipeline/center";
import { buildUpTo, makeCached } from "./helpers";

const SEEDS = ["everdusk-101", "seed-a", "seed-b"];

/** 中心建築の追加語彙+再利用語彙(contracts/buildings.md「中心建築」・
 *  「Phase E の追加語彙」) */
const CENTER_PART_TYPES = new Set([
  "plinth",
  "wall",
  "gable",
  "hip",
  "window",
  "door",
  "chimney",
  "stair",
  "beam",
  "fence",
  "tower",
  "spire",
  "crystal",
  "glow-window",
  "sigil",
  "rose-window",
  "arch-window",
  "courtyard-wall",
  "arch",
  "battlement",
  "lean-to",
]);
const GLOW_TYPES = new Set(["crystal", "sigil", "glow-window"]);

function build(seed: string, over: Partial<Params> = {}): WorldModel {
  return buildUpTo(runBuildings, seed, over);
}

const cached = makeCached(build);

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

/** 4類型の組み合わせ(implementation-spec「中心建築」節の完了条件) */
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
  it("id / parcelId / role / footprint / floors / roof / 語彙が契約どおり", () => {
    for (const seed of SEEDS) {
      for (const over of [{}, ARCANE, AUTHORITY, WATERSIDE, RUSTIC]) {
        const model = cached(seed, over);
        const b = center(model);
        expect(b.id).toBe("building/center");
        expect(b.parcelId).toBeNull();
        expect(b.facing).toBe(model.centerPlan.facing);
        // footprint は群の外郭 = 使用領域の矩形(4 頂点。Phase E)
        expect(b.footprint.length).toBe(4);
        expect(Number.isInteger(b.floors)).toBe(true);
        expect(b.floors).toBeGreaterThanOrEqual(2);
        expect(b.floors).toBeLessThanOrEqual(4);
        // roof.type は "compound" 固定(群。Phase E)
        expect(b.roof.type).toBe("compound");
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

  it("建築群の骨格: 囲い・主館・アクセント塔が常にある(4 原則)", () => {
    for (const seed of SEEDS) {
      for (const over of [{}, ARCANE, AUTHORITY, WATERSIDE, RUSTIC]) {
        const b = center(cached(seed, over));
        // 囲い(courtyard-wall または fence)のセグメントが複数
        const enclosure =
          partsOf(b, "courtyard-wall").length + partsOf(b, "fence").length;
        expect(enclosure, `seed=${seed}`).toBeGreaterThanOrEqual(3);
        // 主館(壁×2 階以上)と屋根
        expect(partsOf(b, "wall").length).toBeGreaterThanOrEqual(2);
        expect(
          partsOf(b, "gable").length + partsOf(b, "hip").length,
        ).toBeGreaterThanOrEqual(1);
        // アクセント塔の段構成(基部・胴・望楼で tower ≥ 3)
        expect(partsOf(b, "tower").length).toBeGreaterThanOrEqual(3);
        // 正面の大扉+前庭階段
        expect(partsOf(b, "door").length).toBeGreaterThanOrEqual(1);
        expect(partsOf(b, "stair").length).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it("中庭 Plaza は中心建築の群外郭の内側にあり、id が契約どおり", () => {
    let courtyards = 0;
    for (const seed of [...SEEDS, "seed-c", "harbor-1"]) {
      for (const over of [{}, ARCANE, AUTHORITY, WATERSIDE, RUSTIC]) {
        const model = cached(seed, over);
        const b = center(model);
        for (const plaza of model.plazas) {
          if (plaza.kind !== "courtyard") continue;
          if (plaza.id.startsWith("plaza/courtyard/center/")) {
            // 中心建築の中庭は群外郭(footprint)の内側(Phase E)
            courtyards++;
            for (const v of plaza.polygon) {
              expect(
                polygonSignedDistance(v.x, v.z, b.footprint),
              ).toBeLessThanOrEqual(1e-6);
            }
          } else {
            // 一般建物の中庭型クラスタ(id 空間は接頭辞で分離。
            // network-plaza.md Plaza 節)。中心建築の外郭とは重ならない
            expect(plaza.id).toMatch(/^plaza\/courtyard\/block\//);
            expect(polygonsOverlap(plaza.polygon, b.footprint)).toBe(false);
          }
        }
      }
    }
    // 中庭が空検証にならない
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

  it("担い手はアクセント塔のみ: 屋根量塊の最高点は塔頂より明確に低い", () => {
    for (const seed of SEEDS) {
      for (const over of [ARCANE, AUTHORITY] as Partial<Params>[]) {
        const b = center(cached(seed, over));
        const top = buildingTopY(b);
        // 壁(量塊の躯体)の最高点は塔頂の 0.7 倍以下
        let wallTop = 0;
        for (const p of partsOf(b, "wall")) {
          wallTop = Math.max(
            wallTop,
            p.transform.position[1] + p.transform.scale[1],
          );
        }
        expect(wallTop).toBeLessThanOrEqual(top * 0.7);
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

describe("center: 4軸 → 敷地計画の型(contracts 4軸表)", () => {
  it("(Mon高, Arc高) → 聖域: 支配軸 arcane、水晶の鐘楼+発光開口+紋様", () => {
    for (const seed of SEEDS) {
      const model = cached(seed, ARCANE);
      const b = center(model);
      expect(rankCenterAxes(model.centerPlan.axes).dominant).toBe("arcane");
      expect(partsOf(b, "crystal").length).toBeGreaterThanOrEqual(1);
      expect(partsOf(b, "glow-window").length).toBeGreaterThanOrEqual(1);
      expect(partsOf(b, "sigil").length).toBeGreaterThanOrEqual(1);
      // 素材は石造系+スレート(契約の表)
      expect(["stone", "ashlar"]).toContain(b.materials.wall);
      expect(b.materials.roof).toBe("slate");
    }
  });

  it("(Mon高, Arc低, Pro高) → 城郭: 支配軸 authority、胸壁+門楼+尖塔群、発光なし", () => {
    for (const seed of SEEDS) {
      const model = cached(seed, AUTHORITY);
      const b = center(model);
      expect(rankCenterAxes(model.centerPlan.axes).dominant).toBe("authority");
      // 城郭の記号: 胸壁+門楼(アーチ)+隅塔・天守の尖塔
      expect(partsOf(b, "battlement").length).toBeGreaterThanOrEqual(1);
      expect(partsOf(b, "arch").length).toBeGreaterThanOrEqual(1);
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

  it("(Mon中, Water高) → 湖畔の荘園: 支配軸 waterside、館+塔(瓦屋根)", () => {
    for (const seed of SEEDS) {
      const model = cached(seed, WATERSIDE);
      const b = center(model);
      expect(rankCenterAxes(model.centerPlan.axes).dominant).toBe("waterside");
      expect(partsOf(b, "tower").length).toBeGreaterThanOrEqual(3);
      expect(partsOf(b, "spire").length).toBeGreaterThanOrEqual(1);
      expect(b.materials.wall).toBe("stone");
      expect(b.materials.roof).toBe("tile");
    }
  });

  it("(Mon低, Set低) → 農場屋敷: 支配軸 rustic、柵囲い+木の物見塔", () => {
    for (const seed of SEEDS) {
      const model = cached(seed, RUSTIC);
      const b = center(model);
      expect(rankCenterAxes(model.centerPlan.axes).dominant).toBe("rustic");
      expect(b.floors).toBeLessThanOrEqual(2);
      expect(["rough-wood", "plaster"]).toContain(b.materials.wall);
      expect(["thatch", "shingle"]).toContain(b.materials.roof);
      // 柵囲い(木部)
      expect(partsOf(b, "fence").length).toBeGreaterThanOrEqual(1);
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

  it("Arcana 低(城郭・農場屋敷)では発光部品が存在しない(発光は魔法のみ)", () => {
    for (const seed of SEEDS) {
      for (const over of [AUTHORITY, RUSTIC]) {
        const b = center(cached(seed, over));
        expect(b.parts.filter((p) => GLOW_TYPES.has(p.type)).length).toBe(0);
      }
    }
  });
});
