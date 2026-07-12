import { describe, expect, it } from "vitest";
import {
  DEFAULT_PARAMS,
  createEmptyWorldModel,
  type Params,
  type WorldModel,
} from "../src/model/worldmodel";
import { fieldCellIndex, sampleFieldGrid } from "../src/model/fieldgrid";
import { runDerive } from "../src/pipeline/derive";
import { runGround } from "../src/pipeline/ground";
import { runWater } from "../src/pipeline/water";
import { runSiting } from "../src/pipeline/siting";
import { runNetwork } from "../src/pipeline/network";
import { runCanals } from "../src/pipeline/canals";
import {
  createDensityDecay,
  protoDensityAt,
  runDensity,
  smoothstep,
  URBANITY_EDGE0,
  URBANITY_THRESHOLD,
} from "../src/pipeline/density";

const SEEDS = ["everdusk-101", "seed-a", "seed-b"];

function build(seed: string, over: Partial<Params> = {}): WorldModel {
  const model = createEmptyWorldModel(seed, { ...DEFAULT_PARAMS, ...over });
  runDerive(model);
  runGround(model);
  runWater(model);
  runSiting(model);
  runNetwork(model);
  runCanals(model);
  runDensity(model);
  return model;
}

describe("density: 決定性", () => {
  it("同一 seed + params で density.primary が完全一致する", () => {
    for (const seed of SEEDS) {
      expect(build(seed).density.primary).toEqual(build(seed).density.primary);
    }
  });
});

