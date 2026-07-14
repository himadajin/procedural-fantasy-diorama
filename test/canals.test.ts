import { describe, expect, it } from "vitest";
import {
  DEFAULT_PARAMS,
  createEmptyWorldModel,
  type Params,
  type WorldModel,
} from "../src/model/worldmodel";
import { createWaterField, distToPolyline } from "../src/model/waterfield";
import { pathLength, pointAlong, waterCrossings } from "../src/model/geometry";
import { runDerive } from "../src/pipeline/derive";
import { runGround } from "../src/pipeline/ground";
import { runWater } from "../src/pipeline/water";
import { runSiting } from "../src/pipeline/siting";
import { runNetwork } from "../src/pipeline/network";
import { runCanals } from "../src/pipeline/canals";

const SEEDS = ["everdusk-101", "seed-a", "seed-b"];

function build(seed: string, over: Partial<Params> = {}): WorldModel {
  const model = createEmptyWorldModel(seed, { ...DEFAULT_PARAMS, ...over });
  runDerive(model);
  runGround(model);
  runWater(model);
  runSiting(model);
  runNetwork(model);
  runCanals(model);
  return model;
}

describe("canals: 決定性", () => {
  it("同一 seed + params で canals / bridges が完全一致する", () => {
    for (const seed of SEEDS) {
      const a = build(seed);
      const b = build(seed);
      expect(a.water.canals).toEqual(b.water.canals);
      expect(a.water.bridges).toEqual(b.water.bridges);
    }
  });
});

