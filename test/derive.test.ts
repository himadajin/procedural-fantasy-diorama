import { describe, expect, it } from "vitest";
import {
  DEFAULT_PARAMS,
  type Derived,
  type Params,
} from "../src/model/worldmodel";
import { computeDerived } from "../src/pipeline/derive";

const SEEDS = ["seed-a", "seed-b", "everdusk-101"];

function withParams(over: Partial<Params>): Params {
  return { ...DEFAULT_PARAMS, ...over };
}

describe("computeDerived: 決定性", () => {
  it("同一入力で深い等価の Derived を返す", () => {
    for (const seed of SEEDS) {
      const params = withParams({ water: 70, arcana: 80 });
      expect(computeDerived(seed, params)).toEqual(computeDerived(seed, params));
    }
  });

  it("入力の params を変更しない", () => {
    const params = withParams({});
    computeDerived("seed-a", params);
    expect(params).toEqual(DEFAULT_PARAMS);
  });
});

describe("computeDerived: 6パラメータの駆動先(implementation-spec 1.6節)", () => {
  // 各パラメータについて、値を振ったとき変化すべき派生フィールド(最低3系統)
  const expectations: [keyof Params, (keyof Derived)[]][] = [
    [
      "worldScale",
      ["worldSize", "entryPointCount", "roadBudget", "marginWidth", "parcelCountMax"],
    ],
    [
      "settlement",
      [
        "densityPeak",
        "densityFalloff",
        "parcelRate",
        "parcelSize",
        "laneAmount",
        "floorsBias",
        "canalScore",
      ],
    ],
    [
      "prosperity",
      ["wallTier", "roofTier", "roadGrade", "detailAmount", "tidiness"],
    ],
    [
      "water",
      [
        "pondCount",
        "pondArea",
        "lakeChance",
        "lakeArea",
        "canalScore",
        "canalWidth",
        "marshAmount",
        "sandbarAmount",
        "watersideRate",
        "shoreVegetation",
      ],
    ],
    [
      "arcana",
      [
        "wardLevel",
        "wallClosure",
        "towerScale",
        "gateScale",
        "lampDensity",
        "floaterAmount",
        "shrineRate",
        "glowIntensity",
        "centerArcaneBias",
      ],
    ],
    [
      "monumentality",
      [
        "centerFootprint",
        "centerHeight",
        "centerPlazaRadius",
        "upgradeRadius",
        "parcelReserve",
        "skylineRatio",
      ],
    ],
  ];

  for (const [param, fields] of expectations) {
    it(`${param} を 10→90 に振ると ${fields.length} 系統(≥3)の派生値が変わる`, () => {
      expect(fields.length).toBeGreaterThanOrEqual(3);
      for (const seed of SEEDS) {
        const low = computeDerived(seed, withParams({ [param]: 10 }));
        const high = computeDerived(seed, withParams({ [param]: 90 }));
        for (const field of fields) {
          expect(low[field], `${param} → ${field} (seed=${seed})`).not.toBe(
            high[field],
          );
        }
      }
    });
  }
});

