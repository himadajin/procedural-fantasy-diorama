import { describe, expect, it } from "vitest";
import {
  DEFAULT_PARAMS,
  createEmptyWorldModel,
  type Params,
  type Vec2,
  type WorldModel,
} from "../src/model/worldmodel";
import { ZONE_KINDS, sampleZoneMask } from "../src/model/zonemask";
import { runDerive } from "../src/pipeline/derive";
import { runGround } from "../src/pipeline/ground";

const SEEDS = ["seed-a", "seed-b", "everdusk-101"];

function build(seed: string, over: Partial<Params> = {}): WorldModel {
  const model = createEmptyWorldModel(seed, { ...DEFAULT_PARAMS, ...over });
  runDerive(model);
  runGround(model);
  return model;
}

/** shoelace 符号(x, z)。時計回りの契約は負(contracts/worldmodel-core.md) */
function shoelace(polygon: Vec2[]): number {
  let sum = 0;
  for (let i = 0; i < polygon.length; i++) {
    const p = polygon[i];
    const q = polygon[(i + 1) % polygon.length];
    if (!p || !q) continue;
    sum += p.x * q.z - q.x * p.z;
  }
  return sum;
}

/** 線分 ab と cd の真の交差(端点共有を除く) */
function segmentsIntersect(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const orient = (p: Vec2, q: Vec2, r: Vec2): number =>
    (q.x - p.x) * (r.z - p.z) - (q.z - p.z) * (r.x - p.x);
  const d1 = orient(c, d, a);
  const d2 = orient(c, d, b);
  const d3 = orient(a, b, c);
  const d4 = orient(a, b, d);
  return (
    ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
    ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
  );
}

describe("ground: 決定性", () => {
  it("同一 seed + params で境界ポリゴンと zoneMask が完全一致する", () => {
    for (const seed of SEEDS) {
      const a = build(seed, { water: 70, worldScale: 30 });
      const b = build(seed, { water: 70, worldScale: 30 });
      expect(a.ground).toEqual(b.ground);
    }
  });

  it("seed が異なれば境界ポリゴンが変わる", () => {
    expect(build("seed-a").ground.boundary).not.toEqual(
      build("seed-b").ground.boundary,
    );
  });
});

describe("ground: 境界ポリゴン", () => {
  it("閉多角形(環)で、全頂点がワールド正方内・半径 0.3〜0.5×size に収まる", () => {
    for (const seed of SEEDS) {
      for (const worldScale of [0, 50, 100]) {
        const model = build(seed, { worldScale });
        const size = model.ground.size;
        const boundary = model.ground.boundary;
        expect(boundary.length).toBeGreaterThanOrEqual(8);
        // 環表現: 先頭点を末尾に重複させない
        expect(boundary[0]).not.toEqual(boundary[boundary.length - 1]);
        for (const p of boundary) {
          const r = Math.hypot(p.x, p.z);
          expect(r).toBeGreaterThanOrEqual(0.3 * size);
          expect(r).toBeLessThanOrEqual(0.5 * size);
        }
      }
    }
  });

  it("時計回り(shoelace 符号が負)", () => {
    for (const seed of SEEDS) {
      expect(shoelace(build(seed).ground.boundary)).toBeLessThan(0);
    }
  });

  it("自己交差しない", () => {
    for (const seed of SEEDS) {
      const boundary = build(seed).ground.boundary;
      const n = boundary.length;
      for (let i = 0; i < n; i++) {
        for (let j = i + 2; j < n; j++) {
          if (i === 0 && j === n - 1) continue; // 隣接(環の閉じ辺)
          const a = boundary[i];
          const b = boundary[(i + 1) % n];
          const c = boundary[j];
          const d = boundary[(j + 1) % n];
          if (!a || !b || !c || !d) continue;
          expect(
            segmentsIntersect(a, b, c, d),
            `seed=${seed} segments ${i}-${j}`,
          ).toBe(false);
        }
      }
    }
  });

  it("World Scale がワールド実寸と境界の広がりを駆動する", () => {
    const small = build("seed-a", { worldScale: 0 });
    const large = build("seed-a", { worldScale: 100 });
    expect(small.ground.size).toBe(240);
    expect(large.ground.size).toBe(560);
    expect(small.ground.size).toBe(small.meta.derived.worldSize);
    const maxRadius = (m: WorldModel): number =>
      Math.max(...m.ground.boundary.map((p) => Math.hypot(p.x, p.z)));
    expect(maxRadius(large)).toBeGreaterThan(maxRadius(small) * 1.5);
    expect(small.summary.scale.worldSize).toBe(small.ground.size);
  });
});

