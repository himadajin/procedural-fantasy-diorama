/**
 * ギャラリー生成エントリ(`../plans/2026-07-14-gallery.md` G1)。
 * 契約の正は `docs/internal/contracts/pipeline.md`「ギャラリー生成エントリ」節。
 *
 * `runPipeline` と並ぶ第二の正式な生成エントリ。造形(建物、将来は施設・
 * 中心建築)を単体でプロシージャル生成する。`createEmptyWorldModel` +
 * 最小限のフィールド上書き(平坦な地面1枚・区画1枚)で極小 WorldModel を
 * 合成し、本番の生成関数(`buildParcelBuilding` / `createSiteContext`)
 * **のみ**で対象を1体生成する。ギャラリー専用の造形・描画ロジックは
 * 一切持たない(本番の絵と乖離させないための契約の核心)。three 非依存。
 */
import {
  DEFAULT_PARAMS,
  type BuildingRole,
  type Params,
  type Parcel,
  type Polygon,
  type Vec2,
  type WorldModel,
  createEmptyWorldModel,
} from "../model/worldmodel";
import { hashWorldModel } from "../model/hash";
import { ensureClockwise } from "../model/geometry";
import { computeDerived } from "./derive";
import { createSiteContext } from "./parcels";
import { buildParcelBuilding, SINGLE_BUILD_OPTIONS } from "./buildings";
import { runSummary } from "./summary";

// --- 極小ワールドの寸法(契約「極小ワールドの合成規約」の実装判断。
//     区画1枚の寸法は契約が定めない実装詳細のため、全 role の shape 分岐
//     (hall の T字条件 bw/bd ≥ 8 等)が余裕を持って成立する寸法を固定値で選ぶ) ---
/** 区画の間口(実寸) */
const PARCEL_FRONTAGE = 18;
/** 区画の奥行き(実寸) */
const PARCEL_DEPTH = 20;
/** 地面境界(正方形)の半径。区画・水辺の池を余裕を持って内包する */
const WORLD_HALF_EXTENT = 60;

/**
 * waterside 対象専用: 区画背面のすぐ外側に置く池(契約が明示する「対象の
 * 生成に必要な最小限のフィールド」の一部。水域が無いと waterside 建物の
 * 水上張り出し・杭基礎(本番の buildParcelBuilding が水面探索で判定する
 * 機能)が一切現れず、role を指定した意味が失われるため、waterside の
 * 対象にのみ最小限の池を合成する)。区画背面 [0, PARCEL_DEPTH] のすぐ外側
 * (z = PARCEL_DEPTH − 1 から)に置き、buildParcelBuilding の水面探索
 * (背面辺の中点・両端から最大 6.0 実寸)が bd の実現値(役割別サイズ式の
 * 変動域)によらず必ず水面を検出できるようにする。
 */
const WATERSIDE_POND_FRONT_Z = PARCEL_DEPTH - 1;
const WATERSIDE_POND_DEPTH = 14;
const WATERSIDE_POND_HALF_WIDTH = PARCEL_FRONTAGE / 2 + 6;

/** 平坦な正方形の地面境界(時計回り) */
function createGalleryBoundary(): Polygon {
  const h = WORLD_HALF_EXTENT;
  return ensureClockwise([
    { x: -h, z: -h },
    { x: h, z: -h },
    { x: h, z: h },
    { x: -h, z: h },
  ]);
}

/**
 * 対象1体ぶんの区画1枚。接道正面を z=0 の辺(x ∈ [-frontage/2, frontage/2])
 * に置き、建物は +z 方向(facing = −π/2。「敷地から接道 edge 中心線へ向かう
 * 方向」が −z を向く=建物は +z 側)へ奥行きを取る。id は `parcel/<...>` の
 * 契約の体系を踏襲した安定な合成値(道路 edge を持たないため roadEdgeId は
 * "gallery" 固定)。groupId は空(単棟。クラスタ抽選の対象外)。
 */
function createGalleryParcel(waterside: boolean): Parcel {
  const half = PARCEL_FRONTAGE / 2;
  const fl: Vec2 = { x: -half, z: 0 };
  const fr: Vec2 = { x: half, z: 0 };
  const br: Vec2 = { x: half, z: PARCEL_DEPTH };
  const bl: Vec2 = { x: -half, z: PARCEL_DEPTH };
  return {
    id: "parcel/gallery/L/0",
    roadEdgeId: "gallery",
    polygon: ensureClockwise([fl, fr, br, bl]),
    frontEdge: [fl, fr],
    facing: -Math.PI / 2,
    waterside,
    canalside: false,
    groupId: "",
  };
}

