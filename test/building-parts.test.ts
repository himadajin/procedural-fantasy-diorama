/**
 * PHASE 4a commit 13: 骨格文法(materials / parts)と zoneMask 建物上書きの
 * テスト。契約は docs/internal/contracts/worldmodel.md
 * 「Part の型語彙」「materialId の語彙」「建物部品の性質」。
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PARAMS,
  SHORE_SKIRT_BOTTOM_Y,
  createEmptyWorldModel,
  type Building,
  type Params,
  type Part,
  type WorldModel,
} from "../src/model/worldmodel";
import { ZONE_KINDS, sampleZoneMask } from "../src/model/zonemask";
import { polygonSignedDistance } from "../src/model/waterfield";
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
import { FLOOR_HEIGHT, runBuildings } from "../src/pipeline/buildings";

const SEEDS = ["everdusk-101", "seed-a", "seed-b"];

/** materialId の語彙(contracts/worldmodel.md = art-direction 5.1節) */
const WALL_IDS = ["rough-wood", "plaster", "stone", "ashlar"];
const ROOF_IDS = ["thatch", "shingle", "tile", "slate"];
const TRIM_IDS = ["wood", "stone"];
const ALL_MATERIAL_IDS = new Set([...WALL_IDS, ...ROOF_IDS, ...TRIM_IDS]);
/** commit 13 の骨格語彙 + PHASE 4b commit 14 の詳細語彙 */
const PART_TYPES = new Set([
  "plinth",
  "pile",
  "wall",
  "gable",
  "hip",
  "window",
  "door",
  "beam",
  "jetty",
  "chimney",
  "fence",
  "stair",
  "dormer",
]);
/** 建物本体に付かない部品(敷地前面帯に置かれる。footprint 検査から除く) */
const SITE_PART_TYPES = new Set(["fence", "stair"]);