describe("ground: zoneMask 下地", () => {
  it("各セルの重みは非負・合計1で、砂洲・湿地・舗装はこの段では 0(後段の担当)", () => {
    for (const seed of SEEDS) {
      const mask = build(seed).ground.zoneMask;
      const cells = mask.resolution * mask.resolution;
      expect(mask.weights.length).toBe(cells * ZONE_KINDS.length);
      expect(mask.brightness.length).toBe(cells);
      for (let c = 0; c < cells; c++) {
        let sum = 0;
        for (let k = 0; k < ZONE_KINDS.length; k++) {
          const w = mask.weights[c * ZONE_KINDS.length + k] ?? -1;
          expect(w).toBeGreaterThanOrEqual(0);
          sum += w;
        }
        expect(sum).toBeCloseTo(1, 6);
        expect(mask.weights[c * ZONE_KINDS.length + 2]).toBe(0); // sandbar
        expect(mask.weights[c * ZONE_KINDS.length + 3]).toBe(0); // marsh
        expect(mask.weights[c * ZONE_KINDS.length + 4]).toBe(0); // paved(段10の担当)
      }
    }
  });

  it("草地ベースに土の斑・むらがあり、一様な板になっていない", () => {
    for (const seed of SEEDS) {
      const mask = build(seed).ground.zoneMask;
      const cells = mask.resolution * mask.resolution;
      const dirtIndex = ZONE_KINDS.indexOf("dirt");
      let minDirt = Infinity;
      let maxDirt = -Infinity;
      let dirtTotal = 0;
      let minBright = Infinity;
      let maxBright = -Infinity;
      for (let c = 0; c < cells; c++) {
        const dirt = mask.weights[c * ZONE_KINDS.length + dirtIndex] ?? 0;
        minDirt = Math.min(minDirt, dirt);
        maxDirt = Math.max(maxDirt, dirt);
        dirtTotal += dirt;
        const b = mask.brightness[c] ?? 1;
        minBright = Math.min(minBright, b);
        maxBright = Math.max(maxBright, b);
      }
      // 土の斑: 濃い斑と草地優勢の領域が両方ある
      expect(maxDirt).toBeGreaterThan(0.5);
      expect(minDirt).toBeLessThan(0.1);
      // 草地が主体(土が全面を覆わない)
      expect(dirtTotal / cells).toBeLessThan(0.6);
      // 明度ムラ: ±8% の範囲内で実際に振れている
      expect(minBright).toBeGreaterThanOrEqual(0.92 - 1e-9);
      expect(maxBright).toBeLessThanOrEqual(1.08 + 1e-9);
      expect(maxBright - minBright).toBeGreaterThan(0.05);
    }
  });

  it("sampleZoneMask はグリッド範囲外でも端へクランプして有限値を返す", () => {
    const model = build("seed-a");
    const size = model.ground.size;
    for (const [x, z] of [
      [0, 0],
      [size, size],
      [-size, size / 3],
      [size / 4, -size],
    ] as const) {
      const s = sampleZoneMask(model.ground.zoneMask, x, z);
      const sum = s.weights.reduce((acc, w) => acc + w, 0);
      expect(s.weights.length).toBe(ZONE_KINDS.length);
      expect(sum).toBeCloseTo(1, 6);
      expect(Number.isFinite(s.brightness)).toBe(true);
    }
  });
});