/** waterside 対象専用の池(区画背面のすぐ外側。上記コメント参照) */
function createWatersidePond(): Polygon {
  const half = WATERSIDE_POND_HALF_WIDTH;
  const z0 = WATERSIDE_POND_FRONT_Z;
  const z1 = z0 + WATERSIDE_POND_DEPTH;
  return ensureClockwise([
    { x: -half, z: z0 },
    { x: half, z: z0 },
    { x: half, z: z1 },
    { x: -half, z: z1 },
  ]);
}

/**
 * 極小ワールドを合成し、本番の生成関数のみで対象(一般建物1棟)を生成する。
 * 本番のパイプライン段(pipeline/derive 等)は順に実行しない。
 * `computeDerived`(段1「導出設定」の純関数)・`runSummary`(段15
 * 「サマリー」。乱数非消費・モデル状態からの決定的な集計)は、対象生成
 * (`buildParcelBuilding`)そのものではなく極小モデルの合成・出力整形の一部
 * として直接呼ぶ(本番の造形・判定ロジックを再実装しないための選択)。
 */
function buildSingleBuildingWorld(
  seed: string,
  params: Params,
  role: BuildingRole,
): WorldModel {
  const model = createEmptyWorldModel(seed, params);
  model.meta.derived = computeDerived(seed, params);
  model.ground.boundary = createGalleryBoundary();
  model.ground.size = WORLD_HALF_EXTENT * 2;

  const isWaterside = role === "waterside";
  const parcel = createGalleryParcel(isWaterside);
  if (isWaterside) {
    model.water.ponds = [createWatersidePond()];
  }
  model.parcels = [parcel];

  const ctx = createSiteContext(model);
  const result = buildParcelBuilding(model, ctx, parcel, {
    ...SINGLE_BUILD_OPTIONS,
    roleOverride: role,
  });
  model.buildings = [result.building];

  runSummary(model);
  model.summary.hash = hashWorldModel(model);
  return model;
}

/**
 * 対象id → 極小ワールド合成関数の対応表(契約「対象idの体系」)。
 * MVP(本タスク G1): 一般建物の全 role(`BuildingRole` から "center" を
 * 除いた6つ)。将来の対象(中心建築 `center`・施設 `facility/<kind>`。
 * Phase D)はこの表に行を足すだけで成立する設計(早すぎる抽象化を避ける)。
 */
const GALLERY_TARGETS: Readonly<
  Record<string, (seed: string, params: Params) => WorldModel>
> = {
  "building/house": (seed, params) =>
    buildSingleBuildingWorld(seed, params, "house"),
  "building/waterside": (seed, params) =>
    buildSingleBuildingWorld(seed, params, "waterside"),
  "building/bridgehead": (seed, params) =>
    buildSingleBuildingWorld(seed, params, "bridgehead"),
  "building/hall": (seed, params) =>
    buildSingleBuildingWorld(seed, params, "hall"),
  "building/warehouse": (seed, params) =>
    buildSingleBuildingWorld(seed, params, "warehouse"),
  "building/outskirt": (seed, params) =>
    buildSingleBuildingWorld(seed, params, "outskirt"),
};

/** 実装済みの対象id一覧(UI・URL 検証(G2)が使う) */
export const GALLERY_TARGET_IDS: readonly string[] =
  Object.keys(GALLERY_TARGETS);

/**
 * ギャラリーの生成エントリ(契約「ギャラリー生成エントリ」節)。
 * `runPipeline` と並ぶ第二の正式な生成エントリ。
 *
 * @param targetId 対象id(`building/<role>` 等。契約「対象idの体系」)
 * @param seed 対象の seed
 * @param params 部分 Params。省略項目は `design.md` の既定値(50)を補う
 * @returns 正規化ハッシュ(`summary.hash`)を格納した、本物の WorldModel
 *   (極小だが `runPipeline` の出力と同じ型)
 */
export function buildGalleryWorld(
  targetId: string,
  seed: string,
  params: Partial<Params>,
): WorldModel {
  const builder = GALLERY_TARGETS[targetId];
  if (!builder) {
    throw new Error(`buildGalleryWorld: 未知の対象id "${targetId}"`);
  }
  const fullParams: Params = { ...DEFAULT_PARAMS, ...params };
  return builder(seed, fullParams);
}
