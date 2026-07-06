/**
 * 決定論的乱数基盤。
 * API とラベル体系の契約は docs/internal/contracts/pipeline.md を正とする。
 * Math.random() の使用は全面禁止(implementation-spec 1.4節)。
 */

/** FNV-1a 32bit 文字列ハッシュ */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export interface Rng {
  /** [0, 1) の一様乱数 */
  next(): number;
  /** [min, max) の一様乱数 */
  range(min: number, max: number): number;
  /** [min, max] の整数(両端含む) */
  int(min: number, max: number): number;
  /** 正規分布近似(Irwin–Hall 6標本) */
  normal(mean: number, stddev: number): number;
  /** 要素をひとつ選ぶ。空配列は不可 */
  pick<T>(items: readonly T[]): T;
  /** 重み付き選択。重みの合計は正であること */
  weighted<T>(items: readonly T[], weights: readonly number[]): T;
  /** 非破壊 Fisher–Yates シャッフル */
  shuffle<T>(items: readonly T[]): T[];
  /** 確率 p で true */
  chance(p: number): boolean;
}

/**
 * seed とラベルから独立した決定論的ストリームを派生させる。
 * 要素ごとの乱数は `makeRng(seed, "building/" + id)` のように
 * 安定IDから派生させ、生成順序の変更が他所へ波及しないようにする。
 */
export function makeRng(seed: string, label: string): Rng {
  let state = hashString(seed + "/" + label) >>> 0;

  // splitmix32
  const next = (): number => {
    state = (state + 0x9e3779b9) | 0;
    let z = state;
    z ^= z >>> 16;
    z = Math.imul(z, 0x21f0aaad);
    z ^= z >>> 15;
    z = Math.imul(z, 0x735a2d97);
    z ^= z >>> 15;
    return (z >>> 0) / 4294967296;
  };

  const int = (min: number, max: number): number =>
    Math.floor(next() * (max - min + 1)) + min;

  return {
    next,
    range: (min, max) => min + next() * (max - min),
    int,
    normal: (mean, stddev) => {
      // Irwin–Hall: 6標本の和は 平均3・分散0.5
      let sum = 0;
      for (let i = 0; i < 6; i++) sum += next();
      return mean + stddev * ((sum - 3) / Math.sqrt(0.5));
    },
    pick: (items) => {
      if (items.length === 0) throw new Error("pick: empty array");
      const item = items[int(0, items.length - 1)];
      return item as (typeof items)[number];
    },
    weighted: (items, weights) => {
      if (items.length === 0 || items.length !== weights.length) {
        throw new Error("weighted: items/weights mismatch");
      }
      let total = 0;
      for (const w of weights) total += w;
      if (!(total > 0)) throw new Error("weighted: total weight must be > 0");
      let r = next() * total;
      for (let i = 0; i < items.length; i++) {
        r -= weights[i] ?? 0;
        if (r < 0) return items[i] as (typeof items)[number];
      }
      return items[items.length - 1] as (typeof items)[number];
    },
    shuffle: (items) => {
      const out = items.slice();
      for (let i = out.length - 1; i > 0; i--) {
        const j = int(0, i);
        const a = out[i] as (typeof out)[number];
        out[i] = out[j] as (typeof out)[number];
        out[j] = a;
      }
      return out;
    },
    chance: (p) => next() < p,
  };
}
