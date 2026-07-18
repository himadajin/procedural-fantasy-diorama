/**
 * 骨格文法(materials / parts)と zoneMask 建物上書きのテスト。
 * 契約は docs/internal/contracts/buildings.md
 * 「Part の型語彙」「materialId の語彙」「建物部品の性質」。
 */
import { describe, expect, it } from "vitest";
import {
  SHORE_SKIRT_BOTTOM_Y,
  type Building,
  type Params,
  type Part,
  type WorldModel,
} from "../src/model/worldmodel";
import { ZONE_KINDS, sampleZoneMask } from "../src/model/zonemask";
import { polygonSignedDistance } from "../src/model/waterfield";
import { runParcels } from "../src/pipeline/parcels";
import { FLOOR_HEIGHT, runBuildings } from "../src/pipeline/buildings";
import { buildUpTo, makeCached } from "./helpers";

const SEEDS = ["everdusk-101", "seed-a", "seed-b"];

/** materialId の語彙(contracts/materials.md = art-direction 5.1節) */
const WALL_IDS = ["rough-wood", "plaster", "stone", "ashlar"];
const ROOF_IDS = ["thatch", "shingle", "tile", "slate"];
const TRIM_IDS = ["wood", "stone"];
const ALL_MATERIAL_IDS = new Set([...WALL_IDS, ...ROOF_IDS, ...TRIM_IDS]);
/** 骨格語彙 + 詳細部品の語彙 + 水辺建築の拡張語彙(deck) +
 *  中庭型(courtyard)の語彙(courtyard-wall) */
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
  "deck",
  "courtyard-wall",
]);
/** 建物本体に付かない部品(敷地前面帯・中庭型の塀に置かれる。footprint
 *  検査から除く。courtyard-wall は親区画ではなくグループ帯で検証する
 *  ため、下記の「部品が footprint から大きくはみ出さない」テストでは
 *  別扱いにする(契約「中庭型(courtyard)の性質」帯制約 (12)) */
const SITE_PART_TYPES = new Set(["fence", "stair"]);
/** グループ帯(1.2)で検証する部品区分(契約 (12): courtyard-wall はグループの
 *  いずれかのメンバー区画から 1.2 以内であればよい) */
const GROUP_BAND_PART_TYPES = new Set(["courtyard-wall"]);

/** 水辺拡張部品(契約「水辺建築の拡張」。骨格・詳細の性質検査から契約どおり除く) */
function isWaterfront(p: Part): boolean {
  return p.params?.waterfront === 1;
}

/** 裏庭部品(契約「裏庭の性質」。fence(背面・側面)・shed の wall/gable)。
 *  骨格の壁体・屋根の型別カウント検査からは除き、footprint 帯検査では
 *  SITE_PART_TYPES と同じ流儀(親区画 1.2 帯。ただし連棟の共有裏庭に対応する
 *  ため Building.spanParcelIds の全区画のいずれかから 1.2 以内、へ一般化する。
 *  契約「裏庭の性質」実装補足) */
function isBackyard(p: Part): boolean {
  return p.params?.backyard === 1;
}

function buildUntilParcels(seed: string, over: Partial<Params> = {}): WorldModel {
  return buildUpTo(runParcels, seed, over);
}

function build(seed: string, over: Partial<Params> = {}): WorldModel {
  return buildUpTo(runBuildings, seed, over);
}

const cached = makeCached(build);

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

/**
 * 一般建物(中心建築は専用文法・専用語彙のため除外。
 * 中心建築の検証は test/center.test.ts)
 */
