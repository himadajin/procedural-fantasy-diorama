/**
 * WorldModel 型定義。
 * スキーマの正は docs/internal/contracts/worldmodel.md。本ファイルは同文書と同期させる。
 * WorldModel はプレーンなデータ構造(JSONシリアライズ可能)であり、
 * 時間・表示状態を持ち込まない。
 */

import { createZoneMask, type ZoneMask } from "./zonemask";
import type { FieldGrid } from "./fieldgrid";

export { ZONE_KINDS, type ZoneKind, type ZoneMask } from "./zonemask";
export type { FieldGrid } from "./fieldgrid";

/** 水面の高さ(地面 y=0 より 0.6 低い。implementation-spec 1.8節) */
export const WATER_SURFACE_Y = -0.6;
/** 岸スカート下端(水面より 1.0 低い。implementation-spec 1.8節) */
export const SHORE_SKIRT_BOTTOM_Y = WATER_SURFACE_Y - 1.0;

/** xz平面上の点(y-up。地面は y=0) */
export interface Vec2 {
  x: number;
  z: number;
}

/** 閉多角形。時計回り。自己交差なし */
export type Polygon = Vec2[];

/** 中心線+幅(川・水路・道路リボンの元) */
export interface Spline {
  points: Vec2[];
  width: number;
}

/** ユーザー操作の6パラメータ(0〜100)。名前と既定値は design.md が正 */
export interface Params {
  worldScale: number;
  settlement: number;
  prosperity: number;
  water: number;
  arcana: number;
  monumentality: number;
}

export const DEFAULT_PARAMS: Params = {
  worldScale: 50,
  settlement: 50,
  prosperity: 50,
  water: 50,
  arcana: 50,
  monumentality: 50,
};

/**
 * パラメータ→内部変数(implementation-spec 1.6節)。
 * フィールドの正は contracts/worldmodel.md(Meta 節)。
 * 各フィールドは駆動パラメータに対して単調な写像とし、seed 揺らぎは
 * entryPointCount・riverCount の丸め閾値にのみ使う(pipeline/derive.ts)。
 */
export interface Derived {
  // --- World Scale 駆動 ---
  /** ワールド一辺の実寸。240〜560 */
  worldSize: number;
  /** 外縁の進入点の数。2〜4(整数。閾値に seed 揺らぎ) */
  entryPointCount: number;
  /** 道路網の総延長予算(実寸)。worldSize × 2.2〜4.0 */
  roadBudget: number;
  /** 外縁余白(森・草地帯)の厚み。18〜48 */
  marginWidth: number;
  /** 区画数の上限。60〜260(整数) */
  parcelCountMax: number;

  // --- Settlement Pressure 駆動 ---
  /** 密度場の中心ピーク値。0.55〜1.0 */
  densityPeak: number;
  /** 密度の半減距離(worldSize 比)。0.20〜0.45 */
  densityFalloff: number;
  /** 区画の採択確率。0.35〜0.9 */
  parcelRate: number;
  /** 平均敷地間口。16〜7(高いほど狭小・高密) */
  parcelSize: number;
  /** 小道(建物間の細い道)の生成量。0〜1 */
  laneAmount: number;
  /** 建物の平均階数への弱い正の寄与。0〜0.6 */
  floorsBias: number;

  // --- Prosperity 駆動 ---
  /** 壁材の階層(掘立→木組み漆喰→石造→切石)。0〜3 連続 */
  wallTier: number;
  /** 屋根パレットの階層(茅→木羽→瓦→スレート)。0〜3 連続 */
  roofTier: number;
  /** 道の等級(土→砂利→石畳)。0〜2 連続。広場舗装・護岸の整いも共有 */
  roadGrade: number;
  /** 窓・扉・梁のディテール量と整列度。0〜1 */
  detailAmount: number;
  /** 整い(建物の傾き・沈み込みノイズの逆数)。0〜1 */
  tidiness: number;

  // --- Water Presence 駆動 ---
  /** 主河川の本数。0〜2(整数。閾値に seed 揺らぎ。Water 0 で必ず 0) */
  riverCount: number;
  /** 川幅。5〜16(本数 0 でも連続値として保持し、閾値付近の連続変化に使う) */
  riverWidth: number;
  /** 湖の生成確率。0〜1(Water 0 で 0) */
  lakeChance: number;
  /** 湖の目標面積(箱庭面積比)。0.04〜0.18 */
  lakeArea: number;
  /** 水域合計面積の上限(箱庭面積比)。0.35 固定 */
  waterAreaCap: number;
  /** 水路発火スコア = Water×(0.5+0.5×Settlement)。0.35 以上で発火 */
  canalScore: number;
  /** 湿地マスクの広さ。0〜1 */
  marshAmount: number;
  /** 砂洲の広さ。0〜1 */
  sandbarAmount: number;
  /** 水辺建築・橋詰め建築・杭基礎の採択確率。0〜1 */
  watersideRate: number;
  /** 岸辺植生の密度。0〜1 */
  shoreVegetation: number;

