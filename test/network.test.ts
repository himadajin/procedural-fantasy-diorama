import { describe, expect, it } from "vitest";
import {
  DEFAULT_PARAMS,
  createEmptyWorldModel,
  type Params,
  type Vec2,
  type WorldModel,
} from "../src/model/worldmodel";
import { createWaterField } from "../src/model/waterfield";
import { runDerive } from "../src/pipeline/derive";
import { runGround } from "../src/pipeline/ground";
import { runWater } from "../src/pipeline/water";
import { runSiting } from "../src/pipeline/siting";
import { runNetwork } from "../src/pipeline/network";

const SEEDS = ["seed-a", "seed-b", "everdusk-101"];
/** 川を持つ代表 seed(water=70。事前に確認済み) */
const RIVER_SEEDS = ["seed-a", "seed-b", "seed-c"];

function build(seed: string, over: Partial<Params> = {}): WorldModel {
  const model = createEmptyWorldModel(seed, { ...DEFAULT_PARAMS, ...over });
  runDerive(model);
  runGround(model);
  runWater(model);
  runSiting(model);
  runNetwork(model);
  return model;
}

function pathLength(points: Vec2[]): number {
  let len = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (!a || !b) continue;
    len += Math.hypot(b.x - a.x, b.z - a.z);
  }
  return len;
}

/** edges のグラフを BFS し、start ノードから到達できるノード id の集合を返す */
function reachableFrom(model: WorldModel, startId: string): Set<string> {
  const graph = new Map<string, string[]>();
  for (const edge of model.network.edges) {
    graph.set(edge.from, [...(graph.get(edge.from) ?? []), edge.to]);
    graph.set(edge.to, [...(graph.get(edge.to) ?? []), edge.from]);
  }
  const reached = new Set<string>([startId]);
  const queue = [startId];
  while (queue.length > 0) {
    const cur = queue.shift();
    if (cur === undefined) break;
    for (const nb of graph.get(cur) ?? []) {
      if (!reached.has(nb)) {
        reached.add(nb);
        queue.push(nb);
      }
    }
  }
  return reached;
}

/** position が一致するノードの id を返す */
function nodeAt(model: WorldModel, p: Vec2): string {
  const node = model.network.nodes.find(
    (n) => Math.hypot(n.position.x - p.x, n.position.z - p.z) < 1e-9,
  );
  if (!node) throw new Error(`node not found at (${p.x}, ${p.z})`);
  return node.id;
}

describe("network: 決定性", () => {
  it("同一 seed + params で nodes / edges / entryPoints / bridges が完全一致する", () => {
    for (const seed of SEEDS) {
      const a = build(seed, { water: 70 });
      const b = build(seed, { water: 70 });
      expect(a.network).toEqual(b.network);
      expect(a.water.bridges).toEqual(b.water.bridges);
    }
  });

  it("seed が異なれば道路網が変わる", () => {
    expect(build("seed-a").network.edges).not.toEqual(
      build("seed-b").network.edges,
    );
  });
});

describe("network: 到達性(全進入点→中心)", () => {
  it("すべての進入点ノードから中心ノードへグラフ上で到達できる", () => {
    for (const seed of SEEDS) {
      for (const over of [
        {},
        { water: 0 },
        { water: 95 },
        { worldScale: 0 },
        { worldScale: 100 },
      ] satisfies Partial<Params>[]) {
        const model = build(seed, over);
        const reached = reachableFrom(model, nodeAt(model, model.centerPlan.position));
        for (const entry of model.network.entryPoints) {
          expect(
            reached.has(nodeAt(model, entry.position)),
            `seed=${seed} ${JSON.stringify(over)} ${entry.id} が中心へ到達できない`,
          ).toBe(true);
        }
      }
    }
  });
});

