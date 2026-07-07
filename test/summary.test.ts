import { describe, expect, it } from "vitest";
import {
  DEFAULT_PARAMS,
  createEmptyWorldModel,
  type Params,
  type WorldModel,
} from "../src/model/worldmodel";
import { runPipeline } from "../src/pipeline/run";
import { buildCenterDescription, runSummary } from "../src/pipeline/summary";
import { pathLength } from "../src/model/geometry";

function withParams(over: Partial<Params>): Params {
  return { ...DEFAULT_PARAMS, ...over };
}

/** buildCenterDescription を単体検証するための最小モデル */
function modelWithAxes(
  axes: WorldModel["centerPlan"]["axes"],
  over: Partial<{
    canals: number;
    towers: number;
    wardLevel: 0 | 1 | 2 | 3;
    ringPath: number;
    gates: number;
    bridges: number;
    floaters: number;
  }> = {},
): WorldModel {
  const m = createEmptyWorldModel("test", DEFAULT_PARAMS);
  m.centerPlan.axes = axes;
  for (let i = 0; i < (over.canals ?? 0); i++) {
    m.water.canals.push({ id: `canal/${i}`, points: [], width: 3, towpathSide: 1 });
  }
  for (let i = 0; i < (over.towers ?? 0); i++) {
    m.wards.towers.push({
      id: `t${i}`,
      position: { x: 0, z: 0 },
      height: 10,
      onRing: true,
    });
  }
  m.wards.wardLevel = over.wardLevel ?? 0;
  for (let i = 0; i < (over.ringPath ?? 0); i++) {
    m.wards.ringPath.push({ x: i, z: 0 });
  }
  for (let i = 0; i < (over.gates ?? 0); i++) {
    m.wards.gates.push({
      id: `g${i}`,
      position: { x: 0, z: 0 },
      angle: 0,
      roadEdgeId: "e",
    });
  }
  for (let i = 0; i < (over.bridges ?? 0); i++) {
    m.water.bridges.push({
      id: `b${i}`,
      position: { x: 0, z: 0 },
      angle: 0,
      width: 3,
      length: 5,
      over: "river",
      roadClass: "main",
    });
  }
  for (let i = 0; i < (over.floaters ?? 0); i++) {
    m.wards.floaters.push({
      id: `f${i}`,
      anchorId: "t0",
      basePosition: { x: 0, y: 1, z: 0 },
      size: 1,
    });
  }
  return m;
}

describe("段15 サマリー: WorldModel 実態との一致(contracts/worldmodel.md Summary 節)", () => {
  // 特徴の出やすい水準を混ぜた代表組
  const CASES: [string, Params][] = [
    ["default", DEFAULT_PARAMS],
    ["water95-arcana90", withParams({ water: 95, arcana: 90, monumentality: 80 })],
    ["dry-rustic", withParams({ water: 0, arcana: 0, settlement: 20 })],
    ["seed-b water70", withParams({ water: 70 })],
  ];

  for (const [name, params] of CASES) {
    it(`${name}: buildingCounts が buildings の役割別実数と一致し合計= buildings.length`, async () => {
      const m = await runPipeline("everdusk-101", params);
      const expected: Record<string, number> = {};
      for (const b of m.buildings) expected[b.role] = (expected[b.role] ?? 0) + 1;
      expect(m.summary.buildingCounts).toEqual(expected);
      const total = Object.values(m.summary.buildingCounts).reduce(
        (a, b) => a + b,
        0,
      );
      expect(total).toBe(m.buildings.length);
      // 0 件の役割はキーを持たない
      for (const v of Object.values(m.summary.buildingCounts)) {
        expect(v).toBeGreaterThan(0);
      }
    });

    it(`${name}: waterOverview が rivers/lakes/canals/bridges の実数と一致`, async () => {
      const m = await runPipeline("everdusk-101", params);
      expect(m.summary.waterOverview).toEqual({
        rivers: m.water.rivers.length,
        lakes: m.water.lakes.length,
        canals: m.water.canals.length,
        bridges: m.water.bridges.length,
      });
    });

    it(`${name}: wardOverview が wards の実態と一致`, async () => {
      const m = await runPipeline("everdusk-101", params);
      const w = m.summary.wardOverview;
      expect(w.level).toBe(m.wards.wardLevel);
      expect(w.towers).toBe(m.wards.towers.length);
      expect(w.gates).toBe(m.wards.gates.length);
      expect(w.shrines).toBe(m.wards.shrines.length);
      expect(w.floaters).toBe(m.wards.floaters.length);
      // wardLevel 0 のとき ringLength は 0、それ以外は正
      if (m.wards.wardLevel >= 1 && m.wards.ringPath.length >= 2) {
        expect(w.ringLength).toBeGreaterThan(0);
      } else {
        expect(w.ringLength).toBe(0);
      }
    });

    it(`${name}: scale.roadLength が network.edges(小道込み)の path 総和と一致`, async () => {
      const m = await runPipeline("everdusk-101", params);
      let expected = 0;
      for (const e of m.network.edges) expected += pathLength(e.path);
      expect(m.summary.scale.roadLength).toBeCloseTo(expected, 6);
      expect(m.summary.scale.worldSize).toBe(m.ground.size);
    });
  }
});