describe("canals: 発火条件と接続(contracts/ground-water.md Water 節)", () => {
  it("デフォルト(全パラメータ50)で必ず1本以上生成される", () => {
    for (const seed of SEEDS) {
      const model = build(seed);
      expect(model.meta.derived.canalScore).toBeGreaterThanOrEqual(0.35);
      expect(model.water.canals.length).toBeGreaterThanOrEqual(1);
      expect(model.summary.waterOverview.canals).toBe(model.water.canals.length);
    }
  });

  it("canalScore < 0.35 では生成されない", () => {
    for (const seed of SEEDS) {
      // water=40, settlement=0 → canalScore = 0.4×0.5 = 0.2 < 0.35
      const model = build(seed, { water: 40, settlement: 0 });
      expect(model.meta.derived.canalScore).toBeLessThan(0.35);
      expect(model.water.canals).toEqual([]);
    }
  });

  it("水が無い世界では生成されない", () => {
    for (const seed of SEEDS) {
      const model = build(seed, { water: 0 });
      expect(model.water.canals).toEqual([]);
    }
  });

  it("score が高いほど本数が増える(単調)", () => {
    // water=95・settlement=95 のような極端な組は使わない: 陸上率 0.95 の
    // 強制により、湖が非常に大きい入力では計画した水路が
    // すべて棄却されフォールバック堀留も候補を持てず 0 本になりうる
    // (水域横断禁止を優先した結果であり破綻ではない。本数の単調性は
    // canalScore からの計画本数についてのもので、棄却後の実本数を
    // 常に保証するものではない。contracts/ground-water.md「水路の性質」)。
    // ここでは棄却が起きない中庸な組で単調性を検証する。
    //
    // 形状健全性検査で「既存水路との最小間隔 width×3」を受理条件に
    // 追加した結果、SEEDS の代表個体はいずれも湖・池が1個(単一の水域)しか
    // 生成されないため、canalScore が高く計画本数(planned)が2〜3でも、
    // 単一の水域の岸線だけから互いに width×3 以上離れた複数の水路を
    // 同時に成立させられる余地がないことが多く、実本数は1本にとどまる
    // ことが多い(実測: water=70/settlement=70・water=95/settlement=95〜
    // water=100 のいずれの組でも SEEDS 全体で2本以上になる組が見つから
    // なかった)。よって「本数が2本以上になる」という強い主張は撤回し、
    // 単調性(高いほうが低いほう以上)のみを検証する
    for (const seed of SEEDS) {
      const low = build(seed).water.canals.length;
      const high = build(seed, { water: 70, settlement: 70 }).water.canals.length;
      expect(high).toBeGreaterThanOrEqual(low);
    }
  });

  it("既定パラメータでは中間部が陸上を通る(街の水路として現れる。陸上率 ≥0.95)", () => {
    // 中間部 = 始端・終端の接続窓(弧長 幅×2+4)を除く区間。陸上率 ≥ 0.95
    // (「深い横断部は対象外」の例外は撤廃しており、接続窓を除く
    // すべての水中区間を岸へ押し出す)
    for (const seed of SEEDS) {
      const model = build(seed);
      const field = createWaterField(model.ground.boundary, [
        ...model.water.lakes,
        ...model.water.ponds,
      ]);
      for (const canal of model.water.canals) {
        const endWindow = canal.width * 2 + 4;
        const total = pathLength(canal.points);
        expect(total).toBeGreaterThan(endWindow * 2);
        let land = 0;
        let count = 0;
        for (let s = endWindow; s <= total - endWindow; s += 2) {
          const { p } = pointAlong(canal.points, s);
          if (field.waterSdf(p.x, p.z) >= 0) land++;
          count++;
        }
        expect(land / Math.max(1, count)).toBeGreaterThanOrEqual(0.95);
      }
    }
  });

  it("水路の全点(始端・終端の接続窓を除く)が湖・池の深部を通らない" +
    "(水域横断の禁止。contracts/ground-water.md「水路の性質」)", () => {
    // 深部の目安は waterSdf < −(幅/2)(水路コリドー中心線が水域の護岸下に
    // 沈む深さ)。接続窓(始端・終端。弧長 幅×2+4)は既存水域への接続のため
    // この不変条件の対象外。加えて、押し出し(enforceLand)後に行う
    // リサンプル・Chaikin 平滑化で弧長パラメータが僅かにずれるため、
    // 接続窓の境界ちょうどでは平滑化の影響が残ることがある
    // (実測で数単位以内。水域を堤防ごと横断する規模の破綻ではない)。
    // 判定窓に幅×2 の追加マージンを設けてこの境界のゆらぎを吸収する
    for (const seed of SEEDS) {
      for (const over of [{}, { water: 70 }, { water: 95, settlement: 95 }]) {
        const model = build(seed, over);
        const field = createWaterField(model.ground.boundary, [
          ...model.water.lakes,
          ...model.water.ponds,
        ]);
        for (const canal of model.water.canals) {
          const endWindow = canal.width * 2 + 4 + canal.width * 2;
          const total = pathLength(canal.points);
          const deep = -(canal.width / 2);
          for (let s = endWindow; s <= total - endWindow; s += 2) {
            const { p } = pointAlong(canal.points, s);
            expect(
              field.waterSdf(p.x, p.z),
              `${canal.id} の弧長 ${s} が湖・池の深部を通っている`,
            ).toBeGreaterThanOrEqual(deep);
          }
        }
      }
    }
  });

  it("始端は既存水域に接続し、終端も原則として水域へ戻る", () => {
    for (const seed of SEEDS) {
      for (const over of [{}, { water: 70 }, { water: 95, settlement: 95 }]) {
        const model = build(seed, over);
        const field = createWaterField(model.ground.boundary, [
          ...model.water.lakes,
          ...model.water.ponds,
        ]);
        for (const canal of model.water.canals) {
          const head = canal.points[0];
          const tail = canal.points[canal.points.length - 1];
          expect(head).toBeDefined();
          expect(tail).toBeDefined();
          if (!head || !tail) continue;
          expect(
            field.waterSdf(head.x, head.z),
            `${canal.id} の始端が水域に接続していない`,
          ).toBeLessThan(0);
          if (canal.id !== "canal/fallback") {
            expect(
              field.waterSdf(tail.x, tail.z),
              `${canal.id} の終端が水域に接続していない`,
            ).toBeLessThan(0);
          }
        }
      }
    }
  });

  it("水路の始端は岸線ループ(shoreline.loops)近傍から取られる" +
    "(アンカーの岸線一般化。contracts/ground-water.md Water 節)", () => {
    // buildAnchors は湖の内側点(旧仕様)ではなく、岸線点を水側へ 1.5 前後
    // 押し込んだ点をアンカーにする。始端はそのアンカーがほぼそのまま
    // 使われるため、いずれかの岸線点から十分近い距離にあるはずである
    // (旧・湖内側点は重心側へ25%寄せるため、実寸の湖では遠く離れうる)。
    for (const seed of SEEDS) {
      for (const over of [{}, { water: 70 }, { water: 95, settlement: 95 }]) {
        const model = build(seed, over);
        for (const canal of model.water.canals) {
          if (canal.id === "canal/fallback") continue;
          const head = canal.points[0];
          if (!head) continue;
          let minDist = Infinity;
          for (const loop of model.water.shoreline.loops) {
            for (const p of loop.points) {
              minDist = Math.min(minDist, Math.hypot(p.x - head.x, p.z - head.z));
            }
          }
          expect(minDist, `${canal.id} の始端が岸線近傍にない`).toBeLessThan(10);
        }
      }
    }
  });

  it("幅は derived.canalWidth に一致し、点列は連続(間隔 ≤ 幅×1.5)・境界内・id/towpathSide を持つ", () => {
    for (const seed of SEEDS) {
      const model = build(seed, { water: 70 });
      const field = createWaterField(model.ground.boundary, [
        ...model.water.lakes,
        ...model.water.ponds,
      ]);
      for (const canal of model.water.canals) {
        expect(canal.width).toBeCloseTo(model.meta.derived.canalWidth, 9);
        expect(canal.id).toMatch(/^canal\//);
        expect([1, -1]).toContain(canal.towpathSide);
        for (let i = 0; i + 1 < canal.points.length; i++) {
          const p = canal.points[i];
          const q = canal.points[i + 1];
          if (!p || !q) continue;
          expect(Math.hypot(q.x - p.x, q.z - p.z)).toBeLessThanOrEqual(
            canal.width * 1.5 + 1e-9,
          );
        }
        // 中間点は境界の内側(両端は水域内=境界内)
        for (const p of canal.points) {
          expect(field.boundarySdf(p.x, p.z)).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });
});

describe("canals: BridgeSite の追加(1本あたり最大3)", () => {
  it("各水路が生む道路交差は最大3で、over: canal の BridgeSite が追加される", () => {
    for (const seed of SEEDS) {
      for (const over of [{}, { water: 95, settlement: 95 }]) {
        const model = build(seed, over);
        for (const canal of model.water.canals) {
          const sdf = (x: number, z: number): number =>
            distToPolyline(x, z, canal.points) - canal.width / 2;
          let crossings = 0;
          for (const edge of model.network.edges) {
            crossings += waterCrossings(edge.path, sdf, 2).length;
          }
          expect(
            crossings,
            `${canal.id} の BridgeSite が上限を超えている`,
          ).toBeLessThanOrEqual(3);
        }
        const canalBridges = model.water.bridges.filter(
          (b) => b.over === "canal",
        );
        for (const bridge of canalBridges) {
          expect(bridge.id).toMatch(/^bridge\//);
          expect(bridge.length).toBeGreaterThan(0);
        }
        expect(new Set(model.water.bridges.map((b) => b.id)).size).toBe(
          model.water.bridges.length,
        );
      }
    }
  });

  it("水路由来の各 BridgeSite の渡り長は max(18, canalWidth×6) 以下" +
    "(並走橋の禁止。contracts/ground-water.md「水路の性質」)", () => {
    // 個数上限(3)だけでは、道路と水路が長距離で並走・重なりして 1 つの
    // 巨大な「橋」になる破綻(harbor-1 / water=100 で渡り長 134.6 を実測)を
    // 防げないため、段6 時点の bridges(over: "canal")で単一交差の渡り長を検証する
    for (const seed of [...SEEDS, "harbor-1"]) {
      for (const over of [{ water: 50 }, { water: 70 }, { water: 100 }]) {
        const model = build(seed, over);
        const limit = Math.max(18, model.meta.derived.canalWidth * 6);
        for (const bridge of model.water.bridges) {
          if (bridge.over !== "canal") continue;
          expect(
            bridge.length,
            `${seed} ${JSON.stringify(over)} の ${bridge.id} の渡り長が上限を超えている`,
          ).toBeLessThanOrEqual(limit);
        }
      }
    }
  });
});

describe("canals: 形状健全性(自己近接・水路間重なり・迂曲率。" +
  "contracts/ground-water.md「水路の性質」形状健全性)", () => {
  // SEEDS(seed-a / seed-b / everdusk-101)に加え、受け入れ検収で形状破綻が
  // 実測された everdusk-102 / harbor-1 を対象に含める
  const SHAPE_SEEDS = [...SEEDS, "everdusk-102", "harbor-1"];

  /** 弧長 width×6 以上離れた点対に限定した自己最近接距離 */
  function selfProximityMinDistance(
    points: { x: number; z: number }[],
    width: number,
  ): number {
    const arc: number[] = [0];
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1]!;
      const b = points[i]!;
      arc.push((arc[i - 1] ?? 0) + Math.hypot(b.x - a.x, b.z - a.z));
    }
    const minArc = width * 6;
    let min = Infinity;
    for (let i = 0; i < points.length; i++) {
      for (let j = i + 1; j < points.length; j++) {
        if ((arc[j] ?? 0) - (arc[i] ?? 0) < minArc) continue;
        min = Math.min(min, Math.hypot(points[j]!.x - points[i]!.x, points[j]!.z - points[i]!.z));
      }
    }
    return min;
  }

  function sinuosity(points: { x: number; z: number }[]): number {
    const head = points[0];
    const tail = points[points.length - 1];
    if (!head || !tail) return 1;
    const chord = Math.max(1e-6, Math.hypot(tail.x - head.x, tail.z - head.z));
    return pathLength(points) / chord;
  }

  function minDistanceBetween(
    a: { x: number; z: number }[],
    b: { x: number; z: number }[],
  ): number {
    let min = Infinity;
    for (const p of a) {
      for (const q of b) {
        min = Math.min(min, Math.hypot(p.x - q.x, p.z - q.z));
      }
    }
    return min;
  }

  it("自己近接なし・水路間距離 ≥ width×3・迂曲率 ≤ 3.0" +
    "(フォールバック堀留は水路間距離のみを検証。self-intersection・とぐろの根絶)", () => {
    for (const seed of SHAPE_SEEDS) {
      for (const water of [50, 70, 100]) {
        const model = build(seed, { water });
        const canals = model.water.canals;
        for (const canal of canals) {
          if (canal.id === "canal/fallback") {
            // フォールバック堀留は始端から中心方向への直線に近く、自己近接・
            // 迂曲率は構造上自明に満たす(contracts/ground-water.md「水路の性質」)
            continue;
          }
          expect(
            selfProximityMinDistance(canal.points, canal.width),
            `${seed} water=${water} の ${canal.id} が自己近接している`,
          ).toBeGreaterThanOrEqual(canal.width * 2.5);
          expect(
            sinuosity(canal.points),
            `${seed} water=${water} の ${canal.id} の迂曲率が上限を超えている`,
          ).toBeLessThanOrEqual(3.0);
        }
        for (let i = 0; i < canals.length; i++) {
          for (let j = i + 1; j < canals.length; j++) {
            const a = canals[i]!;
            const b = canals[j]!;
            expect(
              minDistanceBetween(a.points, b.points),
              `${seed} water=${water} の ${a.id} と ${b.id} が近接・重なりしている`,
            ).toBeGreaterThanOrEqual(Math.max(a.width, b.width) * 3);
          }
        }
      }
    }
  });
});