describe("network: グラフの整合", () => {
  it("edge の両端点は from / to ノードの position と一致し、id は一意", () => {
    for (const seed of SEEDS) {
      const model = build(seed, { water: 70 });
      const byId = new Map(model.network.nodes.map((n) => [n.id, n.position]));
      expect(new Set(model.network.nodes.map((n) => n.id)).size).toBe(
        model.network.nodes.length,
      );
      expect(new Set(model.network.edges.map((e) => e.id)).size).toBe(
        model.network.edges.length,
      );
      for (const edge of model.network.edges) {
        const from = byId.get(edge.from);
        const to = byId.get(edge.to);
        if (!from || !to) throw new Error(`edge ${edge.id} のノードがない`);
        expect(edge.path.length).toBeGreaterThanOrEqual(2);
        expect(edge.path[0]).toEqual(from);
        expect(edge.path[edge.path.length - 1]).toEqual(to);
      }
    }
  });

  it("種別は main / connector のみで、幅・等級が契約に従う", () => {
    for (const seed of SEEDS) {
      const model = build(seed, { water: 70 });
      const grade = model.meta.derived.roadGrade;
      expect(model.network.edges.some((e) => e.class === "main")).toBe(true);
      for (const edge of model.network.edges) {
        expect(["main", "connector"]).toContain(edge.class);
        expect(edge.width).toBe(edge.class === "main" ? 3.6 : 2.6);
        expect(edge.grade).toBeGreaterThanOrEqual(0);
        expect(edge.grade).toBeLessThanOrEqual(2);
        if (edge.class === "main") {
          expect(edge.grade).toBeCloseTo(Math.min(2, grade + 0.3), 9);
        } else {
          expect(edge.grade).toBeCloseTo(grade, 9);
        }
      }
    }
  });

  it("summary.scale.roadLength が edge path の総延長と一致する", () => {
    for (const seed of SEEDS) {
      const model = build(seed);
      const total = model.network.edges.reduce(
        (s, e) => s + pathLength(e.path),
        0,
      );
      expect(model.summary.scale.roadLength).toBeCloseTo(total, 6);
      expect(total).toBeGreaterThan(0);
    }
  });
});

describe("network: 橋(BridgeSite)", () => {
  it("水域を渡る edge は必ず対応する BridgeSite を持つ(代表 seed×params)", () => {
    for (const seed of RIVER_SEEDS) {
      for (const water of [50, 70, 95]) {
        const model = build(seed, { water });
        const field = createWaterField(
          model.ground.boundary,
          model.water.rivers,
          model.water.lakes,
        );
        for (const edge of model.network.edges) {
          const total = pathLength(edge.path);
          const count = Math.max(2, Math.ceil(total / 1.5));
          for (let i = 0; i <= count; i++) {
            const s = (i / count) * total;
            // 弧長 s の点を線形に求める
            let acc = 0;
            let p: Vec2 = edge.path[0] ?? { x: 0, z: 0 };
            for (let k = 0; k + 1 < edge.path.length; k++) {
              const a = edge.path[k];
              const b = edge.path[k + 1];
              if (!a || !b) continue;
              const seg = Math.hypot(b.x - a.x, b.z - a.z);
              if (acc + seg >= s || k + 2 === edge.path.length) {
                const t = seg > 1e-9 ? Math.min(1, Math.max(0, (s - acc) / seg)) : 0;
                p = { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
                break;
              }
              acc += seg;
            }
            // 明確に水中の道路点は、いずれかの橋の渡り区間に覆われている
            if (field.waterSdf(p.x, p.z) < -0.1) {
              const covered = model.water.bridges.some(
                (br) =>
                  Math.hypot(br.position.x - p.x, br.position.z - p.z) <=
                  br.length / 2 + 3,
              );
              expect(
                covered,
                `seed=${seed} water=${water} edge=${edge.id} の水中区間が橋に覆われていない`,
              ).toBe(true);
            }
          }
        }
      }
    }
  });

  it("川を持つ世界では橋が1つ以上でき、属性が妥当", () => {
    for (const seed of RIVER_SEEDS) {
      const model = build(seed, { water: 70 });
      expect(model.water.bridges.length).toBeGreaterThanOrEqual(1);
      const field = createWaterField(
        model.ground.boundary,
        model.water.rivers,
        model.water.lakes,
      );
      expect(new Set(model.water.bridges.map((b) => b.id)).size).toBe(
        model.water.bridges.length,
      );
      for (const bridge of model.water.bridges) {
        expect(["river", "lake"]).toContain(bridge.over);
        expect(["main", "connector"]).toContain(bridge.roadClass);
        expect(bridge.width).toBeGreaterThan(0);
        expect(bridge.length).toBeGreaterThan(0);
        expect(Number.isFinite(bridge.angle)).toBe(true);
        // 渡り区間の中点は水中(標本化の線形補間ぶんの許容)
        expect(
          field.waterSdf(bridge.position.x, bridge.position.z),
        ).toBeLessThan(0.5);
      }
      expect(model.summary.waterOverview.bridges).toBe(
        model.water.bridges.length,
      );
    }
  });

  it("水が無い世界では橋がなく、道路網は成立する", () => {
    for (const seed of SEEDS) {
      const model = build(seed, { water: 0 });
      expect(model.water.bridges).toEqual([]);
      expect(model.network.edges.length).toBeGreaterThan(0);
    }
  });
});