  // --- Arcana 駆動 ---
  /** 結界段階。閾値 15/45/75(seed 揺らぎなし) */
  wardLevel: 0 | 1 | 2 | 3;
  /** 結界壁の閉じ率。0〜1 連続(段階を跨いで連続に閉じていく) */
  wallClosure: number;
  /** 魔導塔の数・高さのスケール。0〜1 */
  towerScale: number;
  /** 結界門の数・規模のスケール。0〜1 */
  gateScale: number;
  /** 魔法灯・発光紋様の密度。0〜1 */
  lampDensity: number;
  /** 浮遊要素の量。0〜1(Arcana 30 以下では 0) */
  floaterAmount: number;
  /** 聖域・祠の出現率。0〜0.8 */
  shrineRate: number;
  /** 発光強度のスケール。0〜1(基準値は art-direction 5.4節) */
  glowIntensity: number;
  /** 発光合計投影面積の上限(箱庭平面比)。0.005 固定(art-direction 5.4節) */
  glowAreaCap: number;
  /** 中心建築が魔導型に寄るバイアス。0〜1 */
  centerArcaneBias: number;

  // --- Monumentality 駆動 ---
  /** 中心建築 footprint 一辺の目安。14〜44 */
  centerFootprint: number;
  /** 中心建築の高さ目安。12〜56 */
  centerHeight: number;
  /** 中心前広場の半径。10〜32 */
  centerPlazaRadius: number;
  /** 中心周辺の建物格上げ半径。20〜100 */
  upgradeRadius: number;
  /** 中心周辺の区画予約半径(centerFootprint 比)。1.2〜2.4 */
  parcelReserve: number;
  /** スカイライン倍率。1.8〜3.5(PHASE 5a のアサーション基準) */
  skylineRatio: number;
}

/** 導出設定の初期値(段1「導出設定」実行前のプレースホルダー) */
export function createEmptyDerived(): Derived {
  return {
    worldSize: 0,
    entryPointCount: 0,
    roadBudget: 0,
    marginWidth: 0,
    parcelCountMax: 0,
    densityPeak: 0,
    densityFalloff: 0,
    parcelRate: 0,
    parcelSize: 0,
    laneAmount: 0,
    floorsBias: 0,
    wallTier: 0,
    roofTier: 0,
    roadGrade: 0,
    detailAmount: 0,
    tidiness: 0,
    riverCount: 0,
    riverWidth: 0,
    lakeChance: 0,
    lakeArea: 0,
    waterAreaCap: 0,
    canalScore: 0,
    marshAmount: 0,
    sandbarAmount: 0,
    watersideRate: 0,
    shoreVegetation: 0,
    wardLevel: 0,
    wallClosure: 0,
    towerScale: 0,
    gateScale: 0,
    lampDensity: 0,
    floaterAmount: 0,
    shrineRate: 0,
    glowIntensity: 0,
    glowAreaCap: 0,
    centerArcaneBias: 0,
    centerFootprint: 0,
    centerHeight: 0,
    centerPlazaRadius: 0,
    upgradeRadius: 0,
    parcelReserve: 0,
    skylineRatio: 0,
  };
}

export interface Meta {
  seed: string;
  params: Params;
  derived: Derived;
}

/**
 * 街中の水路(contracts/worldmodel.md Water 節)。
 * waterfield・岸線・zoneMask には影響させない(護岸で縁取られた
 * 掘り込みチャネル。立体化は PHASE 3 commit 11)。
 */
export interface Canal extends Spline {
  /** "canal/<i>"。生成インデックス由来で安定 */
  id: string;
  /** 岸沿い道フック(段13「小道」がこの側に岸沿い道を通す)。
   *  進行方向に対して +1=左岸 / -1=右岸 */
  towpathSide: 1 | -1;
}

/**
 * 岸線ループ(contracts/worldmodel.md Water 節)。
 * 境界内の陸地と水域の境界の等値線。抽出の正は model/waterfield.ts。
 */
export interface ShoreLoop {
  /** "shore/<n>"。抽出順で安定 */
  id: string;
  /** true=閉環(湖岸・中州)。false=外縁で切れる開いた岸線(川岸) */
  closed: boolean;
  /** 岸線の点列(水際 y=0 のライン。隣接間隔はセル寸程度) */
  points: Vec2[];
  /** points と同数。水域から陸側を向く単位法線 */
  normals: Vec2[];
}

