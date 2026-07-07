/**
 * 橋の立体化(PHASE 5b commit 18)のテスト。
 * 展開はメッシュ層の純関数 src/mesh/bridgeparts.ts(three 非依存)のため、
 * three を経由せず機械検証できる
 * (contracts/wards.md「魔法灯・浮遊要素・橋の立体化」の検証契約)。
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PARAMS,
  SHORE_SKIRT_BOTTOM_Y,
  WATER_SURFACE_Y,
  type Params,
  type WorldModel,
} from "../src/model/worldmodel";
import { createWaterField, distToPolyline } from "../src/model/waterfield";
import { runPipeline } from "../src/pipeline/run";
import {
  CANAL_WATER_SURFACE_Y,
  ROAD_CROWN,
  expandBridgeParts,
  roadBaseY,
} from "../src/mesh/bridgeparts";

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

/** 橋が生成される代表入力(水多め) */
const WATERY: Partial<Params>[] = [{ water: 70 }, { water: 95 }];

describe("bridgeparts: 決定性(表示写像)", () => {
  it("同一 seed + params で展開結果が完全一致する(乱数ストリーム非消費)", async () => {
    for (const seed of SEEDS) {
      const a = expandBridgeParts(
        await runPipeline(seed, { ...DEFAULT_PARAMS, water: 70 }),
      );
      const b = expandBridgeParts(
        await runPipeline(seed, { ...DEFAULT_PARAMS, water: 70 }),
      );
      expect(a).toEqual(b);
      expect(a.bridges.length).toBeGreaterThan(0);
    }
  });
});

describe("bridgeparts: 両岸接続(取り付き)", () => {
  it("河川・湖の橋の取り付き端点は陸上かつ接道 edge.path 上、橋床天端は道路と同高", async () => {
    for (const seed of SEEDS) {
      for (const over of WATERY) {
        const model = await build(seed, over);
        const field = createWaterField(
          model.ground.boundary,
          model.water.rivers,
          model.water.lakes,
        );
        const ex = expandBridgeParts(model);
        const riverBridges = ex.bridges.filter(
          (b) => b.kind === "stone-arch" || b.kind === "wood",
        );
        for (const info of riverBridges) {
          const edge = model.network.edges.find((e) => e.id === info.edgeId);
          expect(edge, `${info.id} の接道 edge が無い`).toBeDefined();
          if (!edge) continue;
          for (const p of info.deckEnds) {
            // 陸上(水際の線形補間誤差ぶんの許容)
            expect(
              field.waterSdf(p.x, p.z),
              `${info.id} の取り付きが水中 (${p.x}, ${p.z})`,
            ).toBeGreaterThan(-0.2);
            // 道路リボンの中心線上(段差なく繋がる前提の共有標本化)
            expect(
              distToPolyline(p.x, p.z, edge.path),
              `${info.id} の取り付きが道路上にない`,
            ).toBeLessThan(0.1);
          }
          // 橋床天端 = 道路リボンの中央高 + 0.02(接合部の契約)
          expect(info.deckTopY).toBeCloseTo(
            roadBaseY(edge.id) + ROAD_CROWN + 0.02,
            9,
          );
        }
      }
    }
  });

  it("河川・湖を渡る道路区間(リボンが岸で止める区間)はすべて橋を持つ", async () => {
    for (const seed of SEEDS) {
      for (const over of WATERY) {
        const model = await build(seed, over);
        const ex = expandBridgeParts(model);
        const riverSites = model.water.bridges.filter((b) => b.over !== "canal");
        const riverBridges = ex.bridges.filter(
          (b) => b.kind === "stone-arch" || b.kind === "wood",
        );
        // 段8の BridgeSite(河川・湖)と同数以上(標本化は同一 step の共有実装)
        expect(riverBridges.length).toBeGreaterThanOrEqual(riverSites.length);
      }
    }
  });

  it("水路の BridgeSite はすべて小橋(桁+欄干+取り付き座)を持つ", async () => {
    for (const seed of SEEDS) {
      const model = await build(seed, { water: 70, settlement: 70 });
      const ex = expandBridgeParts(model);
      const canalSites = model.water.bridges.filter((b) => b.over === "canal");
      const canalBridges = ex.bridges.filter(
        (b) => b.kind === "canal-stone" || b.kind === "canal-wood",
      );
      expect(canalBridges.length).toBe(canalSites.length);
    }
  });
});

describe("bridgeparts: 水面との整合", () => {
  it("桁・橋床の下端は水面より上(河川・湖 -0.6 / 水路 +0.04)", async () => {
    for (const seed of SEEDS) {
      for (const over of WATERY) {
        const ex = expandBridgeParts(await build(seed, over));
        for (const info of ex.bridges) {
          const floor =
            info.kind === "canal-stone" || info.kind === "canal-wood"
              ? CANAL_WATER_SURFACE_Y
              : WATER_SURFACE_Y;
          expect(
            info.girderBottomY,
            `${info.id} の桁下端が水面下`,
          ).toBeGreaterThan(floor);
        }
      }
    }
  });

  it("橋脚(アーチ脚・杭)は水面下 -1.6(岸スカート下端)まで到達する", async () => {
    for (const seed of SEEDS) {
      for (const over of WATERY) {
        const ex = expandBridgeParts(await build(seed, over));
        for (const info of ex.bridges) {
          if (info.pierBottomY !== null) {
            expect(info.pierBottomY).toBe(SHORE_SKIRT_BOTTOM_Y);
          }
        }
        // 部品側でも検証: 杭と石造アーチの底は -1.6
        for (const part of ex.parts) {
          if (part.type === "pile" || part.type === "arch") {
            expect(part.transform.position[1]).toBe(SHORE_SKIRT_BOTTOM_Y);
          }
        }
      }
    }
  });
});

describe("bridgeparts: 型の対応表(over / roadClass / Prosperity)", () => {
  it("main × 高 Prosperity は石造アーチ、connector・低 Prosperity は木橋", async () => {
    for (const seed of SEEDS) {
      const rich = await build(seed, { water: 70, prosperity: 90 });
      const exRich = expandBridgeParts(rich);
      for (const info of exRich.bridges) {
        const edge = rich.network.edges.find((e) => e.id === info.edgeId);
        if (!edge) continue;
        if (edge.class === "main") expect(info.kind).toBe("stone-arch");
        else expect(info.kind).toBe("wood");
      }
      const poor = await build(seed, { water: 70, prosperity: 10 });
      const exPoor = expandBridgeParts(poor);
      for (const info of exPoor.bridges) {
        if (info.kind === "canal-stone" || info.kind === "canal-wood") {
          expect(info.kind).toBe("canal-wood");
        } else {
          expect(info.kind).toBe("wood");
        }
      }
    }
  });
});
