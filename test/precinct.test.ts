import { describe, expect, it } from "vitest";
import { makeRng } from "../src/rng";
import {
  planPrecinct,
  USABLE_MIN,
  type CenterAxis,
  type PrecinctInput,
  type PrecinctPlan,
  type PrecinctRect,
} from "../src/pipeline/precinct";

const AXES: CenterAxis[] = ["arcane", "authority", "waterside", "rustic"];

function makeInput(
  axis: CenterAxis,
  overrides: Partial<PrecinctInput> = {},
): PrecinctInput {
  return {
    axis,
    monument: 0.5,
    usable: 27,
    openSide: axis === "waterside" ? "back" : null,
    rng: makeRng("everdusk-101", "building/center"),
    ...overrides,
  };
}

function rectsOverlap(a: PrecinctRect, b: PrecinctRect): boolean {
  return a.u0 < b.u1 && b.u0 < a.u1 && a.v0 < b.v1 && b.v0 < a.v1;
}

function rectInBounds(r: PrecinctRect, H: number, eps = 0.5): boolean {
  return (
    r.u0 >= -H - eps && r.u1 <= H + eps && r.v0 >= -H - eps && r.v1 <= H + eps
  );
}

describe("precinct: 決定性(同一入力 → 同一出力)", () => {
  for (const axis of AXES) {
    it(`${axis}: 同一 seed で 2 回計画して完全一致する`, () => {
      const a = planPrecinct(makeInput(axis));
      const b = planPrecinct(makeInput(axis));
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    });
  }

  it("seed を変えると計画が変わる(骨格ストリーム由来の揺らぎ)", () => {
    const a = planPrecinct(makeInput("authority"));
    const b = planPrecinct(
      makeInput("authority", { rng: makeRng("seed-b", "building/center") }),
    );
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });
});

describe("precinct: 帯分割と内包(契約「敷地計画」)", () => {
  for (const axis of AXES) {
    it(`${axis}: 帯の合計 = usable、全要素が使用領域内`, () => {
      const plan = planPrecinct(makeInput(axis));
      const { forecourt, court, hall } = plan.bands;
      expect(forecourt + court + hall).toBeCloseTo(plan.usable, 9);
      const H = plan.usable / 2;
      for (const m of plan.masses) {
        expect(rectInBounds(m.rect, H)).toBe(true);
      }
      for (const c of plan.courts) {
        expect(rectInBounds(c.rect, H)).toBe(true);
      }
      for (const s of plan.enclosure.segments) {
        for (const p of [s.a, s.b]) {
          expect(Math.abs(p.u)).toBeLessThanOrEqual(H + 1e-9);
          expect(Math.abs(p.v)).toBeLessThanOrEqual(H + 1e-9);
        }
      }
    });
  }
});

describe("precinct: 量塊と中庭の関係(契約「敷地計画」)", () => {
  for (const axis of AXES) {
    const plan = planPrecinct(makeInput(axis));

    it(`${axis}: main-hall と accent-tower が常に 1 つずつある`, () => {
      expect(plan.masses.filter((m) => m.role === "main-hall").length).toBe(1);
      expect(plan.masses.filter((m) => m.role === "accent-tower").length).toBe(
        1,
      );
    });

    it(`${axis}: 中庭(計画)が 1 つ以上ある`, () => {
      expect(plan.courts.length).toBeGreaterThanOrEqual(1);
    });

    it(`${axis}: 中庭と建物量塊(gatehouse を除く)が重ならない`, () => {
      // gatehouse は前面の囲い上(前庭の外縁)に載るため対象外
      const solid = plan.masses.filter((m) => m.role !== "gatehouse");
      for (const c of plan.courts) {
        for (const m of solid) {
          expect(rectsOverlap(c.rect, m.rect)).toBe(false);
        }
      }
    });

    it(`${axis}: annex は囲いに接するか connector で接続される(孤立なし)`, () => {
      const H = plan.usable / 2;
      for (const m of plan.masses) {
        if (m.role !== "annex") continue;
        const touches =
          m.rect.u0 <= -H + 0.011 || m.rect.u1 >= H - 0.011;
        const connected = plan.connectors.some(
          (c) =>
            c.a.u >= m.rect.u0 - 0.011 &&
            c.a.u <= m.rect.u1 + 0.011 &&
            Math.abs(c.a.v - m.rect.v1) < 0.011,
        );
        expect(touches || connected).toBe(true);
      }
    });
  }
});