/** 岸線データ(岸スカート・水面の岸距離・後PHASEの水辺判定の元) */
export interface Shoreline {
  /** 岸線抽出グリッドのセル寸(≒ ground.size×1.1 / セル数) */
  cellSize: number;
  /** 岸線の点列。水域が無ければ空 */
  loops: ShoreLoop[];
}

export interface Ground {
  /** ワールド一辺の実寸(= derived.worldSize) */
  size: number;
  /**
   * 有機的な外縁形状。閉多角形・自己交差なし・時計回り
   * (shoelace 符号負)・原点まわりの星形(contracts/worldmodel.md)
   */
  boundary: Polygon;
  /** 外周の閉じ方(水系段が確定。Water 0付近は "fog" 固定) */
  edgeStyle: "fog" | "water";
  /** 材質ゾーン(草地/土/砂洲/湿地)のグリッド(model/zonemask.ts) */
  zoneMask: ZoneMask;
}

export type RoadClass = "main" | "connector" | "lane";

export interface BridgeSite {
  id: string;
  position: Vec2;
  angle: number;
  width: number;
  length: number;
  over: "river" | "lake" | "canal";
  roadClass: RoadClass;
}

export interface Water {
  rivers: Spline[];
  lakes: Polygon[];
  canals: Canal[];
  bridges: BridgeSite[];
  shoreline: Shoreline;
}

export interface Density {
  /** 一次密度場(中心距離+道路近接+Settlement)。段7が埋める(それまで null) */
  primary: FieldGrid | null;
  /** 最終密度場(一次+結界内ブースト)。PHASE 4a の担当(それまで null) */
  final: FieldGrid | null;
}

export interface Network {
  nodes: { id: string; position: Vec2 }[];
  edges: {
    id: string;
    from: string;
    to: string;
    class: RoadClass;
    width: number;
    path: Vec2[];
    grade: number;
  }[];
  entryPoints: { id: string; position: Vec2 }[];
}

export interface Plaza {
  id: string;
  kind: "center" | "gate" | "bridgehead" | "crossing" | "courtyard";
  position: Vec2;
  radius: number;
  polygon: Polygon;
}

export interface CenterPlan {
  position: Vec2;
  footprint: Polygon;
  /** 4軸スコア(implementation-spec 1.7節) */
  axes: { arcane: number; authority: number; waterside: number; rustic: number };
  facing: number;
  heightHint: number;
}

export interface Wards {
  wardLevel: 0 | 1 | 2 | 3;
  ringPath: Vec2[];
  ringSegments: { start: number; end: number; kind: "wall" | "overwater" | "gap" }[];
  towers: { id: string; position: Vec2; height: number; onRing: boolean }[];
  gates: { id: string; position: Vec2; angle: number; roadEdgeId: string }[];
  shrines: { id: string; position: Vec2; kind: "shrine" | "stones" | "crystals" }[];
  lamps: { id: string; position: Vec2 }[];
  floaters: {
    id: string;
    anchorId: string;
    basePosition: { x: number; y: number; z: number };
    size: number;
  }[];
}

/**
 * 敷地(contracts/worldmodel.md Parcel / Building 節)。
 * 段11「区画」が道路 edge 沿いの矩形敷地として埋める。
 */
export interface Parcel {
  /** "parcel/<roadEdgeId>/<L|R>/<slot>"。位置・edge 由来で安定 */
  id: string;
  /** 接道する道路 edge の id */
  roadEdgeId: string;
  /** 敷地(間口×奥行きの矩形)。時計回り・自己交差なし */
  polygon: Polygon;
  /** 接道辺(接道 edge 側の2頂点。接線方向昇順) */
  frontEdge: [Vec2, Vec2];
  /** 正面方位(xz 偏角。敷地から接道 edge の中心線へ向かう方向) */
  facing: number;
  /** 河川・湖の岸沿い(判定基準は contracts) */
  waterside: boolean;
  /** 水路沿い(同) */
  canalside: boolean;
}

export type BuildingRole =
  | "house"
  | "waterside"
  | "bridgehead"
  | "hall"
  | "warehouse"
  | "outskirt"
  | "center";

/** 建築部品。「型+パラメータ」で表現しメッシュビルダーが一括処理する */
export interface Part {
  type: string;
  transform: {
    position: [number, number, number];
    rotation: number;
    scale: [number, number, number];
  };
  materialId: string;
  params?: Record<string, number>;
}

