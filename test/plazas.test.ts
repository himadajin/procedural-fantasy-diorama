import { describe, expect, it } from "vitest";
import { DEFAULT_PARAMS, type Params, type WorldModel } from "../src/model/worldmodel";
import {
  createWaterField,
  distToPolyline,
  pointInPolygon,
  polygonSignedDistance,
} from "../src/model/waterfield";
import { resamplePath } from "../src/model/geometry";
import { runPipeline } from "../src/pipeline/run";
import { CONNECTOR_FACING_TOLERANCE } from "../src/pipeline/plazas";

const SEEDS = ["everdusk-101", "seed-a", "seed-b"];

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

describe("plazas: 決定性", () => {
  it("同一 seed + params で plazas / centerPlan が完全一致する", async () => {
    for (const seed of SEEDS) {
      const a = await buildFresh(seed);
      const b = await buildFresh(seed);
      expect(a.plazas).toEqual(b.plazas);
      expect(a.centerPlan).toEqual(b.centerPlan);
    }
  });
});

describe("plazas: 空地ポリゴンの確定(contracts/network-plaza.md Plaza 節)", () => {
  it("中心前広場が存在し、種別が契約の範囲(courtyard は段12 の中庭・一般建物の中庭型クラスタのみ)", async () => {
    for (const seed of SEEDS) {
      for (const over of [{}, { water: 70 }, { monumentality: 95 }]) {
        const model = await build(seed, over);
        const kinds = model.plazas.map((p) => p.kind);
        expect(kinds).toContain("center");
        expect(kinds.filter((k) => k === "center").length).toBe(1);
        for (const p of model.plazas) {
          expect(["center", "gate", "bridgehead", "crossing", "courtyard"]).toContain(
            p.kind,
          );
          expect(p.radius).toBeGreaterThan(0);
          if (p.kind === "courtyard") {
            // 中庭は段12 の中心建築展開(id "plaza/courtyard")、または
            // 一般建物の中庭型クラスタ(id "plaza/courtyard/<groupId>")の
            // いずれかが追加する矩形(契約の例外)
            expect(
              p.id === "plaza/courtyard" ||
                p.id.startsWith("plaza/courtyard/"),
            ).toBe(true);
            expect(p.polygon.length).toBe(4);
          } else {
            expect(p.polygon.length).toBeGreaterThanOrEqual(8);
          }
          expect(p.id).toMatch(/^plaza\//);
        }
        expect(new Set(model.plazas.map((p) => p.id)).size).toBe(
          model.plazas.length,
        );
      }
    }
  });

  it("一般建物の中庭型クラスタの courtyard Plaza が id 空間を汚さず、非重複に現れる", async () => {
    // Settlement/Prosperity を振って中庭型が実際に成立する条件を広く走査する
    const SWEEP: Partial<Params>[] = [
      { settlement: 50, prosperity: 50 },
      { settlement: 100, prosperity: 100 },
      { settlement: 80, prosperity: 90 },
    ];
    let generalCourtyards = 0;
    for (const seed of SEEDS) {
      for (const over of SWEEP) {
        const model = await build(seed, over);
        const generalCourtyardPlazas = model.plazas.filter(
          (p) =>
            p.kind === "courtyard" &&
            !p.id.startsWith("plaza/courtyard/center/"),
        );
        for (const p of generalCourtyardPlazas) {
          generalCourtyards++;
          expect(p.id).toMatch(/^plaza\/courtyard\/block\//);
        }
        // id は一意(中心建築の "plaza/courtyard/center/<連番>" と
        // 接頭辞で分離した id 空間。network-plaza.md Plaza 節)
        expect(new Set(model.plazas.map((p) => p.id)).size).toBe(
          model.plazas.length,
        );
      }
    }
    // 空検証にならない(中庭型クラスタの courtyard Plaza が実在する)
    expect(generalCourtyards).toBeGreaterThan(0);
  });

  it("広場どうしが重ならない(円距離 ≥ 半径和)", async () => {
    for (const seed of SEEDS) {
      for (const over of [{}, { water: 95 }, { arcana: 95 }]) {
        const model = await build(seed, over);
        for (let i = 0; i < model.plazas.length; i++) {
          const a = model.plazas[i];
          // 中庭(courtyard)は中心建築の中庭壁の内側にあり、
          // 段9 の円距離規約の対象外(contracts「中心建築」)
          if (!a || a.kind === "courtyard") continue;
          for (let j = i + 1; j < model.plazas.length; j++) {
            const b = model.plazas[j];
            if (!b || b.kind === "courtyard") continue;
            const d = Math.hypot(
              a.position.x - b.position.x,
              a.position.z - b.position.z,
            );
            expect(
              d,
              `seed=${seed} ${a.id} と ${b.id} が重なる`,
            ).toBeGreaterThanOrEqual(a.radius + b.radius);
          }
        }
      }
    }
  });

  it("広場が水域(水路を含む)・centerPlan.footprint と重ならない", async () => {
    for (const seed of SEEDS) {
      for (const over of [{}, { water: 70 }, { water: 95, settlement: 95 }]) {
        const model = await build(seed, over);
        const wsdf = combinedWaterSdf(model);
        const foot = model.centerPlan.footprint;
        for (const plaza of model.plazas) {
          // 中庭(courtyard)は centerPlan.footprint の内側に置かれる設計
          // (contracts「中心建築」)のため footprint 検査の対象外
          if (plaza.kind === "courtyard") continue;
          for (const v of plaza.polygon) {
            expect(
              wsdf(v.x, v.z),
              `seed=${seed} ${plaza.id} の頂点が水中`,
            ).toBeGreaterThanOrEqual(0);
            expect(
              pointInPolygon(v.x, v.z, foot),
              `seed=${seed} ${plaza.id} の頂点が footprint 内`,
            ).toBe(false);
          }
        }
      }
    }
  });

  it("結界門前広場は wardLevel ≥ 2 の門に対応して現れる", async () => {
    for (const seed of SEEDS) {
      const none = await build(seed, { arcana: 0 });
      expect(none.plazas.some((p) => p.kind === "gate")).toBe(false);
      const high = await build(seed, { arcana: 95 });
      if (high.wards.gates.length > 0) {
        expect(high.plazas.some((p) => p.kind === "gate")).toBe(true);
      }
    }
  });
});

describe("plazas: centerPlan 後半(facing / heightHint)", () => {
  it("facing / heightHint が確定している(0 のままでない)", async () => {
    for (const seed of SEEDS) {
      for (const over of [{}, { water: 0 }, { monumentality: 0 }]) {
        const model = await build(seed, over);
        expect(Number.isFinite(model.centerPlan.facing)).toBe(true);
        expect(model.centerPlan.facing).not.toBe(0);
        expect(model.centerPlan.heightHint).toBeGreaterThan(0);
      }
    }
  });

  it("facing は中心前広場の方位と一致する", async () => {
    for (const seed of SEEDS) {
      const model = await build(seed);
      const centerPlaza = model.plazas.find((p) => p.kind === "center");
      expect(centerPlaza).toBeDefined();
      if (!centerPlaza) continue;
      const c = model.centerPlan.position;
      const expected = Math.atan2(
        centerPlaza.position.z - c.z,
        centerPlaza.position.x - c.x,
      );
      expect(model.centerPlan.facing).toBeCloseTo(expected, 9);
    }
  });

  it("heightHint は centerHeight × 支配軸係数(Monumentality に単調)", async () => {
    for (const seed of SEEDS) {
      const low = await build(seed, { monumentality: 20 });
      const high = await build(seed, { monumentality: 90 });
      expect(high.centerPlan.heightHint).toBeGreaterThan(
        low.centerPlan.heightHint,
      );
      // 係数の範囲(0.7〜1.15)に収まる
      for (const model of [low, high]) {
        const ratio =
          model.centerPlan.heightHint / model.meta.derived.centerHeight;
        expect(ratio).toBeGreaterThanOrEqual(0.7 - 1e-9);
        expect(ratio).toBeLessThanOrEqual(1.15 + 1e-9);
      }
    }
  });
});

/** 折れ線を弧長 3 単位で標本化し、広場ポリゴンの周長に接するか内部を通るか */
function touchesRoad(
  model: WorldModel,
  plaza: { polygon: WorldModel["plazas"][number]["polygon"] },
): boolean {
  const TOLERANCE = 0.5;
  for (const edge of model.network.edges) {
    for (const p of resamplePath(edge.path, 3)) {
      if (polygonSignedDistance(p.x, p.z, plaza.polygon) <= TOLERANCE) {
        return true;
      }
    }
  }
  return false;
}

/** 折れ線の角度差(0〜π) */
function angleDiff(a: number, b: number): number {
  let d = Math.abs(a - b) % (Math.PI * 2);
  if (d > Math.PI) d = Math.PI * 2 - d;
  return d;
}

describe("plazas: 全広場の道路接続保証(契約: network-plaza.md Plaza 節)", () => {
  it("courtyard を除く全ての広場に、周長に接するか内部を通る道路 edge が1本以上ある", async () => {
    for (const seed of SEEDS) {
      for (const monumentality of [0, 50, 100]) {
        const model = await build(seed, { monumentality });
        for (const plaza of model.plazas) {
          if (plaza.kind === "courtyard") continue;
          expect(
            touchesRoad(model, plaza),
            `seed=${seed} monumentality=${monumentality} ${plaza.id}(${plaza.kind}) に接する道路が無い`,
          ).toBe(true);
        }
      }
    }
  });

  // コーナーケース(lakeside-2 / water=95 / monumentality=100):
  // 橋詰め広場1件が採択位置のままでは道路周長に接しないことがある
  // (contracts/network-plaza.md「Plaza」節「全広場の道路接続保証」。
  // gate / bridgehead / crossing の採択直前に接触検証+アンカーへの寄せを
  // 行う plazas.ts resolveTouchingSite)。この組を固定で回帰させる。
  it("lakeside-2 / water=95 / monumentality=100(bridgehead 広場の接触コーナーケース)", async () => {
    const model = await build("lakeside-2", { water: 95, monumentality: 100 });
    const bridgeheads = model.plazas.filter((p) => p.kind === "bridgehead");
    expect(bridgeheads.length).toBeGreaterThan(0);
    for (const plaza of model.plazas) {
      if (plaza.kind === "courtyard") continue;
      expect(
        touchesRoad(model, plaza),
        `lakeside-2 water=95 monumentality=100 ${plaza.id}(${plaza.kind}) に接する道路が無い`,
      ).toBe(true);
    }
  });
});

describe("plazas: 中心前広場の接続路(契約: network-plaza.md Plaza 節「中心前広場の接続路」)", () => {
  it("中心前広場に street/plaza/<plazaId> の接続路が network へ追記される", async () => {
    for (const seed of SEEDS) {
      for (const monumentality of [0, 50, 100]) {
        const model = await build(seed, { monumentality });
        const centerPlaza = model.plazas.find((p) => p.kind === "center");
        expect(centerPlaza, `seed=${seed} monumentality=${monumentality}`).toBeDefined();
        if (!centerPlaza) continue;
        const expectedId = `street/plaza/${centerPlaza.id}`;
        const connector = model.network.edges.find((e) => e.id === expectedId);
        expect(
          connector,
          `seed=${seed} monumentality=${monumentality} ${expectedId} が見つからない`,
        ).toBeDefined();
        if (!connector) continue;
        expect(connector.class).toBe("street");
        // 両端ノードが存在し、path の端点と一致する
        const nodeById = new Map(model.network.nodes.map((n) => [n.id, n.position]));
        const head = connector.path[0];
        const tail = connector.path[connector.path.length - 1];
        expect(nodeById.get(connector.from)).toEqual(head);
        expect(nodeById.get(connector.to)).toEqual(tail);
      }
    }
  });

  it("接続路の流入方位(広場中心から見た接続点の方位)が centerPlan.facing と ±30° 以内で一致する", async () => {
    for (const seed of SEEDS) {
      for (const monumentality of [0, 50, 100]) {
        const model = await build(seed, { monumentality });
        const centerPlaza = model.plazas.find((p) => p.kind === "center");
        if (!centerPlaza) continue;
        const connector = model.network.edges.find(
          (e) => e.id === `street/plaza/${centerPlaza.id}`,
        );
        if (!connector) continue;
        const nodeById = new Map(model.network.nodes.map((n) => [n.id, n.position]));
        // 広場側の端点(node/street/plaza/<plazaId>)を特定する
        const plazaSideId = [connector.from, connector.to].find((id) =>
          id.startsWith("node/street/plaza/"),
        );
        expect(plazaSideId, `seed=${seed} monumentality=${monumentality}`).toBeDefined();
        if (!plazaSideId) continue;
        const entry = nodeById.get(plazaSideId);
        expect(entry).toBeDefined();
        if (!entry) continue;
        const incomingAngle = Math.atan2(
          entry.z - centerPlaza.position.z,
          entry.x - centerPlaza.position.x,
        );
        expect(
          angleDiff(incomingAngle, model.centerPlan.facing),
          `seed=${seed} monumentality=${monumentality}`,
        ).toBeLessThanOrEqual(CONNECTOR_FACING_TOLERANCE + 1e-9);
      }
    }
  });
});