function buildUntilParcels(seed: string, over: Partial<Params> = {}): WorldModel {
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

function build(seed: string, over: Partial<Params> = {}): WorldModel {
  const model = buildUntilParcels(seed, over);
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

/** 水辺込みの組(杭・張り出しの検証が空にならないよう Water を振る) */
const COMBOS: [string, Partial<Params>][] = SEEDS.flatMap((seed) => [
  [seed, {}],
  [seed, { water: 70 }],
  [seed, { water: 95 }],
]);

/** 部品の xz 四隅(変換規約: scale → Y回転(+x→(cosθ,0,−sinθ))→ position) */
function partCorners(part: Part): { x: number; z: number }[] {
  const [px, , pz] = part.transform.position;
  const [sx, , sz] = part.transform.scale;
  const cos = Math.cos(part.transform.rotation);
  const sin = Math.sin(part.transform.rotation);
  const out: { x: number; z: number }[] = [];
  for (const [lx, lz] of [
    [-0.5, -0.5],
    [0.5, -0.5],
    [0.5, 0.5],
    [-0.5, 0.5],
  ] as const) {
    const x = lx * sx;
    const z = lz * sz;
    out.push({ x: px + x * cos + z * sin, z: pz - x * sin + z * cos });
  }
  return out;
}

function partsOf(b: Building, type: string): Part[] {
  return b.parts.filter((p) => p.type === type);
}

describe("building parts: 決定性", () => {
  it("同一 seed + params で全建物の parts / materials が完全一致する", () => {
    for (const seed of SEEDS) {
      const a = build(seed);
      const b = build(seed);
      expect(
        JSON.stringify(a.buildings.map((x) => [x.materials, x.parts])),
      ).toBe(JSON.stringify(b.buildings.map((x) => [x.materials, x.parts])));
    }
  });
});

describe("building parts: 語彙(contracts/worldmodel.md)", () => {
  it("materials が語彙に収まり、trim は石造壁のとき stone", () => {
    for (const [seed, over] of COMBOS) {
      for (const b of cached(seed, over).buildings) {
        expect(WALL_IDS).toContain(b.materials.wall);
        expect(ROOF_IDS).toContain(b.materials.roof);
        expect(TRIM_IDS).toContain(b.materials.trim);
        const stoneWall =
          b.materials.wall === "stone" || b.materials.wall === "ashlar";
        expect(b.materials.trim).toBe(stoneWall ? "stone" : "wood");
      }
    }
  });

  it("部品の型・materialId が語彙に収まる", () => {
    for (const [seed, over] of COMBOS) {
      for (const b of cached(seed, over).buildings) {
        for (const p of b.parts) {
          expect(PART_TYPES.has(p.type)).toBe(true);
          expect(ALL_MATERIAL_IDS.has(p.materialId)).toBe(true);
        }
      }
    }
  });
});

describe("building parts: 部品の整合(建物部品の性質)", () => {
  it("壁体は階高 3.0 固定で、翼ごとに階数ぶん(高さの合計 = floors × 3.0)", () => {
    for (const seed of SEEDS) {
      const model = cached(seed);
      for (const b of model.buildings) {
        const walls = partsOf(b, "wall");
        expect(walls.length).toBeGreaterThan(0);
        // 翼数 × 階数(矩形 1 翼、L/T 2 翼)
        expect(walls.length % b.floors).toBe(0);
        const wingCount = walls.length / b.floors;
        expect(wingCount).toBe(b.footprint.length > 4 ? 2 : 1);
        for (const w of walls) {
          expect(w.transform.scale[1]).toBe(FLOOR_HEIGHT);
          expect(w.params?.floor).toBeGreaterThanOrEqual(0);
          expect(w.params?.floor).toBeLessThan(b.floors);
        }
        // 壁の天端 = 基壇天端 + 階数 × 階高
        const top = Math.max(
          ...walls.map((w) => w.transform.position[1] + w.transform.scale[1]),
        );
        expect(top).toBeCloseTo(
          b.foundation.plinthHeight + b.floors * FLOOR_HEIGHT,
          6,
        );
      }
    }
  });

  it("屋根は勾配 50〜58度(params.pitch = roof.pitch)で、棟高 = tan(pitch)×スパン/2", () => {
    for (const seed of SEEDS) {
      const model = cached(seed);
      for (const b of model.buildings) {
        const roofs = b.parts.filter((p) => p.type === "gable" || p.type === "hip");
        // 複合(L/T)は翼ごとの gable、それ以外は 1 部品
        expect(roofs.length).toBe(b.roof.type === "compound" ? 2 : 1);
        for (const r of roofs) {
          expect(r.type).toBe(b.roof.type === "hip" ? "hip" : "gable");
          const pitch = r.params?.pitch ?? 0;
          expect(pitch).toBe(b.roof.pitch);
          expect(pitch).toBeGreaterThanOrEqual(50);
          expect(pitch).toBeLessThanOrEqual(58);
          const expected =
            Math.tan((pitch * Math.PI) / 180) * (r.transform.scale[2] / 2);
          expect(r.transform.scale[1]).toBeCloseTo(expected, 6);
        }
      }
    }
  });

  it("杭部品は bottomY = -1.6 から基壇天端まで(kind 'piles' の建物のみ)", () => {
    let pileBuildings = 0;
    for (const [seed, over] of COMBOS) {
      for (const b of cached(seed, over).buildings) {
        const piles = partsOf(b, "pile");
        if (b.foundation.kind === "piles") {
          pileBuildings++;
          expect(piles.length).toBeGreaterThanOrEqual(4);
          for (const p of piles) {
            expect(p.transform.position[1]).toBe(SHORE_SKIRT_BOTTOM_Y);
            expect(
              p.transform.position[1] + p.transform.scale[1],
            ).toBeCloseTo(b.foundation.plinthHeight, 6);
            expect(p.materialId).toBe("wood");
          }
        } else {
          expect(piles.length).toBe(0);
          // 基壇(石基礎は水面下 -1.6 から立ち上げる)
          const plinths = partsOf(b, "plinth");
          expect(plinths.length).toBeGreaterThan(0);
          for (const p of plinths) {
            expect(p.transform.position[1]).toBe(
              b.foundation.kind === "stonebase" ? SHORE_SKIRT_BOTTOM_Y : 0,
            );
            expect(
              p.transform.position[1] + p.transform.scale[1],
            ).toBeCloseTo(b.foundation.plinthHeight, 6);
          }
        }
      }
    }
    // 杭契約が空検証にならない
    expect(pileBuildings).toBeGreaterThan(0);
  });

  it("部品が footprint から大きくはみ出さない(軒 0.9 / ジェッティ時 1.2。契約)", () => {
    for (const [seed, over] of COMBOS) {
      const model = cached(seed, over);
      const parcelById = new Map(model.parcels.map((p) => [p.id, p]));
      for (const b of model.buildings) {
        // ジェッティのある建物は上階壁・屋根・開口が張り出しぶんさらに出る
        const limit = b.parts.some((p) => p.type === "jetty") ? 1.2 : 0.9;
        const parcel = b.parcelId ? parcelById.get(b.parcelId) : undefined;
        for (const p of b.parts) {
          for (const c of partCorners(p)) {
            if (SITE_PART_TYPES.has(p.type)) {
              // 石垣・外階段は footprint の外・敷地前面帯に収まる(契約)
              expect(parcel).toBeDefined();
              if (parcel) {
                expect(
                  polygonSignedDistance(c.x, c.z, parcel.polygon),
                ).toBeLessThanOrEqual(1.2);
              }
              continue;
            }
            expect(
              polygonSignedDistance(c.x, c.z, b.footprint),
            ).toBeLessThanOrEqual(limit);
          }
        }
      }
    }
  });
});

describe("building parts: zoneMask の建物上書き", () => {
  const DIRT = ZONE_KINDS.indexOf("dirt");
  const PAVED = ZONE_KINDS.indexOf("paved");

  it("建物の足元で 土+舗装 の重みが増える(段10 と同じ流儀の上書き)", () => {
    for (const seed of SEEDS) {
      const before = buildUntilParcels(seed);
      const after = cached(seed);
      expect(after.buildings.length).toBeGreaterThan(0);
      let sumBefore = 0;
      let sumAfter = 0;
      for (const b of after.buildings) {
        let cx = 0;
        let cz = 0;
        for (const v of b.footprint) {
          cx += v.x;
          cz += v.z;
        }
        cx /= b.footprint.length;
        cz /= b.footprint.length;
        const wb = sampleZoneMask(before.ground.zoneMask, cx, cz).weights;
        const wa = sampleZoneMask(after.ground.zoneMask, cx, cz).weights;
        sumBefore += (wb[DIRT] ?? 0) + (wb[PAVED] ?? 0);
        sumAfter += (wa[DIRT] ?? 0) + (wa[PAVED] ?? 0);
      }
      const n = after.buildings.length;
      expect(sumAfter / n).toBeGreaterThan(sumBefore / n);
      expect(sumAfter / n).toBeGreaterThan(0.5);
    }
  });

  it("各セルの重みは上書き後も非負・合計 1 を保つ", () => {
    for (const seed of SEEDS) {
      const mask = cached(seed).ground.zoneMask;
      const cells = mask.resolution * mask.resolution;
      for (let c = 0; c < cells; c++) {
        let sum = 0;
        for (let k = 0; k < ZONE_KINDS.length; k++) {
          const w = mask.weights[c * ZONE_KINDS.length + k] ?? 0;
          expect(w).toBeGreaterThanOrEqual(0);
          sum += w;
        }
        expect(sum).toBeCloseTo(1, 6);
      }
    }
  });
});
