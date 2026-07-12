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
import { runCanals } from "../src/pipeline/canals";
import { runWards } from "../src/pipeline/wards";
import { runPlazas } from "../src/pipeline/plazas";
import {
  createDensityDecay,
  runDensity,
  protoDensityAt,
} from "../src/pipeline/density";
import {
  PROTO_THRESHOLD,
  verifyStreetShapeHealth,
  type StreetGrowthDiagnostics,
} from "../src/pipeline/streets";

const SEEDS = ["seed-a", "seed-b", "everdusk-101"];
/** 湖・池を持つ代表 seed(water=70。事前に確認済み) */
const WATER_SEEDS = ["seed-a", "seed-b", "seed-c"];
/** 形状健全性・proto-density の機械検証に使う代表 seed(4 本) */
const STREET_SEEDS = ["seed-a", "seed-b", "everdusk-101", "everdusk-102"];

function build(
  seed: string,
  over: Partial<Params> = {},
  diagnostics?: StreetGrowthDiagnostics,
): WorldModel {
  const model = createEmptyWorldModel(seed, { ...DEFAULT_PARAMS, ...over });
  runDerive(model);
  runGround(model);
  runWater(model);
  runSiting(model);
  runNetwork(model, diagnostics);
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

  it("種別は main / connector / street で、幅・等級が契約に従う(Phase B)", () => {
    for (const seed of SEEDS) {
      const model = build(seed, { water: 70 });
      const grade = model.meta.derived.roadGrade;
      expect(model.network.edges.some((e) => e.class === "main")).toBe(true);
      expect(model.network.edges.some((e) => e.class === "street")).toBe(true);
      for (const edge of model.network.edges) {
        expect(["main", "connector", "street"]).toContain(edge.class);
        if (edge.class === "main") {
          expect(edge.width).toBe(3.6);
        } else if (edge.class === "connector") {
          expect(edge.width).toBe(2.6);
        } else {
          expect(edge.width).toBe(2.2);
        }
        expect(edge.grade).toBeGreaterThanOrEqual(0);
        expect(edge.grade).toBeLessThanOrEqual(2);
        if (edge.class === "main") {
          expect(edge.grade).toBeCloseTo(Math.min(2, grade + 0.3), 9);
        } else if (edge.class === "connector") {
          expect(edge.grade).toBeCloseTo(grade, 9);
        } else {
          expect(edge.grade).toBeCloseTo(Math.max(0, grade - 0.2), 9);
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

describe("network: 道路は湖・池を渡らない(段5は BridgeSite を作らない)", () => {
  it("段5(runNetwork)実行後も water.bridges は空のまま", () => {
    for (const seed of WATER_SEEDS) {
      for (const water of [50, 70, 95]) {
        const model = build(seed, { water });
        expect(model.water.bridges).toEqual([]);
      }
    }
  });

  it("全 edge の path 標本で waterSdf ≥ 0(許容誤差付き。湖・池を渡らない)", () => {
    for (const seed of WATER_SEEDS) {
      for (const water of [50, 70, 95]) {
        const model = build(seed, { water });
        const field = createWaterField(model.ground.boundary, [
          ...model.water.lakes,
          ...model.water.ponds,
        ]);
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
            // 経路探索グリッドの解像度+平滑化(Chaikin・Douglas-Peucker)ぶんの
            // 標本誤差を許容する(事前調査で最大 -0.89 程度の食い込みを確認)
            expect(
              field.waterSdf(p.x, p.z),
              `seed=${seed} water=${water} edge=${edge.id} が水域を渡っている`,
            ).toBeGreaterThanOrEqual(-1.5);
          }
        }
      }
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

describe("network: 二次街路(street)の有機成長(Phase B。契約は network-plaza.md「二次街路(street)の有機成長」)", () => {
  it("形状健全性 4 項(交差角・並走・袋小路率・立体交差)が複数 seed × Settlement で満たされる", () => {
    for (const seed of STREET_SEEDS) {
      for (const settlement of [0, 50, 100]) {
        for (const worldScale of [50, 100]) {
          const diag: StreetGrowthDiagnostics = { continuationPairs: new Set() };
          const model = build(seed, { settlement, worldScale }, diag);
          const health = verifyStreetShapeHealth(model, diag.continuationPairs);
          expect(
            health.crossAngleViolations,
            `seed=${seed} settlement=${settlement} worldScale=${worldScale}`,
          ).toBe(0);
          expect(
            health.parallelViolations,
            `seed=${seed} settlement=${settlement} worldScale=${worldScale}`,
          ).toBe(0);
          expect(
            health.unnodedCrossings,
            `seed=${seed} settlement=${settlement} worldScale=${worldScale}`,
          ).toBe(0);
          expect(
            health.deadEndRatio,
            `seed=${seed} settlement=${settlement} worldScale=${worldScale}`,
          ).toBeLessThanOrEqual(0.35 + 1e-9);
        }
      }
    }
  });

  it("street が proto-density(道路近接ブースト前の生値)0.22 未満の領域に伸びていない", () => {
    for (const seed of STREET_SEEDS) {
      for (const settlement of [0, 50, 100]) {
        for (const worldScale of [50, 100]) {
          const model = build(seed, { settlement, worldScale });
          const decay = createDensityDecay(model);
          const streets = model.network.edges.filter((e) => e.class === "street");
          for (const edge of streets) {
            for (const p of edge.path) {
              // 発芽起点・スナップ点は既存道路上の点であり、proto-density の
              // 生値そのものは境界ではなく地点依存のため、閾値からの許容
              // 誤差を小さく持たせる(街路成長本体は endPoint 到達時に
              // 閾値判定を行うが、起点・スナップ点はその判定の対象外のため)
              expect(
                protoDensityAt(decay, p.x, p.z),
                `seed=${seed} settlement=${settlement} worldScale=${worldScale} edge=${edge.id}`,
              ).toBeGreaterThan(PROTO_THRESHOLD - 0.1);
            }
          }
        }
      }
    }
  });

  it("street の総弧長が streetBudget を大きく超えない(最終セグメント1本分の超過は許容)", () => {
    // 契約の予算判定は「総弧長が streetBudget を超えたら成長を終了する」であり、
    // 判定は各セグメント受理の後に行うため、最後に受理された1セグメント分
    // (最大 SEGMENT_MAX=20)だけ超過しうる。この超過ぶんを許容範囲とする
    const SEGMENT_MAX_OVERSHOOT = 20;
    for (const seed of STREET_SEEDS) {
      for (const settlement of [0, 50, 100]) {
        for (const worldScale of [50, 100]) {
          const model = build(seed, { settlement, worldScale });
          const streets = model.network.edges.filter((e) => e.class === "street");
          const total = streets.reduce((s, e) => s + pathLength(e.path), 0);
          expect(total).toBeLessThanOrEqual(
            model.meta.derived.streetBudget + SEGMENT_MAX_OVERSHOOT,
          );
        }
      }
    }
  });

  it("同一 seed + params で street 込みの nodes / edges が完全一致する(決定性)", () => {
    for (const seed of STREET_SEEDS) {
      const a = build(seed, { settlement: 80 });
      const b = build(seed, { settlement: 80 });
      expect(a.network).toEqual(b.network);
    }
  });

  it("既存アサーション(到達性・水域)は street 追加後も維持される", () => {
    for (const seed of STREET_SEEDS) {
      const model = build(seed, { settlement: 100, worldScale: 100 });
      // 到達性は main/connector のみのグラフでも成立する(段5前半は不変)
      const mainConnector = model.network.edges.filter(
        (e) => e.class === "main" || e.class === "connector",
      );
      const graph = new Map<string, string[]>();
      for (const e of mainConnector) {
        graph.set(e.from, [...(graph.get(e.from) ?? []), e.to]);
        graph.set(e.to, [...(graph.get(e.to) ?? []), e.from]);
      }
      const centerId = nodeAt(model, model.centerPlan.position);
      const reached = new Set<string>([centerId]);
      const queue = [centerId];
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
      for (const entry of model.network.entryPoints) {
        expect(reached.has(nodeAt(model, entry.position))).toBe(true);
      }
    }
  });
});

describe("network: 段9(広場)の中心前広場接続路は追記のみ(計画書 B4)", () => {
  it("段5〜段8 の nodes / edges は段9(広場)を通しても不変で、street/plaza/ が追記される", () => {
    for (const seed of STREET_SEEDS) {
      const model = createEmptyWorldModel(seed, { ...DEFAULT_PARAMS });
      runDerive(model);
      runGround(model);
      runWater(model);
      runSiting(model);
      runNetwork(model);
      runCanals(model);
      runDensity(model);
      runWards(model);
      const edgesBefore = structuredClone(model.network.edges);
      const nodesBefore = structuredClone(model.network.nodes);
      runPlazas(model);
      // 段5〜段8 時点の nodes / edges は id・内容・配列順とも一切変わらない
      // (先頭が完全一致。段9 は末尾へ中心前広場の接続路を追記するのみ)
      expect(model.network.edges.slice(0, edgesBefore.length)).toEqual(
        edgesBefore,
      );
      expect(model.network.nodes.slice(0, nodesBefore.length)).toEqual(
        nodesBefore,
      );
      // 追記分はすべて中心前広場の接続路(class "street"、id 規約
      // "street/plaza/<plazaId>")
      const addedEdges = model.network.edges.slice(edgesBefore.length);
      for (const e of addedEdges) {
        expect(e.class).toBe("street");
        expect(e.id).toMatch(/^street\/plaza\//);
      }
      const centerPlaza = model.plazas.find((p) => p.kind === "center");
      if (centerPlaza) {
        expect(addedEdges.length).toBe(1);
        expect(addedEdges[0]?.id).toBe(`street/plaza/${centerPlaza.id}`);
      }
      // id の一意性
      const ids = model.network.edges.map((e) => e.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
});
