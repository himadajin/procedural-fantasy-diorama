/**
 * 段1「導出設定」: 6パラメータ(0〜100)を内部変数群へ写像する。
 * フィールドの正は docs/internal/contracts/worldmodel-core.md(Meta 節)、
 * 設計意図は implementation-spec 1.6節。
 *
 * 各写像はパラメータに対して単調とし、seed 揺らぎは進入点数・池の数の
 * 丸め閾値にのみ使う(makeRng(seed, "derive")。消費数・消費順は入力に依らず固定)。
 */
import { makeRng } from "../rng";
import type { Derived, Params, WorldModel } from "../model/worldmodel";

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/** seed + params → 導出設定(純関数・決定論的) */
export function computeDerived(seed: string, params: Params): Derived {
  const rng = makeRng(seed, "derive");
  // seed 揺らぎ(丸め閾値のみ)。消費順・消費数はここで固定する
  const entryJitter = rng.range(-0.35, 0.35);
  const pondJitter = rng.range(-0.15, 0.15);

  const scale = params.worldScale / 100;
  const settle = params.settlement / 100;
  const prosper = params.prosperity / 100;
  const water = params.water / 100;
  const arcana = params.arcana / 100;
  const monument = params.monumentality / 100;

  const worldSize = 240 + 320 * scale;

  // 結界段階の閾値は 15/45/75 で固定(implementation-spec 1.6節。seed 揺らぎなし)
  const wardLevel: Derived["wardLevel"] =
    params.arcana < 15 ? 0 : params.arcana < 45 ? 1 : params.arcana < 75 ? 2 : 3;
  // 池1個あたりの目標面積は湖の目標面積に連動する(worldmodel-core.md Meta 節)
  const lakeArea = 0.05 + 0.16 * water;

  return {
    // --- World Scale 駆動 ---
    worldSize,
    // 進入点数の World Scale 連動(worldmodel-core.md「Derived」)
    entryPointCount: clamp(Math.round(2 + 2.8 * scale + entryJitter), 2, 5),
    roadBudget: worldSize * (2.2 + 1.8 * scale),
    marginWidth: 18 + 30 * scale,
    // Settlement 連動(街路沿いに区画が生まれるようになり、Settlement=100
    // 側が上限に恒常的に張り付いていたための調整。worldmodel-core.md
    // 「Derived」)
    parcelCountMax: Math.round(60 + 200 * scale + 80 * settle),

    // --- Settlement Pressure 駆動 ---
    densityPeak: 0.55 + 0.45 * settle,
    densityFalloff: 0.2 + 0.25 * settle,
    parcelRate: 0.35 + 0.55 * settle,
    parcelSize: 16 - 9 * settle,
    laneAmount: settle,
    floorsBias: 0.6 * settle,
    // 二次街路(street)の総弧長予算。worldSize/scale にも連動する
    // 複合式(worldmodel-core.md「Derived」)。Settlement=0 の基礎係数は
    // 寒村の街路過多を是正するため 0.35(Settlement=100 側は 2.7)
    streetBudget: worldSize * (0.35 + 2.35 * settle) * (0.55 + 0.9 * scale),

    // --- Prosperity 駆動 ---
    wallTier: 3 * prosper,
    roofTier: 3 * prosper,
    roadGrade: 2 * prosper,
    detailAmount: prosper,
    tidiness: prosper,

    // --- Water Presence 駆動 ---
    // 本数は Water 0 で必ず 0(揺らぎ込みでも負側に収まるようオフセットを取る)
    pondCount: clamp(Math.round(3.4 * water - 0.25 + pondJitter), 0, 4),
    pondArea: lakeArea * 0.18,
    lakeChance: clamp(1.5 * water - 0.2, 0, 1),
    lakeArea,
    waterAreaCap: 0.35,
    // 水路発火スコア。主駆動は Water、Settlement が弱い正の寄与(1.6節)
    canalScore: water * (0.5 + 0.5 * settle),
    // 旧仕様(河川の最終幅 × 0.35)と全パラメータ 50 で等価。面積クリップとは連動しない
    canalWidth: clamp(1.75 + 3.85 * water, 2.2, 5),
    marshAmount: water * water,
    sandbarAmount: water,
    watersideRate: water,
    shoreVegetation: Math.sqrt(water),

    // --- Arcana 駆動 ---
    wardLevel,
    wallClosure: clamp((params.arcana - 15) / 85, 0, 1),
    towerScale: arcana,
    gateScale: arcana,
    lampDensity: arcana * arcana,
    floaterAmount: clamp((params.arcana - 30) / 70, 0, 1),
    shrineRate: 0.8 * arcana,
    glowIntensity: arcana,
    glowAreaCap: 0.005,
    centerArcaneBias: arcana,

    // --- Monumentality 駆動 ---
    centerFootprint: 14 + 30 * monument,
    centerHeight: 12 + 44 * monument,
    centerPlazaRadius: 10 + 22 * monument,
    upgradeRadius: 20 + 80 * monument,
    parcelReserve: 1.2 + 1.2 * monument,
    skylineRatio: 1.8 + 1.7 * monument,
  };
}

/** パイプライン段の実体: meta.derived を埋める */
export function runDerive(model: WorldModel): void {
  model.meta.derived = computeDerived(model.meta.seed, model.meta.params);
}
