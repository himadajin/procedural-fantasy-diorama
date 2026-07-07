/**
 * 結界構造の立体化(PHASE 5b commit 17)のテスト。
 * 展開はメッシュ層の純関数 src/mesh/wardparts.ts(three 非依存)のため、
 * three を経由せず機械検証できる(contracts/worldmodel.md「結界構造の立体化」)。
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PARAMS,
  type Params,
  type Part,
  type Vec2,
  type WorldModel,
} from "../src/model/worldmodel";
import { polygonArea } from "../src/model/waterfield";
import { runPipeline } from "../src/pipeline/run";
import { CENTER_GLOW_SHARE, glowPartArea } from "../src/pipeline/center";
import { expandWardParts } from "../src/mesh/wardparts";

const SEEDS = ["everdusk-101", "seed-a"];

/** テストは読み取りのみのため、同一入力の生成結果をキャッシュして共有する */
const cache = new Map<string, Promise<WorldModel>>();

async function build(seed: string, over: Partial<Params> = {}): Promise<WorldModel> {
  const key = `${seed}|${JSON.stringify(over)}`;
  let promise = cache.get(key);
  if (!promise) {
    promise = runPipeline(seed, { ...DEFAULT_PARAMS, ...over });
    cache.set(key, promise);
  }
  return promise;
}

function ofType(parts: Part[], type: string): Part[] {
  return parts.filter((p) => p.type === type);
}

/** 発光部品(materialId "glow")の集合 */
function glowParts(parts: Part[]): Part[] {
  return parts.filter((p) => p.materialId === "glow");
}

describe("wardparts: 決定性", () => {
  it("同一 seed + params で展開結果が完全一致する(乱数ストリーム非消費)", async () => {
    for (const seed of SEEDS) {
      const a = expandWardParts(
        await runPipeline(seed, { ...DEFAULT_PARAMS, arcana: 95 }),
      );
      const b = expandWardParts(
        await runPipeline(seed, { ...DEFAULT_PARAMS, arcana: 95 }),
      );
      expect(a).toEqual(b);
      expect(a.parts.length).toBeGreaterThan(0);
    }
  });

  it("wardLevel 0(Arcana 0)では展開が空", async () => {
    for (const seed of SEEDS) {
      const ex = expandWardParts(await build(seed, { arcana: 0 }));
      expect(ex.parts).toEqual([]);
      expect(ex.glowArea).toBe(0);
    }
  });
});

describe("wardparts: wardLevel の縮退(同一文法の段階形)", () => {
  it("Arcana 20 = 境界標の点列(壁体・門なし)/ 60 = 部分壁+塔 / 95 = 完全環+門", async () => {
    for (const seed of SEEDS) {
      const e20 = expandWardParts(await build(seed, { arcana: 20 }));
      const e60 = expandWardParts(await build(seed, { arcana: 60 }));
      const e95 = expandWardParts(await build(seed, { arcana: 95 }));

      // level 1: 発光紋様を持つ立石の点列。壁体・門は無い
      expect(ofType(e20.parts, "ward-stone").length).toBeGreaterThanOrEqual(2);
      expect(ofType(e20.parts, "ward-wall")).toEqual([]);
      expect(ofType(e20.parts, "arch")).toEqual([]);
      expect(glowParts(e20.parts).length).toBeGreaterThan(0);

      // level 2: 途切れた低い結界壁+塔(同一文法の縮退形=壁が立石を置換)
      expect(ofType(e60.parts, "ward-wall").length).toBeGreaterThan(0);
      expect(ofType(e60.parts, "tower").length).toBeGreaterThan(0);

      // level 3: 壁の総延長・門(arch)が段階的に増える
      const wallLen = (parts: Part[]): number =>
        ofType(parts, "ward-wall").reduce(
          (sum, p) => sum + p.transform.scale[0],
          0,
        );
      expect(wallLen(e20.parts)).toBe(0);
      expect(wallLen(e60.parts)).toBeGreaterThan(0);
      expect(wallLen(e95.parts)).toBeGreaterThan(wallLen(e60.parts));

      const m60 = (await build(seed, { arcana: 60 })).wards.gates.length;
      const m95 = (await build(seed, { arcana: 95 })).wards.gates.length;
      expect(ofType(e60.parts, "arch").length).toBe(m60);
      expect(ofType(e95.parts, "arch").length).toBe(m95);

      // 段階内の連続量: 壁高は wallClosure 連動で 60 < 95
      const meanH = (parts: Part[]): number => {
        const walls = ofType(parts, "ward-wall");
        return walls.reduce((s, p) => s + p.transform.scale[1], 0) / walls.length;
      };
      expect(meanH(e60.parts)).toBeLessThan(meanH(e95.parts));
    }
  });
});

