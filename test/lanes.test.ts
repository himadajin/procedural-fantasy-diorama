/**
 * 段13「小道」(PHASE 4b commit 15)のテスト。
 * 契約は docs/internal/contracts/network-plaza.md(Network 節「小道の性質」・ground-water.md
 * ZoneMask 節)と contracts/pipeline.md の段契約表。
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PARAMS,
  createEmptyWorldModel,
  type Params,
  type WorldModel,
} from "../src/model/worldmodel";
import {
  createWaterField,
  distToPolyline,
  polygonSignedDistance,
} from "../src/model/waterfield";
import { pathLength, pointAlong } from "../src/model/geometry";
import { ZONE_KINDS, sampleZoneMask } from "../src/model/zonemask";
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
import { LANE_WIDTH, runLanes } from "../src/pipeline/lanes";

const SEEDS = ["everdusk-101", "seed-a", "seed-b"];
const PAVED = ZONE_KINDS.indexOf("paved");

function buildUntilBuildings(seed: string, over: Partial<Params> = {}): WorldModel {
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

function build(seed: string, over: Partial<Params> = {}): WorldModel {
  const model = buildUntilBuildings(seed, over);
  runLanes(model);
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

function lanesOf(model: WorldModel) {
  return model.network.edges.filter((e) => e.class === "lane");
}

function laneTotalLength(model: WorldModel): number {
  let len = 0;
  for (const lane of lanesOf(model)) len += pathLength(lane.path);
  return len;
}

describe("lanes: 決定性", () => {
  it("同一 seed + params で nodes / edges(小道込み)が完全一致する", () => {
    for (const seed of SEEDS) {
      const a = build(seed);
      const b = build(seed);
      expect(a.network.edges).toEqual(b.network.edges);
      expect(a.network.nodes).toEqual(b.network.nodes);
      expect(a.ground.zoneMask).toEqual(b.ground.zoneMask);
    }
  });
});

describe("lanes: 追記のみで既存 id を壊さない(contracts Network 節)", () => {
  it("段13 の前後で既存の nodes / edges / bridges が不変で、lane が追記される", () => {
    for (const seed of SEEDS) {
      const model = buildUntilBuildings(seed);
      const edgesBefore = structuredClone(model.network.edges);
      const nodesBefore = structuredClone(model.network.nodes);
      const bridgesBefore = structuredClone(model.water.bridges);
      runLanes(model);
      // 既存分は id・内容ともに一切変わらない(先頭が完全一致)
      expect(model.network.edges.slice(0, edgesBefore.length)).toEqual(
        edgesBefore,
      );
      expect(model.network.nodes.slice(0, nodesBefore.length)).toEqual(
        nodesBefore,
      );
      // 小道は水域を渡らないため bridges は不変(段8 の出力のまま)
      expect(model.water.bridges).toEqual(bridgesBefore);
      // 追記分はすべて lane
      for (const e of model.network.edges.slice(edgesBefore.length)) {
        expect(e.class).toBe("lane");
      }
      // id の一意性
      const ids = model.network.edges.map((e) => e.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
});

describe("lanes: 形質(幅・等級・id 体系)", () => {
  it("lane は幅 1.6・等級は道路より低く、id が由来体系に従う", () => {
    let laneTotal = 0;
    for (const seed of SEEDS) {
      const model = cached(seed);
      for (const lane of lanesOf(model)) {
        laneTotal++;
        expect(lane.width).toBe(LANE_WIDTH);
        expect(lane.grade).toBeCloseTo(
          Math.max(0, model.meta.derived.roadGrade - 0.5),
          9,
        );
        expect(lane.id).toMatch(/^lane\/(back|towpath)\//);
        expect(lane.from).toBe(`node/${lane.id}/a`);
        expect(lane.to).toBe(`node/${lane.id}/b`);
        // 両端点はノード位置と一致する
        const head = lane.path[0];
        const tail = lane.path[lane.path.length - 1];
        const nodeById = new Map(
          model.network.nodes.map((n) => [n.id, n.position]),
        );
        expect(nodeById.get(lane.from)).toEqual(head);
        expect(nodeById.get(lane.to)).toEqual(tail);
      }
    }
    expect(laneTotal).toBeGreaterThan(0);
  });
});

describe("lanes: Settlement 20/55/90 で小道量が単調に変わる", () => {
  it("小道の総延長が Settlement に対して単調に増える", () => {
    const totals = [20, 55, 90].map((settlement) => {
      let sum = 0;
      for (const seed of SEEDS) {
        sum += laneTotalLength(cached(seed, { settlement }));
      }
      return sum;
    });
    const [low, mid, high] = totals as [number, number, number];
    expect(low).toBeLessThan(mid);
    expect(mid).toBeLessThan(high);
    // 各 seed 単体でも単調(非減少)
    for (const seed of SEEDS) {
      const a = laneTotalLength(cached(seed, { settlement: 20 }));
      const b = laneTotalLength(cached(seed, { settlement: 55 }));
      const c = laneTotalLength(cached(seed, { settlement: 90 }));
      expect(a).toBeLessThanOrEqual(b);
      expect(b).toBeLessThanOrEqual(c);
    }
  });
});

describe("lanes: 衝突制約(contracts Network 節「小道の性質」)", () => {
  it("小道は水域(湖・池・水路)・建物・広場・境界外と衝突しない", () => {
    for (const seed of SEEDS) {
      for (const over of [{}, { water: 70 }, { settlement: 90 }]) {
        const model = cached(seed, over);
        const field = createWaterField(model.ground.boundary, [
          ...model.water.lakes,
          ...model.water.ponds,
        ]);
        for (const lane of lanesOf(model)) {
          const total = pathLength(lane.path);
          for (let s = 0; s <= total; s += 1.5) {
            const { p } = pointAlong(lane.path, s);
            // 水域を渡らない
            expect(field.waterSdf(p.x, p.z)).toBeGreaterThanOrEqual(
              LANE_WIDTH / 2 - 1e-9,
            );
            for (const canal of model.water.canals) {
              expect(
                distToPolyline(p.x, p.z, canal.points) - canal.width / 2,
              ).toBeGreaterThanOrEqual(0);
            }
            // 建物・広場と重ならない
            for (const b of model.buildings) {
              expect(
                polygonSignedDistance(p.x, p.z, b.footprint),
              ).toBeGreaterThan(0);
            }
            for (const plaza of model.plazas) {
              expect(
                polygonSignedDistance(p.x, p.z, plaza.polygon),
              ).toBeGreaterThan(0);
            }
          }
        }
      }
    }
  });

  it("結界環を横切らない(環への距離が保たれる)", () => {
    for (const seed of SEEDS) {
      const model = cached(seed, { settlement: 90 });
      const ring = model.wards.ringPath;
      if (ring.length < 3) continue;
      for (const lane of lanesOf(model)) {
        const total = pathLength(lane.path);
        let side: number | null = null;
        for (let s = 0; s <= total; s += 1.5) {
          const { p } = pointAlong(lane.path, s);
          const sdf = polygonSignedDistance(p.x, p.z, ring);
          // 環の壁帯(±2.0)に入らない
          expect(Math.abs(sdf)).toBeGreaterThan(1.0);
          // 符号(内外)が途中で変わらない = 横切らない
          const sign = sdf > 0 ? 1 : -1;
          if (side === null) side = sign;
          expect(sign).toBe(side);
        }
      }
    }
  });
});

describe("lanes: 岸沿い道(towpath)", () => {
  it("水路の towpathSide 側の護岸沿いに岸沿い道が通る", () => {
    let towpaths = 0;
    for (const seed of SEEDS) {
      for (const over of [{}, { settlement: 90 }, { water: 70, settlement: 90 }]) {
        const model = cached(seed, over);
        const canalById = new Map(model.water.canals.map((c) => [c.id, c]));
        for (const lane of lanesOf(model)) {
          const m = lane.id.match(/^lane\/towpath\/(canal\/[^/]+)\/\d+$/);
          if (!m) continue;
          towpaths++;
          const canal = canalById.get(m[1] ?? "");
          expect(canal).toBeDefined();
          if (!canal) continue;
          // 経路は水路中心線から「幅/2 + 1.35」前後の帯にある
          const expected = canal.width / 2 + 1.35;
          const total = pathLength(lane.path);
          for (let s = 0; s <= total; s += 2) {
            const { p } = pointAlong(lane.path, s);
            const d = distToPolyline(p.x, p.z, canal.points);
            expect(d).toBeGreaterThan(canal.width / 2 + 0.5);
            expect(d).toBeLessThan(expected + 1.5);
          }
          // towpathSide 側にある(経路中点で符号を確認)
          const mid = pointAlong(lane.path, total / 2).p;
          let bestDist = Infinity;
          let cross = 0;
          for (let i = 0; i + 1 < canal.points.length; i++) {
            const a = canal.points[i];
            const b = canal.points[i + 1];
            if (!a || !b) continue;
            const dx = b.x - a.x;
            const dz = b.z - a.z;
            const lenSq = dx * dx + dz * dz;
            if (lenSq < 1e-12) continue;
            const t = Math.min(
              1,
              Math.max(0, ((mid.x - a.x) * dx + (mid.z - a.z) * dz) / lenSq),
            );
            const qx = a.x + dx * t;
            const qz = a.z + dz * t;
            const d = Math.hypot(mid.x - qx, mid.z - qz);
            if (d < bestDist) {
              bestDist = d;
              // 左法線 (-dz, dx) との内積の符号 = +1 なら左岸
              cross = (mid.x - qx) * -dz + (mid.z - qz) * dx;
            }
          }
          expect(Math.sign(cross)).toBe(canal.towpathSide);
        }
      }
    }
    expect(towpaths).toBeGreaterThan(0);
  });
});

describe("lanes: zoneMask の舗装追記(contracts ZoneMask 節)", () => {
  it("小道の経路上で舗装チャネルが上書きされ、重みは非負・合計1を保つ", () => {
    for (const seed of SEEDS) {
      const model = cached(seed, { settlement: 90 });
      const mask = model.ground.zoneMask;
      expect(lanesOf(model).length).toBeGreaterThan(0);
      for (const lane of lanesOf(model)) {
        const total = pathLength(lane.path);
        for (const t of [0.3, 0.5, 0.7]) {
          const { p } = pointAlong(lane.path, total * t);
          const w = sampleZoneMask(mask, p.x, p.z).weights[PAVED] ?? 0;
          expect(w).toBeGreaterThan(0.25);
        }
      }
      const cells = mask.resolution * mask.resolution;
      for (let c = 0; c < cells; c++) {
        let sum = 0;
        for (let k = 0; k < ZONE_KINDS.length; k++) {
          const w = mask.weights[c * ZONE_KINDS.length + k] ?? -1;
          expect(w).toBeGreaterThanOrEqual(0);
          sum += w;
        }
        expect(sum).toBeCloseTo(1, 6);
      }
    }
  });

  it("summary.scale.roadLength に小道の総延長が加算される", () => {
    for (const seed of SEEDS) {
      const before = buildUntilBuildings(seed);
      const lengthBefore = before.summary.scale.roadLength;
      runLanes(before);
      expect(before.summary.scale.roadLength).toBeCloseTo(
        lengthBefore + laneTotalLength(before),
        6,
      );
    }
  });
});