describe("段15 サマリー: centerDescription が軸スコアと整合(4類型)", () => {
  it("arcane 支配 → 魔法都市", () => {
    const m = modelWithAxes({ arcane: 0.9, authority: 0.2, waterside: 0.1, rustic: 0 });
    expect(buildCenterDescription(m)).toContain("魔法都市");
  });
  it("authority 支配 → 城塞都市", () => {
    const m = modelWithAxes({ arcane: 0.2, authority: 0.9, waterside: 0.1, rustic: 0 });
    expect(buildCenterDescription(m)).toContain("城塞都市");
  });
  it("waterside 支配 → 水辺の街", () => {
    const m = modelWithAxes({ arcane: 0.1, authority: 0.2, waterside: 0.9, rustic: 0 });
    expect(buildCenterDescription(m)).toContain("水辺の街");
  });
  it("rustic 支配 → 素朴な集落", () => {
    const m = modelWithAxes({ arcane: 0.1, authority: 0.1, waterside: 0.1, rustic: 0.9 });
    expect(buildCenterDescription(m)).toContain("素朴な集落");
  });

  it("同点は固定順(arcane > authority > waterside > rustic)で解決", () => {
    const tie = modelWithAxes({ arcane: 0.5, authority: 0.5, waterside: 0.5, rustic: 0.5 });
    expect(buildCenterDescription(tie)).toContain("魔法都市");
  });

  it("水路があれば「水路の交わる」を接頭する", () => {
    const dry = modelWithAxes({ arcane: 0.9, authority: 0, waterside: 0, rustic: 0 });
    const wet = modelWithAxes(
      { arcane: 0.9, authority: 0, waterside: 0, rustic: 0 },
      { canals: 2 },
    );
    expect(dry.summary.centerDescription).toBe(""); // 未算出
    expect(buildCenterDescription(dry)).not.toContain("水路の交わる");
    expect(buildCenterDescription(wet)).toContain("水路の交わる魔法都市");
  });

  it("特徴節: 塔・結界環・門・橋・浮遊が数量詞つきで現れる", () => {
    const m = modelWithAxes(
      { arcane: 0.9, authority: 0, waterside: 0, rustic: 0 },
      { towers: 3, wardLevel: 2, ringPath: 4, gates: 2, bridges: 5, floaters: 1 },
    );
    const desc = buildCenterDescription(m);
    expect(desc).toContain("三基の魔導塔");
    expect(desc).toContain("結界環");
    expect(desc).toContain("二つの結界門");
    expect(desc).toContain("五つの橋");
    expect(desc).toContain("浮遊する魔法");
    expect(desc.endsWith("を持つ。")).toBe(true);
  });

  it("level 3 の結界環は「完全な結界環」", () => {
    const m = modelWithAxes(
      { arcane: 0.9, authority: 0, waterside: 0, rustic: 0 },
      { wardLevel: 3, ringPath: 4 },
    );
    expect(buildCenterDescription(m)).toContain("完全な結界環");
  });

  it("10 以上は算用数字", () => {
    const m = modelWithAxes(
      { arcane: 0.9, authority: 0, waterside: 0, rustic: 0 },
      { bridges: 12 },
    );
    expect(buildCenterDescription(m)).toContain("12つの橋");
  });

  it("特徴が無いときは「静かなたたずまい」", () => {
    const m = modelWithAxes({ arcane: 0.1, authority: 0.1, waterside: 0.1, rustic: 0.9 });
    expect(buildCenterDescription(m)).toBe("素朴な集落。静かなたたずまいを持つ。");
  });
});

describe("段15 サマリー: 決定性・冪等性", () => {
  it("同一入力の2回生成で summary が一致", async () => {
    const a = await runPipeline("everdusk-101", DEFAULT_PARAMS);
    const b = await runPipeline("everdusk-101", DEFAULT_PARAMS);
    expect(a.summary).toEqual(b.summary);
  });

  it("runSummary は乱数非消費で冪等(2回適用で不変)", async () => {
    const m = await runPipeline("everdusk-101", DEFAULT_PARAMS);
    const first = JSON.parse(JSON.stringify(m.summary));
    runSummary(m);
    // hash は runSummary が触らない(runPipeline が格納した値のまま)
    expect(m.summary).toEqual(first);
  });
});
