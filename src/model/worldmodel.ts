/**
 * WorldModel 型定義。
 * スキーマの正は docs/internal/contracts/worldmodel.md。本ファイルは同文書と同期させる。
 * WorldModel はプレーンなデータ構造(JSONシリアライズ可能)であり、
 * 時間・表示状態を持ち込まない。
 */

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
 * PHASE 2 以降、各PHASEの導入時にフィールドを確定し contracts を先に更新する。
 */
export interface Derived {
  /** ワールド一辺の実寸(240〜560)。World Scale 駆動 */
  worldSize: number;
}

export interface Meta {
  seed: string;
  params: Params;
  derived: Derived;
}

/** 材質ゾーングリッド。表現は PHASE 2 で確定(contracts/worldmodel.md) */
export type ZoneMask = null;
/** 密度場グリッド。表現は PHASE 3 で確定 */
export type FieldGrid = null;
/** 岸線データ。表現は PHASE 2 で確定 */
export type Shoreline = null;

export interface Ground {
  /** ワールド一辺の実寸 */
  size: number;
  /** 有機的な外縁形状(PHASE 2) */
  boundary: Polygon;
  /** 外周の閉じ方(Water 0付近は "fog" 固定) */
  edgeStyle: "fog" | "water";
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
  canals: Spline[];
  bridges: BridgeSite[];
  shoreline: Shoreline;
}

export interface Density {
  primary: FieldGrid;
  final: FieldGrid;
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

export interface Parcel {
  id: string;
  polygon: Polygon;
  frontEdge: [Vec2, Vec2];
  facing: number;
  waterside: boolean;
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

export interface Building {
  id: string;
  parcelId: string | null;
  role: BuildingRole;
  footprint: Polygon;
  floors: number;
  roof: { type: "gable" | "hip" | "compound"; pitch: number };
  materials: { wall: string; roof: string; trim: string };
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
    meta: { seed, params: { ...params }, derived: { worldSize: 0 } },
    ground: { size: 0, boundary: [], edgeStyle: "fog", zoneMask: null },
    water: { rivers: [], lakes: [], canals: [], bridges: [], shoreline: null },
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