describe("precinct: アプローチと門(契約「敷地計画」)", () => {
  for (const axis of AXES) {
    it(`${axis}: 主門が 1 つ、facing 軸線(u = 0)上にある`, () => {
      const plan = planPrecinct(makeInput(axis));
      const mains = plan.gates.filter((g) => g.main);
      expect(mains.length).toBe(1);
      expect(mains[0]!.u).toBe(0);
      expect(mains[0]!.v).toBeCloseTo(-plan.usable / 2, 6);
      // 主館の正面(v0 側)は主門より奥にある(門 → 前庭 → 主館の順)
      const hall = plan.masses.find((m) => m.role === "main-hall")!;
      expect(hall.rect.v0).toBeGreaterThan(mains[0]!.v);
    });

    it(`${axis}: 囲いのセグメントは門の開口を跨がない`, () => {
      const plan = planPrecinct(makeInput(axis));
      for (const g of plan.gates) {
        for (const s of plan.enclosure.segments) {
          const horizontal = s.a.v === s.b.v;
          if (horizontal && Math.abs(s.a.v - g.v) < 1e-9) {
            const lo = Math.min(s.a.u, s.b.u);
            const hi = Math.max(s.a.u, s.b.u);
            const overlap =
              Math.min(hi, g.u + g.width / 2) - Math.max(lo, g.u - g.width / 2);
            expect(overlap).toBeLessThanOrEqual(1e-9);
          }
          if (!horizontal && Math.abs(s.a.u - g.u) < 1e-9) {
            const lo = Math.min(s.a.v, s.b.v);
            const hi = Math.max(s.a.v, s.b.v);
            const overlap =
              Math.min(hi, g.v + g.width / 2) - Math.max(lo, g.v - g.width / 2);
            expect(overlap).toBeLessThanOrEqual(1e-9);
          }
        }
      }
    });
  }
});

describe("precinct: 軸別の型(契約 4軸表)", () => {
  it("authority: 石壁+隅塔 2〜4+門楼+前庭と主庭の 2 段構え", () => {
    const plan = planPrecinct(makeInput("authority"));
    expect(plan.enclosure.kind).toBe("wall");
    expect(plan.turrets.length).toBeGreaterThanOrEqual(2);
    expect(plan.turrets.length).toBeLessThanOrEqual(4);
    expect(plan.masses.some((m) => m.role === "gatehouse")).toBe(true);
    expect(plan.courts.map((c) => c.kind)).toEqual([
      "forecourt",
      "main-court",
    ]);
  });

  it("arcane: 低めの石壁+回廊中庭(cloister)", () => {
    const plan = planPrecinct(makeInput("arcane"));
    expect(plan.enclosure.kind).toBe("low-wall");
    expect(plan.courts.some((c) => c.kind === "cloister")).toBe(true);
    expect(plan.turrets.length).toBe(0);
  });

  it("waterside: 開放辺(back)には囲いセグメントも門もない", () => {
    const plan = planPrecinct(makeInput("waterside", { openSide: "back" }));
    expect(plan.enclosure.openSide).toBe("back");
    const H = plan.usable / 2;
    for (const s of plan.enclosure.segments) {
      // 背面(v = +H)の水平セグメントが無い
      const horizontal = s.a.v === s.b.v;
      if (horizontal) expect(s.a.v).toBeLessThan(H - 1e-9);
    }
    // 塔は水際(背面)の隅
    expect(plan.accentTower.v).toBeGreaterThan(0);
  });

  it("rustic: 柵囲い+作業庭 1 つ+非対称の物見塔", () => {
    const plan = planPrecinct(makeInput("rustic"));
    expect(plan.enclosure.kind).toBe("fence");
    expect(plan.courts.length).toBe(1);
    expect(plan.courts[0]!.kind).toBe("work-yard");
    expect(plan.turrets.length).toBe(0);
    // 物見塔は中心軸から外れる(非対称)
    expect(Math.abs(plan.accentTower.u)).toBeGreaterThan(1);
  });
});

describe("precinct: 縮退規則(契約「縮退規則」)", () => {
  it("usable はクランプされ、下限でも main-hall / accent-tower / 中庭 1 が立つ", () => {
    const plan = planPrecinct(
      makeInput("authority", { usable: 8 /* < USABLE_MIN */ }),
    );
    expect(plan.usable).toBe(USABLE_MIN);
    expect(plan.masses.some((m) => m.role === "main-hall")).toBe(true);
    expect(plan.masses.some((m) => m.role === "accent-tower")).toBe(true);
    expect(plan.courts.length).toBeGreaterThanOrEqual(1);
  });

  it("小敷地では annex → gatehouse の順に落ちる", () => {
    const at = (usable: number): PrecinctPlan =>
      planPrecinct(makeInput("authority", { usable }));
    const small = at(12);
    expect(small.masses.filter((m) => m.role === "annex").length).toBe(0);
    expect(small.masses.some((m) => m.role === "gatehouse")).toBe(false);
    const mid = at(17);
    expect(mid.masses.filter((m) => m.role === "annex").length).toBe(0);
    expect(mid.masses.some((m) => m.role === "gatehouse")).toBe(true);
    const large = at(27);
    expect(large.masses.filter((m) => m.role === "annex").length)
      .toBeGreaterThanOrEqual(1);
  });

  it("Monumentality が高いほど量塊数が単調に増える(縮退なしの敷地)", () => {
    const count = (mon: number): number =>
      planPrecinct(makeInput("authority", { monument: mon, usable: 30 }))
        .masses.length;
    expect(count(0.9)).toBeGreaterThanOrEqual(count(0.5));
    expect(count(0.5)).toBeGreaterThanOrEqual(count(0.1));
  });
});