/**
 * 接地(基壇・杭・石基礎)。契約は contracts/worldmodel.md Parcel / Building 節。
 * overWater の建物は kind ∈ {"piles", "stonebase"} かつ
 * bottomY = SHORE_SKIRT_BOTTOM_Y(-1.6)で機械判定できる。
 */
export interface Foundation {
  /** 基壇 / 杭 / 石基礎 */
  kind: "plinth" | "piles" | "stonebase";
  /** 基壇の立ち上がり高(y=0 から。Prosperity・役割駆動) */
  plinthHeight: number;
  /** footprint が水面(河川・湖)上に張り出すか */
  overWater: boolean;
  /** 基礎下端の y。陸上は 0、水上張り出しは -1.6(岸スカート下端) */
  bottomY: number;
}

export interface Building {
  /** "building/<parcelId の parcel/ 以降>"。区画由来で安定 */
  id: string;
  /** 中心建築は null(centerPlan に立地。PHASE 5a) */
  parcelId: string | null;
  role: BuildingRole;
  /** 矩形/L字/T字。セットバック込み。時計回り・自己交差なし */
  footprint: Polygon;
  /** 正面方位(xz 偏角。広場 > 道路 > 水面の優先+揺らぎ込み) */
  facing: number;
  /** 階数。1〜3 の整数 */
  floors: number;
  /** pitch は度数(50〜58。art-direction 6節) */
  roof: { type: "gable" | "hip" | "compound"; pitch: number };
  /** 接地(段12の骨格データ。commit 12) */
  foundation: Foundation;
  /** 素材ID。展開は PHASE 4a commit 13 の担当(それまで空文字列) */
  materials: { wall: string; roof: string; trim: string };
  /** 建築部品の展開結果。PHASE 4a commit 13 の担当(それまで空配列) */
  parts: Part[];
}

export interface Vegetation {
  trees: {
    id: string;
    position: Vec2;
    form: "conifer" | "broadleaf";
    scale: number;
    rotation: number;
    colorVar: number;
  }[];
  shrubs: { id: string; position: Vec2; scale: number }[];
  grassPatches: { id: string; polygon: Polygon }[];
}

export interface Summary {
  buildingCounts: Record<string, number>;
  centerDescription: string;
  waterOverview: { rivers: number; lakes: number; canals: number; bridges: number };
  wardOverview: {
    level: number;
    ringLength: number;
    towers: number;
    gates: number;
    shrines: number;
    floaters: number;
  };
  scale: { worldSize: number; roadLength: number };
  complexity: { vertices: number; instances: number; drawCalls: number };
  hash: string;
}

export interface WorldModel {
  meta: Meta;
  ground: Ground;
  water: Water;
  density: Density;
  network: Network;
  plazas: Plaza[];
  centerPlan: CenterPlan;
  wards: Wards;
  parcels: Parcel[];
  buildings: Building[];
  vegetation: Vegetation;
  summary: Summary;
}

/** パイプライン開始時の空モデル */
export function createEmptyWorldModel(seed: string, params: Params): WorldModel {
  return {
    meta: { seed, params: { ...params }, derived: createEmptyDerived() },
    ground: {
      size: 0,
      boundary: [],
      edgeStyle: "fog",
      zoneMask: createZoneMask(0, 0),
    },
    water: {
      rivers: [],
      lakes: [],
      canals: [],
      bridges: [],
      shoreline: { cellSize: 0, loops: [] },
    },
    density: { primary: null, final: null },
    network: { nodes: [], edges: [], entryPoints: [] },
    plazas: [],
    centerPlan: {
      position: { x: 0, z: 0 },
      footprint: [],
      axes: { arcane: 0, authority: 0, waterside: 0, rustic: 0 },
      facing: 0,
      heightHint: 0,
    },
    wards: {
      wardLevel: 0,
      ringPath: [],
      ringSegments: [],
      towers: [],
      gates: [],
      shrines: [],
      lamps: [],
      floaters: [],
    },
    parcels: [],
    buildings: [],
    vegetation: { trees: [], shrubs: [], grassPatches: [] },
    summary: {
      buildingCounts: {},
      centerDescription: "",
      waterOverview: { rivers: 0, lakes: 0, canals: 0, bridges: 0 },
      wardOverview: {
        level: 0,
        ringLength: 0,
        towers: 0,
        gates: 0,
        shrines: 0,
        floaters: 0,
      },
      scale: { worldSize: 0, roadLength: 0 },
      complexity: { vertices: 0, instances: 0, drawCalls: 0 },
      hash: "",
    },
  };
}
