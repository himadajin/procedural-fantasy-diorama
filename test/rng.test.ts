import { describe, expect, it } from "vitest";
import { hashString, makeRng } from "../src/rng";

describe("hashString", () => {
  it("同一入力で同一ハッシュを返す", () => {
    expect(hashString("hello")).toBe(hashString("hello"));
  });

  it("既知の FNV-1a 値と一致する", () => {
    // FNV-1a 32bit の標準テストベクター
    expect(hashString("")).toBe(0x811c9dc5);
    expect(hashString("a")).toBe(0xe40c292c);
    expect(hashString("foobar")).toBe(0xbf9cf968);
  });
});

describe("makeRng", () => {
  it("同一 seed+label で同一系列を返す", () => {
    const a = makeRng("seed-1", "water");
    const b = makeRng("seed-1", "water");
    for (let i = 0; i < 100; i++) {
      expect(a.next()).toBe(b.next());
    }
  });

  it("label が異なれば独立した系列になる", () => {
    const a = makeRng("seed-1", "water");
    const b = makeRng("seed-1", "network");
    const seqA = Array.from({ length: 20 }, () => a.next());
    const seqB = Array.from({ length: 20 }, () => b.next());
    expect(seqA).not.toEqual(seqB);
  });

  it("seed が異なれば独立した系列になる", () => {
    const a = makeRng("seed-1", "water");
    const b = makeRng("seed-2", "water");
    expect(Array.from({ length: 20 }, () => a.next())).not.toEqual(
      Array.from({ length: 20 }, () => b.next()),
    );
  });

  it("next は [0, 1) を返す", () => {
    const rng = makeRng("bounds", "test");
    for (let i = 0; i < 10000; i++) {
      const v = rng.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("int は両端を含む整数を返す", () => {
    const rng = makeRng("int", "test");
    const seen = new Set<number>();
    for (let i = 0; i < 1000; i++) {
      const v = rng.int(2, 5);
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(2);
      expect(v).toBeLessThanOrEqual(5);
      seen.add(v);
    }
    expect(seen).toEqual(new Set([2, 3, 4, 5]));
  });

  it("range は [min, max) を返す", () => {
    const rng = makeRng("range", "test");
    for (let i = 0; i < 1000; i++) {
      const v = rng.range(-3, 7);
      expect(v).toBeGreaterThanOrEqual(-3);
      expect(v).toBeLessThan(7);
    }
  });

  it("normal は指定した平均・分散に近づく", () => {
    const rng = makeRng("normal", "test");
    const n = 20000;
    let sum = 0;
    let sumSq = 0;
    for (let i = 0; i < n; i++) {
      const v = rng.normal(10, 2);
      sum += v;
      sumSq += v * v;
    }
    const mean = sum / n;
    const variance = sumSq / n - mean * mean;
    expect(mean).toBeCloseTo(10, 1);
    expect(Math.sqrt(variance)).toBeCloseTo(2, 1);
  });

  it("pick / weighted / shuffle / chance が決定論的", () => {
    const run = () => {
      const rng = makeRng("det", "test");
      return {
        picks: Array.from({ length: 10 }, () => rng.pick(["a", "b", "c"])),
        weighted: Array.from({ length: 10 }, () =>
          rng.weighted(["x", "y", "z"], [1, 5, 2]),
        ),
        shuffled: rng.shuffle([1, 2, 3, 4, 5, 6, 7, 8]),
        chances: Array.from({ length: 10 }, () => rng.chance(0.3)),
      };
    };
    expect(run()).toEqual(run());
  });

  it("shuffle は非破壊で、全要素を保存する", () => {
    const rng = makeRng("shuffle", "test");
    const src = [1, 2, 3, 4, 5];
    const out = rng.shuffle(src);
    expect(src).toEqual([1, 2, 3, 4, 5]);
    expect(out.slice().sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });

  it("weighted は重みに比例して選ぶ(重み0は選ばれない)", () => {
    const rng = makeRng("weighted", "test");
    const counts = { a: 0, b: 0, c: 0 };
    for (let i = 0; i < 10000; i++) {
      counts[rng.weighted(["a", "b", "c"] as const, [1, 9, 0])]++;
    }
    expect(counts.c).toBe(0);
    expect(counts.b / counts.a).toBeGreaterThan(6);
    expect(counts.b / counts.a).toBeLessThan(13);
  });
});