function general(model: WorldModel): Building[] {
  return model.buildings.filter((b) => b.role !== "center");
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

describe("building parts: 語彙(contracts/buildings.md)", () => {
  it("materials が語彙に収まり、trim は石造壁のとき stone", () => {
    for (const [seed, over] of COMBOS) {
      for (const b of general(cached(seed, over))) {
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
      for (const b of general(cached(seed, over))) {
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
      for (const b of general(model)) {
        // 張り出し部屋の壁体(waterfront)・裏庭 shed の壁体(backyard)は
        // 骨格の翼数検査の対象外(契約)
        const walls = partsOf(b, "wall").filter(
          (p) => !isWaterfront(p) && !isBackyard(p),
        );
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
      for (const b of general(model)) {
        // 張り出し部屋の小屋根(waterfront)・裏庭 shed の屋根(backyard)は
        // 骨格の屋根数検査の対象外(契約)
        const roofs = b.parts.filter(
          (p) =>
            (p.type === "gable" || p.type === "hip") &&
            !isWaterfront(p) &&
            !isBackyard(p),
        );
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
      for (const b of general(cached(seed, over))) {
        // デッキ杭(waterfront)は上端 = デッキ床下端の別契約
        // (test/waterfront.test.ts で検証)
        const piles = partsOf(b, "pile").filter((p) => !isWaterfront(p));
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
      // グループ帯の判定用(契約 (12)): groupId → 同一グループの全区画
      const parcelsByGroup = new Map<string, WorldModel["parcels"]>();
      for (const p of model.parcels) {
        if (!p.groupId) continue;
        let bucket = parcelsByGroup.get(p.groupId);
        if (!bucket) {
          bucket = [];
          parcelsByGroup.set(p.groupId, bucket);
        }
        bucket.push(p);
      }
      for (const b of general(model)) {
        // ジェッティのある建物は上階壁・屋根・開口が張り出しぶんさらに出る
        const limit = b.parts.some((p) => p.type === "jetty") ? 1.2 : 0.9;
        const parcel = b.parcelId ? parcelById.get(b.parcelId) : undefined;
        for (const p of b.parts) {
          // 水辺拡張部品は水側へ最大 3.4 の別上限
          // (契約「水辺建築の拡張」。test/waterfront.test.ts で検証)
          if (isWaterfront(p)) continue;
          for (const c of partCorners(p)) {
            if (GROUP_BAND_PART_TYPES.has(p.type)) {
              // 中庭型の塀(courtyard-wall)はグループのいずれかのメンバー
              // 区画から 1.2 以内であればよい(契約「中庭型(courtyard)の
              // 性質」帯制約 (12)。SITE_PART_TYPES の親区画 1.2 帯の
              // 「グループの複数区画」への一般化)
              expect(parcel?.groupId).toBeDefined();
              const groupParcels = parcel?.groupId
                ? parcelsByGroup.get(parcel.groupId)
                : undefined;
              expect(groupParcels).toBeDefined();
              if (groupParcels) {
                const minDist = Math.min(
                  ...groupParcels.map((gp) =>
                    polygonSignedDistance(c.x, c.z, gp.polygon),
                  ),
                );
                expect(minDist).toBeLessThanOrEqual(1.2);
              }
              continue;
            }
            if (isBackyard(p)) {
              // 裏庭(fence 背面・側面 / shed の wall・gable)は
              // Building.spanParcelIds の全区画のいずれかから 1.2 以内で
              // あればよい(契約「裏庭の性質」実装補足。連棟の共有裏庭は
              // 列全体に及ぶため、SITE_PART_TYPES の親区画 1.2 帯を
              // spanParcelIds の複数区画へ一般化したもの。単棟は
              // spanParcelIds が長さ 1 のため既存と同じ結果になる)
              expect(b.spanParcelIds.length).toBeGreaterThan(0);
              const spanParcels = b.spanParcelIds
                .map((pid) => parcelById.get(pid))
                .filter((p): p is WorldModel["parcels"][number] => !!p);
              expect(spanParcels.length).toBe(b.spanParcelIds.length);
              const minDist = Math.min(
                ...spanParcels.map((sp) =>
                  polygonSignedDistance(c.x, c.z, sp.polygon),
                ),
              );
              expect(minDist).toBeLessThanOrEqual(1.2);
              continue;
            }
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