describe("computeDerived: 境界値", () => {
  it("worldSize は 240〜560 に収まり、極値で両端に一致する", () => {
    for (const seed of SEEDS) {
      for (let scale = 0; scale <= 100; scale += 10) {
        const d = computeDerived(seed, withParams({ worldScale: scale }));
        expect(d.worldSize).toBeGreaterThanOrEqual(240);
        expect(d.worldSize).toBeLessThanOrEqual(560);
      }
      expect(computeDerived(seed, withParams({ worldScale: 0 })).worldSize).toBe(240);
      expect(computeDerived(seed, withParams({ worldScale: 100 })).worldSize).toBe(560);
    }
  });

  it("entryPointCount は 2〜4 の整数", () => {
    for (const seed of SEEDS) {
      for (let scale = 0; scale <= 100; scale += 5) {
        const d = computeDerived(seed, withParams({ worldScale: scale }));
        expect(Number.isInteger(d.entryPointCount)).toBe(true);
        expect(d.entryPointCount).toBeGreaterThanOrEqual(2);
        expect(d.entryPointCount).toBeLessThanOrEqual(4);
      }
    }
  });

  it("pondCount は 0〜4 の整数で、Water 0 では必ず 0", () => {
    for (const seed of SEEDS) {
      for (let water = 0; water <= 100; water += 5) {
        const d = computeDerived(seed, withParams({ water }));
        expect(Number.isInteger(d.pondCount)).toBe(true);
        expect(d.pondCount).toBeGreaterThanOrEqual(0);
        expect(d.pondCount).toBeLessThanOrEqual(4);
      }
      const dry = computeDerived(seed, withParams({ water: 0 }));
      expect(dry.pondCount).toBe(0);
      expect(dry.lakeChance).toBe(0);
    }
  });

  it("pondArea = lakeArea × 0.18 の式に一致する", () => {
    for (const seed of SEEDS) {
      for (const water of [0, 25, 50, 75, 100]) {
        const d = computeDerived(seed, withParams({ water }));
        expect(d.pondArea).toBeCloseTo(d.lakeArea * 0.18, 10);
      }
    }
  });

  it("canalWidth は 2.2〜5 にクランプされ、水量に対して単調に増える", () => {
    for (const seed of SEEDS) {
      let prev = -Infinity;
      for (const water of [0, 10, 25, 50, 75, 90, 100]) {
        const d = computeDerived(seed, withParams({ water }));
        expect(d.canalWidth).toBeGreaterThanOrEqual(2.2);
        expect(d.canalWidth).toBeLessThanOrEqual(5);
        expect(d.canalWidth).toBeGreaterThanOrEqual(prev);
        prev = d.canalWidth;
      }
      // 全パラメータ 50(water=50)は旧仕様(河川の最終幅×0.35)と等価になる基準値
      const mid = computeDerived(seed, withParams({ water: 50 }));
      expect(mid.canalWidth).toBeCloseTo(1.75 + 3.85 * 0.5, 10);
    }
  });

  it("wardLevel は閾値 15/45/75 で遷移する", () => {
    const cases: [number, Derived["wardLevel"]][] = [
      [0, 0],
      [14, 0],
      [15, 1],
      [44, 1],
      [45, 2],
      [74, 2],
      [75, 3],
      [100, 3],
    ];
    for (const seed of SEEDS) {
      for (const [arcana, level] of cases) {
        expect(
          computeDerived(seed, withParams({ arcana })).wardLevel,
          `arcana=${arcana}`,
        ).toBe(level);
      }
    }
  });

  it("wallClosure は 0〜1 で Arcana に対して連続に増える", () => {
    const d0 = computeDerived("seed-a", withParams({ arcana: 0 }));
    const d15 = computeDerived("seed-a", withParams({ arcana: 15 }));
    const d60 = computeDerived("seed-a", withParams({ arcana: 60 }));
    const d100 = computeDerived("seed-a", withParams({ arcana: 100 }));
    expect(d0.wallClosure).toBe(0);
    expect(d15.wallClosure).toBe(0);
    expect(d60.wallClosure).toBeGreaterThan(0);
    expect(d60.wallClosure).toBeLessThan(1);
    expect(d100.wallClosure).toBe(1);
  });

  it("canalScore = Water×(0.5+0.5×Settlement) の式に一致する", () => {
    const cases: [number, number][] = [
      [0, 50],
      [50, 50],
      [70, 30],
      [100, 100],
      [95, 0],
    ];
    for (const seed of SEEDS) {
      for (const [water, settlement] of cases) {
        const d = computeDerived(seed, withParams({ water, settlement }));
        expect(d.canalScore).toBeCloseTo(
          (water / 100) * (0.5 + 0.5 * (settlement / 100)),
          10,
        );
      }
    }
  });

  it("固定の上限値: waterAreaCap=0.35、glowAreaCap=0.005", () => {
    for (const seed of SEEDS) {
      for (const params of [
        withParams({}),
        withParams({ water: 100, arcana: 100 }),
        withParams({ water: 0, arcana: 0 }),
      ]) {
        const d = computeDerived(seed, params);
        expect(d.waterAreaCap).toBe(0.35);
        expect(d.glowAreaCap).toBe(0.005);
      }
    }
  });
});