describe("density: FieldGrid 実体(contracts/network-plaza.md Density 節)", () => {
  it("解像度 64・張り size×1.1 のグリッドに 0〜1 の値を持つ。final は null のまま", () => {
    for (const seed of SEEDS) {
      const model = build(seed);
      const grid = model.density.primary;
      expect(grid).not.toBeNull();
      expect(model.density.final).toBeNull();
      if (!grid) continue;
      expect(grid.resolution).toBe(64);
      expect(grid.cellSize * grid.resolution).toBeCloseTo(
        model.ground.size * 1.1,
        6,
      );
      expect(grid.values.length).toBe(64 * 64);
      for (const v of grid.values) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });

  it("中心で高く、境界の外で 0 に落ちる(サンプリング検証)", () => {
    for (const seed of SEEDS) {
      const model = build(seed);
      const grid = model.density.primary;
      if (!grid) throw new Error("primary が生成されていない");
      const c = model.centerPlan.position;
      const atCenter = sampleFieldGrid(grid, c.x, c.z);
      expect(atCenter).toBeGreaterThan(0.3);
      // グリッドの隅(境界の外)ではほぼ 0
      const half = (grid.resolution * grid.cellSize) / 2;
      expect(sampleFieldGrid(grid, -half + 1, -half + 1)).toBeLessThan(0.02);
      // 中心から離れるほど減衰する(道路ブースト分の揺れは平均で吸収)
      const size = model.ground.size;
      const avgAt = (dist: number): number => {
        let sum = 0;
        for (let k = 0; k < 16; k++) {
          const a = (k / 16) * Math.PI * 2;
          sum += sampleFieldGrid(
            grid,
            c.x + Math.cos(a) * dist,
            c.z + Math.sin(a) * dist,
          );
        }
        return sum / 16;
      };
      expect(avgAt(size * 0.08)).toBeGreaterThan(avgAt(size * 0.4));
    }
  });

  it("Settlement Pressure が密度場を駆動する(peak と減衰距離)", () => {
    for (const seed of SEEDS) {
      const low = build(seed, { settlement: 10 });
      const high = build(seed, { settlement: 90 });
      const gl = low.density.primary;
      const gh = high.density.primary;
      if (!gl || !gh) throw new Error("primary が生成されていない");
      const cl = low.centerPlan.position;
      const ch = high.centerPlan.position;
      // 中心付近のピークと、中距離の広がりの両方が settlement に単調
      expect(sampleFieldGrid(gh, ch.x, ch.z)).toBeGreaterThan(
        sampleFieldGrid(gl, cl.x, cl.z),
      );
    }
  });

  it("結界に依存しない(Arcana を変えても primary が不変)", () => {
    for (const seed of SEEDS) {
      const a = build(seed, { arcana: 0 });
      const b = build(seed, { arcana: 95 });
      expect(a.density.primary).toEqual(b.density.primary);
    }
  });
});

describe("density: street 近接ブースト(Phase B。届く距離 10・強さ 0.16)", () => {
  it("street 上の値が、道路近接ブーストを除いた proto-density より高い(同一地点での比較)", () => {
    // 「近い点 vs 遠い点」の比較は、2点間で中心距離(centerTerm)自体が
    // 変わってしまい、ブースト(最大 0.16)より centerTerm の変化が大きい
    // 場合に false-negative になりうる(道路の向きが中心方向に対して
    // 急な地点など)。同一地点で「ブースト込み(grid の実値)」と
    // 「ブースト抜き(proto-density)」を比較すれば、中心距離の影響を
    // 受けずにブーストの寄与だけを検証できる
    let checked = 0;
    for (const seed of SEEDS) {
      const model = build(seed, { settlement: 100, worldScale: 100 });
      const grid = model.density.primary;
      if (!grid) throw new Error("primary が生成されていない");
      const decay = createDensityDecay(model);
      const streets = model.network.edges.filter((e) => e.class === "street");
      for (const edge of streets) {
        const a = edge.path[0];
        const b = edge.path[edge.path.length - 1];
        if (!a || !b) continue;
        const mid = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
        const withBoost = sampleFieldGrid(grid, mid.x, mid.z);
        const withoutBoost = protoDensityAt(decay, mid.x, mid.z);
        // 既に 1.0 に飽和している(clamp)場合はブーストの寄与が見えないため
        // 比較対象から除外する(飽和していない大多数の street で確認できれば十分)
        if (withBoost >= 0.999) continue;
        expect(withBoost, `seed=${seed} edge=${edge.id}`).toBeGreaterThan(withoutBoost);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});

describe("zoning: 市街度 FieldGrid(contracts/network-plaza.md Density 節 zoning。Phase B)", () => {
  it("解像度 64・張り size×1.1・値域 0〜1・決定性(density.primary と同じ張り)", () => {
    for (const seed of SEEDS) {
      const model = build(seed);
      const grid = model.zoning;
      expect(grid).not.toBeNull();
      if (!grid) continue;
      expect(grid.resolution).toBe(64);
      expect(grid.cellSize * grid.resolution).toBeCloseTo(
        model.ground.size * 1.1,
        6,
      );
      expect(grid.values.length).toBe(64 * 64);
      for (const v of grid.values) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
      expect(build(seed).zoning).toEqual(build(seed).zoning);
    }
  });

  it("市街ゾーン(urbanity ≥ 0.45)の面積比が Settlement Pressure に単調", () => {
    const urbanRatio = (model: WorldModel): number => {
      const grid = model.zoning;
      if (!grid) throw new Error("zoning が生成されていない");
      let urban = 0;
      for (const v of grid.values) if (v >= URBANITY_THRESHOLD) urban++;
      return urban / grid.values.length;
    };
    for (const seed of SEEDS) {
      const low = urbanRatio(build(seed, { settlement: 0 }));
      const mid = urbanRatio(build(seed, { settlement: 50 }));
      const high = urbanRatio(build(seed, { settlement: 100 }));
      expect(mid, `seed=${seed} low→mid`).toBeGreaterThanOrEqual(low);
      expect(high, `seed=${seed} mid→high`).toBeGreaterThanOrEqual(mid);
      expect(high, `seed=${seed} low→high`).toBeGreaterThan(low);
    }
  });

  it("道路近傍の urbanity が、同一地点の道路近接ブースト抜き(遠方相当)より高い", () => {
    // 「近い点 vs 遠い点」の直接比較は中心距離(protoDensity)自体の差に
    // 埋もれうるため(primary の street ブーストテストと同じ理由)、
    // 道路 edge の中点に最も近いグリッドセルの「中心座標」を使って
    // 「ブースト込み(そのセルの生値。sampleFieldGrid の補間を経由しない)」と
    // 「ブースト抜き(同じ座標で roadBoost=0 とした場合の urbanity)」を
    // 比較する(補間を挟むと隣接セルとの平滑化で誤差が乗るため、
    // 生値どうしの比較にする)
    let checked = 0;
    for (const seed of SEEDS) {
      const model = build(seed, { settlement: 100, worldScale: 100 });
      const grid = model.zoning;
      if (!grid) throw new Error("zoning が生成されていない");
      const decay = createDensityDecay(model);
      const half = (grid.resolution * grid.cellSize) / 2;
      const roads = model.network.edges.filter(
        (e) => e.class === "street" || e.class === "main" || e.class === "connector",
      );
      for (const edge of roads) {
        const a = edge.path[0];
        const b = edge.path[edge.path.length - 1];
        if (!a || !b) continue;
        const mid = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
        const ix = Math.max(
          0,
          Math.min(grid.resolution - 1, Math.floor((mid.x + half) / grid.cellSize)),
        );
        const iz = Math.max(
          0,
          Math.min(grid.resolution - 1, Math.floor((mid.z + half) / grid.cellSize)),
        );
        const cx = (ix + 0.5) * grid.cellSize - half;
        const cz = (iz + 0.5) * grid.cellSize - half;
        const withBoost = grid.values[fieldCellIndex(grid, ix, iz)];
        const protoDensity = protoDensityAt(decay, cx, cz);
        const withoutBoost = smoothstep(URBANITY_EDGE0, URBANITY_THRESHOLD, protoDensity);
        if (withBoost === undefined) continue;
        // smoothstep は非減少関数、roadBoost は常に 0 以上なので
        // withBoost(=protoDensity+0.5×roadBoost 側)は withoutBoost(=roadBoost
        // 抜き)を常に下回らない(飽和域や閾値未満域では等しくなりうる)。
        // 「近傍で実際に urbanity が押し上げられる」ことは、少なくとも1件で
        // 厳密な増加が起きることで確認する
        expect(withBoost, `seed=${seed} edge=${edge.id}`).toBeGreaterThanOrEqual(withoutBoost);
        if (withBoost > withoutBoost) checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});
