import { describe, expect, it } from "vitest";
import { DEFAULT_PARAMS, type Params, type Vec2, type WorldModel } from "../src/model/worldmodel";
import {
  createWaterField,
  distToPolyline,
  pointInPolygon,
} from "../src/model/waterfield";
import { segmentIntersection, waterCrossings } from "../src/model/geometry";
import { runPipeline } from "../src/pipeline/run";

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

/** 決定性テスト用: キャッシュを使わず独立に生成する */
async function buildFresh(seed: string, over: Partial<Params> = {}): Promise<WorldModel> {
  return runPipeline(seed, { ...DEFAULT_PARAMS, ...over });
}

/** 湖・池・水路を合成した水域 sdf(正=陸側) */
function combinedWaterSdf(model: WorldModel): (x: number, z: number) => number {
  const field = createWaterField(model.ground.boundary, [
    ...model.water.lakes,
    ...model.water.ponds,
  ]);
  return (x, z) => {
    let d = field.waterSdf(x, z);
    for (const canal of model.water.canals) {
      d = Math.min(d, distToPolyline(x, z, canal.points) - canal.width / 2);
    }
    return d;
  };
}

describe("wards: 決定性", () => {
  it("同一 seed + params で wards 一式と bridges が完全一致する", async () => {
    for (const seed of SEEDS) {
      const a = await buildFresh(seed);
      const b = await buildFresh(seed);
      expect(a.wards).toEqual(b.wards);
      expect(a.water.bridges).toEqual(b.water.bridges);
      expect(a.network.edges).toEqual(b.network.edges);
    }
  });
});

describe("wards: wardLevel の段階遷移(Arcana 20/60/95)", () => {
  it("wardLevel 1/2/3 と各要素の量が段階的に変わる", async () => {
    for (const seed of SEEDS) {
      const w20 = (await build(seed, { arcana: 20 })).wards;
      const w60 = (await build(seed, { arcana: 60 })).wards;
      const w95 = (await build(seed, { arcana: 95 })).wards;

      expect(w20.wardLevel).toBe(1);
      expect(w60.wardLevel).toBe(2);
      expect(w95.wardLevel).toBe(3);

      // ringPath は wardLevel ≥ 1 で非空
      expect(w20.ringPath.length).toBeGreaterThan(0);
      expect(w60.ringPath.length).toBeGreaterThan(0);
      expect(w95.ringPath.length).toBeGreaterThan(0);

      // towers / gates は wardLevel ≥ 2
      expect(w20.towers).toEqual([]);
      expect(w20.gates).toEqual([]);
      expect(w60.towers.length).toBeGreaterThanOrEqual(2);
      expect(w95.towers.length).toBeGreaterThan(w60.towers.length);
      expect(w60.gates.length).toBeGreaterThanOrEqual(1);
      expect(w95.gates.length).toBeGreaterThanOrEqual(1);

      // lamps は lampDensity に単調(候補ごとの独立サブストリーム)
      expect(w20.lamps.length).toBeLessThanOrEqual(w60.lamps.length);
      expect(w60.lamps.length).toBeLessThan(w95.lamps.length);

      // floaters は Arcana 30 以下で 0、高水準で出現
      expect(w20.floaters).toEqual([]);
      expect(w95.floaters.length).toBeGreaterThan(0);

      // shrines は wardLevel ≥ 1 で 1〜2
      for (const w of [w20, w60, w95]) {
        expect(w.shrines.length).toBeGreaterThanOrEqual(1);
        expect(w.shrines.length).toBeLessThanOrEqual(2);
      }

      // 閉じ率: wall の被覆(辺数比)が Arcana に単調
      const wallFraction = (w: typeof w20): number => {
        const n = w.ringPath.length;
        let wall = 0;
        for (const seg of w.ringSegments) {
          if (seg.kind === "wall") wall += seg.end - seg.start;
        }
        return n > 0 ? wall / n : 0;
      };
      expect(wallFraction(w20)).toBeLessThan(wallFraction(w60));
      expect(wallFraction(w60)).toBeLessThan(wallFraction(w95));
    }
  });

  it("Arcana 0(wardLevel 0)では wards がすべて空", async () => {
    for (const seed of SEEDS) {
      const w = (await build(seed, { arcana: 0 })).wards;
      expect(w.wardLevel).toBe(0);
      expect(w.ringPath).toEqual([]);
      expect(w.ringSegments).toEqual([]);
      expect(w.towers).toEqual([]);
      expect(w.gates).toEqual([]);
      expect(w.shrines).toEqual([]);
      expect(w.lamps).toEqual([]);
      expect(w.floaters).toEqual([]);
    }
  });
});