describe("wardparts: 接地(overwater 除外)", () => {
  it("壁・門・立石・基壇の底は y=0、水上弧以外の部品は地面より下へ潜らない", async () => {
    for (const seed of SEEDS) {
      for (const over of [
        { arcana: 20 },
        { arcana: 60 },
        { arcana: 95, water: 70 },
      ] satisfies Partial<Params>[]) {
        const ex = expandWardParts(await build(seed, over));
        for (const part of ex.parts) {
          const y = part.transform.position[1];
          if (["ward-wall", "arch", "ward-stone", "plinth"].includes(part.type)) {
            expect(y, `${part.type} の底が y=0 でない`).toBe(0);
          } else if (part.type !== "sigil") {
            // 塔身・尖塔・水晶・扉などは接地部品の上に載る
            expect(y, `${part.type} が地面へ潜っている`).toBeGreaterThanOrEqual(0);
          }
        }
      }
    }
  });

  it("overwater 区間には壁体を置かず、水上結界(発光弧)のみを張る", async () => {
    for (const seed of SEEDS) {
      const model = await build(seed, { arcana: 95, water: 70 });
      const ex = expandWardParts(model);
      const ring = model.wards.ringPath;
      const n = ring.length;
      // overwater 辺の中点
      const wetMids: Vec2[] = [];
      for (const seg of model.wards.ringSegments) {
        if (seg.kind !== "overwater") continue;
        for (let k = seg.start; k < seg.end; k++) {
          const a = ring[k % n];
          const b = ring[(k + 1) % n];
          if (!a || !b) continue;
          wetMids.push({ x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 });
        }
      }
      // 壁体は overwater 辺の中点に重ならない
      for (const wall of ofType(ex.parts, "ward-wall")) {
        const [x, , z] = wall.transform.position;
        for (const m of wetMids) {
          expect(
            Math.hypot(m.x - x, m.z - z),
            `overwater 辺上に壁体がある (${x}, ${z})`,
          ).toBeGreaterThan(1.0);
        }
      }
      // overwater があるとき、水面上の発光弧(sigil。y < 0)が張られる
      if (wetMids.length > 0) {
        const arcs = ofType(ex.parts, "sigil").filter(
          (p) => p.transform.position[1] < 0,
        );
        expect(arcs.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("wardparts: 結界門の通過(立体後の再検証)", () => {
  it("全ての門にアーチがあり、開口が道路幅+余裕を確保し、壁・立石が開口を塞がない", async () => {
    for (const seed of SEEDS) {
      for (const arcana of [60, 95]) {
        const model = await build(seed, { arcana });
        const ex = expandWardParts(model);
        const arches = ofType(ex.parts, "arch");
        for (const gate of model.wards.gates) {
          const arch = arches.find(
            (p) =>
              Math.hypot(
                p.transform.position[0] - gate.position.x,
                p.transform.position[2] - gate.position.z,
              ) < 1e-6,
          );
          expect(arch, `${gate.id} のアーチが無い`).toBeDefined();
          if (!arch) continue;
          const edge = model.network.edges.find((e) => e.id === gate.roadEdgeId);
          expect(edge).toBeDefined();
          if (!edge) continue;
          // 開口幅 ≥ 道路幅 + 0.8、開口天端 ≥ 3.2(道は必ず門をくぐれる)
          const openW = (arch.params?.open ?? 0) * arch.transform.scale[0];
          const clearH = (arch.params?.rise ?? 0) * arch.transform.scale[1];
          expect(openW).toBeGreaterThanOrEqual(edge.width + 0.8);
          expect(clearH).toBeGreaterThanOrEqual(3.2);
          // 壁体・立石は門開口(gap 弧)を塞がない
          for (const part of ex.parts) {
            if (part.type !== "ward-wall" && part.type !== "ward-stone") continue;
            const d = Math.hypot(
              part.transform.position[0] - gate.position.x,
              part.transform.position[2] - gate.position.z,
            );
            expect(d, `${gate.id} の開口近くに ${part.type}`).toBeGreaterThan(2.5);
          }
        }
      }
    }
  });
});

describe("wardparts: 発光面積の規律(art-direction 5.4節)", () => {
  it("結界の発光面積は取り分(glowAreaCap × 面積 × 0.65)内、中心建築との合計も上限内", async () => {
    for (const seed of SEEDS) {
      for (const over of [
        { arcana: 95 },
        { arcana: 95, water: 70 },
        { arcana: 95, worldScale: 0 },
      ] satisfies Partial<Params>[]) {
        const model = await build(seed, over);
        const ex = expandWardParts(model);
        const area = Math.abs(polygonArea(model.ground.boundary));
        const cap = model.meta.derived.glowAreaCap * area;
        // 取り分(結界 = 1 − CENTER_GLOW_SHARE)
        expect(ex.glowBudget).toBeCloseTo(cap * (1 - CENTER_GLOW_SHARE), 6);
        expect(ex.glowArea).toBeLessThanOrEqual(ex.glowBudget + 1e-9);
        // glowArea は展開結果の発光部品の実面積と一致する
        let sum = 0;
        for (const part of ex.parts) sum += glowPartArea(part);
        expect(sum).toBeCloseTo(ex.glowArea, 6);
        // 中心建築(0.35)との合計が全体上限内
        let centerGlow = 0;
        for (const building of model.buildings) {
          for (const part of building.parts) centerGlow += glowPartArea(part);
        }
        expect(centerGlow + ex.glowArea).toBeLessThanOrEqual(cap + 1e-9);
      }
    }
  });
});
