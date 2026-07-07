/**
 * 段15「サマリー」: 生成結果サマリー(contracts/worldmodel.md Summary 節)。
 * 最終状態の WorldModel から機械的に全フィールドを再算出して確定する。
 * 中間PHASEの各段は同名フィールドを部分的に先埋めするが、本段が最終値で
 * 上書きするため、サマリーは常に生成物と一致する(乖離しない)。
 * 乱数サブストリームは消費しない(モデル状態からの決定的な集計)。
 * 複雑度(頂点数・インスタンス数・draw call)はレンダラー実測値であり
 * 表示プリセット依存のため WorldModel には持たず、UI が表示時に埋める。
 * three 非依存の純関数。
 */
import type { BuildingRole, Vec2, WorldModel } from "../model/worldmodel";
import { pathLength } from "../model/geometry";

/** 支配軸ごとの都市の性格語(centerDescription の主文) */
const AXIS_NOUN: Record<keyof WorldModel["centerPlan"]["axes"], string> = {
  arcane: "魔法都市",
  authority: "城塞都市",
  waterside: "水辺の街",
  rustic: "素朴な集落",
};

/** 同点解決の固定順(contracts: arcane > authority > waterside > rustic) */
const AXIS_ORDER: (keyof WorldModel["centerPlan"]["axes"])[] = [
  "arcane",
  "authority",
  "waterside",
  "rustic",
];

/** 数量詞: 1〜9 は漢数字+助数詞、10 以上は算用数字(contracts Summary 節) */
const KANJI = ["", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
function counted(n: number, counter: string): string {
  const num = n < 10 ? KANJI[n] : String(n);
  return `${num}${counter}`;
}

/** 閉ループ(ringPath)の周長。閉じる辺(末尾→先頭)を含める */
function ringPerimeter(points: Vec2[]): number {
  const n = points.length;
  if (n < 2) return 0;
  let len = pathLength(points);
  const first = points[0];
  const last = points[n - 1];
  if (first && last) len += Math.hypot(first.x - last.x, first.z - last.z);
  return len;
}

/** centerPlan.axes の支配軸(最大軸。同点は固定順で解決) */
function dominantAxis(
  axes: WorldModel["centerPlan"]["axes"],
): keyof WorldModel["centerPlan"]["axes"] {
  let best = AXIS_ORDER[0]!;
  for (const key of AXIS_ORDER) {
    if (axes[key] > axes[best]) best = key;
  }
  return best;
}

/**
 * 中心建築の記述文を軸スコア+特徴から機械生成する(決定論的)。
 * 例「水路の交わる魔法都市。三基の魔導塔と結界環を持つ。」
 */
export function buildCenterDescription(model: WorldModel): string {
  const axis = dominantAxis(model.centerPlan.axes);
  const hasCanals = model.water.canals.length > 0;
  const prefix = hasCanals ? "水路の交わる" : "";
  const main = `${prefix}${AXIS_NOUN[axis]}。`;

  // 特徴節: あるものだけを連ねる
  const features: string[] = [];
  const towers = model.wards.towers.length;
  if (towers > 0) features.push(`${counted(towers, "基")}の魔導塔`);
  if (model.wards.wardLevel >= 1 && model.wards.ringPath.length > 0) {
    features.push(model.wards.wardLevel >= 3 ? "完全な結界環" : "結界環");
  }
  const gates = model.wards.gates.length;
  if (gates > 0) features.push(`${counted(gates, "つ")}の結界門`);
  const bridges = model.water.bridges.length;
  if (bridges > 0) features.push(`${counted(bridges, "つ")}の橋`);
  if (model.wards.floaters.length > 0) features.push("浮遊する魔法");

  const tail = features.length > 0 ? features.join("、") : "静かなたたずまい";
  return `${main}${tail}を持つ。`;
}

/** 段15「サマリー」の実体: summary 全フィールドを最終確定する */
export function runSummary(model: WorldModel): void {
  // 建物数(役割別内訳)。出現した役割のみキーを持つ
  const buildingCounts: Record<string, number> = {};
  for (const b of model.buildings) {
    const role: BuildingRole = b.role;
    buildingCounts[role] = (buildingCounts[role] ?? 0) + 1;
  }

  // 道路総延長(小道込みの最終総和)
  let roadLength = 0;
  for (const edge of model.network.edges) roadLength += pathLength(edge.path);

  model.summary = {
    buildingCounts,
    centerDescription: buildCenterDescription(model),
    waterOverview: {
      rivers: model.water.rivers.length,
      lakes: model.water.lakes.length,
      canals: model.water.canals.length,
      bridges: model.water.bridges.length,
    },
    wardOverview: {
      level: model.wards.wardLevel,
      ringLength: ringPerimeter(model.wards.ringPath),
      towers: model.wards.towers.length,
      gates: model.wards.gates.length,
      shrines: model.wards.shrines.length,
      floaters: model.wards.floaters.length,
    },
    scale: {
      worldSize: model.ground.size,
      roadLength,
    },
    // hash は runPipeline が全段完了後に格納する(空のまま残す)
    hash: model.summary.hash,
  };
}