describe("wards: ringPath の性質", () => {
  it("閉ループ(先頭点の重複なし)で中心を囲み、自己交差がない(全ペア検査)", async () => {
    for (const seed of SEEDS) {
      for (const arcana of [20, 60, 95]) {
        const model = await build(seed, { arcana });
        const ring = model.wards.ringPath;
        const n = ring.length;
        expect(n).toBeGreaterThanOrEqual(16);
        const first = ring[0];
        const last = ring[n - 1];
        if (!first || !last) throw new Error("ringPath が空");
        expect(Math.hypot(first.x - last.x, first.z - last.z)).toBeGreaterThan(
          1e-9,
        );
        // 中心を囲む
        const c = model.centerPlan.position;
        expect(pointInPolygon(c.x, c.z, ring)).toBe(true);
        // 非自己交差(隣接辺と環の継ぎ目は共有点のため除外)
        for (let i = 0; i < n; i++) {
          const a = ring[i];
          const b = ring[(i + 1) % n];
          if (!a || !b) continue;
          for (let j = i + 2; j < n; j++) {
            if (i === 0 && j === n - 1) continue;
            const p = ring[j];
            const q = ring[(j + 1) % n];
            if (!p || !q) continue;
            expect(
              segmentIntersection(a, b, p, q),
              `seed=${seed} arcana=${arcana} 辺 ${i}-${j} が自己交差`,
            ).toBeNull();
          }
        }
      }
    }
  });

  it("ringSegments は互いに素な区間で全周を被覆し、wall は接地・overwater は水中", async () => {
    for (const seed of SEEDS) {
      const model = await build(seed, { arcana: 95, water: 70 });
      const ring = model.wards.ringPath;
      const segments = model.wards.ringSegments;
      const n = ring.length;
      // 被覆と非重複(start 昇順・end 連続)
      let cursor = 0;
      for (const seg of segments) {
        expect(seg.start).toBe(cursor);
        expect(seg.end).toBeGreaterThan(seg.start);
        expect(["wall", "overwater", "gap"]).toContain(seg.kind);
        cursor = seg.end;
      }
      expect(cursor).toBe(n);
      // wall は水中でない(overwater は接地検証から除外される)
      const wsdf = combinedWaterSdf(model);
      for (const seg of segments) {
        if (seg.kind !== "wall") continue;
        for (let k = seg.start; k < seg.end; k++) {
          const p = ring[k % n];
          if (!p) continue;
          expect(
            wsdf(p.x, p.z),
            `seed=${seed} wall 区間の点 ${k} が水中`,
          ).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });
});

describe("wards: 結界門と道路(局所スナップ)", () => {
  it("全ての結界横断道路が門位置を通過する(門位置と道路 path の距離で機械検証)", async () => {
    for (const seed of SEEDS) {
      for (const arcana of [60, 95]) {
        const model = await build(seed, { arcana });
        const ring = model.wards.ringPath;
        const n = ring.length;
        const gates = model.wards.gates;
        // 1) 各門は対応する道路 path 上にある(距離 ≈ 0)
        for (const gate of gates) {
          const edge = model.network.edges.find((e) => e.id === gate.roadEdgeId);
          expect(edge, `${gate.id} の道路 edge が見つからない`).toBeDefined();
          if (!edge) continue;
          expect(
            distToPolyline(gate.position.x, gate.position.z, edge.path),
            `${gate.id} が道路 path 上にない`,
          ).toBeLessThan(1e-6);
        }
        // 2) 結界環×道路の全交点の近傍に門がある(門スナップ対象は
        //    main / connector に限定。street・lane が結界環を
        //    横切っても門は生成しない契約のため、検証対象も同じに限る)
        for (const edge of model.network.edges) {
          if (edge.class !== "main" && edge.class !== "connector") continue;
          for (let i = 0; i + 1 < edge.path.length; i++) {
            const a = edge.path[i];
            const b = edge.path[i + 1];
            if (!a || !b) continue;
            for (let j = 0; j < n; j++) {
              const c = ring[j];
              const d = ring[(j + 1) % n];
              if (!c || !d) continue;
              const hit = segmentIntersection(a, b, c, d);
              if (!hit) continue;
              let near = Infinity;
              for (const g of gates) {
                near = Math.min(
                  near,
                  Math.hypot(
                    g.position.x - hit.point.x,
                    g.position.z - hit.point.z,
                  ),
                );
              }
              expect(
                near,
                `seed=${seed} arcana=${arcana} edge=${edge.id} の結界横断に門がない`,
              ).toBeLessThan(1);
            }
          }
        }
      }
    }
  });

  it("スナップ後も水域を渡る道路区間はすべて BridgeSite を持つ(再抽出の検証)", async () => {
    for (const seed of SEEDS) {
      for (const over of [
        { water: 70 },
        { water: 70, arcana: 95 },
        { water: 95, settlement: 95 },
      ] satisfies Partial<Params>[]) {
        const model = await build(seed, over);
        const wsdf = combinedWaterSdf(model);
        let expected = 0;
        for (const edge of model.network.edges) {
          expected += waterCrossings(edge.path, wsdf, 2).length;
        }
        expect(model.water.bridges.length).toBe(expected);
        expect(model.summary.waterOverview.bridges).toBe(expected);
        // over は水域種別(canal を含む)
        for (const bridge of model.water.bridges) {
          expect(["lake", "pond", "canal"]).toContain(bridge.over);
        }
      }
    }
  });
});

describe("wards: 付帯要素の位置", () => {
  it("towers は結界環上(onRing)または水辺の独立塔で、正の高さを持つ", async () => {
    for (const seed of SEEDS) {
      const model = await build(seed, { arcana: 95 });
      const ring = model.wards.ringPath;
      for (const tower of model.wards.towers) {
        expect(tower.height).toBeGreaterThan(0);
        if (tower.onRing) {
          let near = Infinity;
          for (const p of ring) {
            near = Math.min(
              near,
              Math.hypot(p.x - tower.position.x, p.z - tower.position.z),
            );
          }
          expect(near).toBeLessThan(1e-6);
        }
      }
    }
  });

  it("floaters は塔・門・聖域の anchor に属し、空中の基準位置を持つ", async () => {
    for (const seed of SEEDS) {
      const model = await build(seed, { arcana: 95 });
      const anchorIds = new Set<string>([
        ...model.wards.towers.map((t) => t.id),
        ...model.wards.gates.map((g) => g.id),
        ...model.wards.shrines.map((s) => s.id),
      ]);
      expect(model.wards.floaters.length).toBeGreaterThan(0);
      const anchorOf = (id: string): Vec2 | { x: number; z: number } => {
        const t = model.wards.towers.find((v) => v.id === id);
        if (t) return t.position;
        const g = model.wards.gates.find((v) => v.id === id);
        if (g) return g.position;
        const s = model.wards.shrines.find((v) => v.id === id);
        if (s) return s.position;
        throw new Error(`anchor ${id} が見つからない`);
      };
      for (const f of model.wards.floaters) {
        expect(anchorIds.has(f.anchorId)).toBe(true);
        expect(f.basePosition.y).toBeGreaterThan(0);
        expect(f.size).toBeGreaterThan(0);
        const a = anchorOf(f.anchorId);
        expect(
          Math.hypot(a.x - f.basePosition.x, a.z - f.basePosition.z),
        ).toBeLessThan(10);
      }
    }
  });

  it("wardOverview が wards の実態と一致する", async () => {
    for (const seed of SEEDS) {
      const model = await build(seed, { arcana: 60 });
      const w = model.wards;
      const o = model.summary.wardOverview;
      expect(o.level).toBe(w.wardLevel);
      expect(o.towers).toBe(w.towers.length);
      expect(o.gates).toBe(w.gates.length);
      expect(o.shrines).toBe(w.shrines.length);
      expect(o.floaters).toBe(w.floaters.length);
      expect(o.ringLength).toBeGreaterThan(0);
    }
  });
});
