/**
 * 段12「建物」: 役割・footprint・向き・階数・屋根・接地(基壇・杭)の骨格データ。
 * データの正は docs/internal/contracts/buildings.md(Parcel / Building 節)、
 * 設計は implementation-spec 1.3節(段11「建物」相当)・PHASE 4a。
 *
 * PHASE 4a 内の分担(契約): 本段のうち id / parcelId / role / footprint /
 * facing / floors / roof / foundation は commit 12(本実装)が埋める。
 * materials / parts の展開と zoneMask の建物 footprint 上書きは
 * commit 13 の担当(それまで materials は空文字列、parts は空配列)。
 *
 * - 役割は UI 選択なし・文脈から決定(広場面 / 橋詰め / 水辺 / 密度の裾 /
 *   低密度×低Prosperity / 基本住居)
 * - 向きは接道正面を初期値に、広場に面する場合は footprint の 4 軸のうち
 *   広場方向に最も近い軸へスナップ(広場 > 道路 > 水面の優先)。最後に
 *   ±数度の揺らぎ(tidiness 高で減。乱数は "building/<id>" サブストリーム)
 * - 水辺建築は背面の水面(湖・池)へ張り出し、杭または石基礎で
 *   水面下 y=-1.6(岸スカート下端)まで到達する(機械判定可能な契約)
 *
 * PHASE 4a commit 13 の追加分:
 * - materials(wall/roof/trim)を役割+wallTier/roofTier+seed で決定
 *   (基準色の語彙は contracts/materials.md「materialId の語彙」=
 *   art-direction 5.1節)
 * - 骨格文法: footprint を翼(wing)へ分解し、基壇(plinth / 杭 pile)→
 *   壁体(階数×翼)→ 屋根(gable / hip。複合は翼ごとの gable)の
 *   「型+パラメータ」部品リストへ展開する(同「Part の型語彙」)
 * - 建物 footprint による zoneMask の土/舗装上書き(段10 と同じ流儀)
 * - 部品の乱数は派生サブストリーム "building/<id>/parts" のみ消費
 *   (commit 12 の骨格データの乱数消費を変えない)
 *
 * PHASE 4b commit 14(本実装)の追加分(contracts/buildings.md
 * 「PHASE 4b commit 14 の詳細部品の性質」):
 * - 開口: 窓(少なく大きく、整列度と数は detailAmount/役割)・
 *   扉(正面 frontEdge 側に必ず 1 つ。役割で寸法差)
 * - 木組み梁(wall="plaster" の中 Prosperity 帯で顕著)と
 *   ジェッティ(上階張り出し。確率的)
 * - 煙突(Prosperity 駆動。胴幅は実寸比 15% 過大。art-direction 6節)
 * - 付属: 低い石垣・外階段・屋根の小窓(役割・Prosperity で確率的)
 * - 素材階層の移行規約の確定(離散選択+役割補正+±0.6 揺らぎの丸め。
 *   木組み梁は plaster 帯に連動)
 * - 詳細の乱数は派生サブストリーム "building/<id>/details" のみ消費
 *   (骨格・materials の乱数消費は commit 13 から不変)
 * - 小道(lane)の追加と窓・扉・梁・煙突の InstancedMesh 化は
 *   commit 15 の担当(本段のスコープ外であり仮実装ではない)
 *
 * PHASE 5a commit 16(本実装)の追加分:
 * - 一般建物の展開後、中心建築 1 棟(role "center"、parcelId null)を
 *   専用の拡張文法(pipeline/center.ts)で展開して buildings の末尾に追加し、
 *   中庭の Plaza(kind "courtyard")を plazas へ追記する
 * - スカイライン契約(中心最高点 ≥ 周辺一般建物の最高点 × skylineRatio)と
 *   発光面積の上限をパイプライン内アサーションで検証する
 * - 中心建築は接道正面・道路/広場の重なり検査の対象外(契約の例外)
 *
 * PHASE 6 commit 19 の追加分(contracts/buildings.md「水辺建築の拡張」):
 * - waterside 建物の水辺拡張部品(杭繋ぎ梁・杭支持デッキ・張り出し部屋・
 *   水路裏口)を全一般建物の確定後の第2パスで parts へ追記する。
 *   部品はすべて params.waterfront = 1 を持つ
 * - 乱数は派生サブストリーム "building/<id>/waterfront" のみ消費
 *   (骨格・parts・details の消費は commit 16 から不変)
 * - 採択は watersideRate(Water)駆動。張り出し延長と同じ衝突検査+
 *   全一般建物 footprint・採択済み水辺領域との重なり検査に通った場合のみ
 */
import { hashString, makeRng, type Rng } from "../rng";
import {
  FLOOR_HEIGHT,
  SHORE_SKIRT_BOTTOM_Y,
  ZONE_KINDS,
  type Building,
  type BuildingRole,
  type Derived,
  type Foundation,
  type Parcel,
  type Part,
  type Plaza,
  type Polygon,
  type Vec2,
  type WorldModel,
} from "../model/worldmodel";
import { polygonArea, polygonSignedDistance } from "../model/waterfield";
import { sampleFieldGrid } from "../model/fieldgrid";
import {
  ensureClockwise,
  polygonBounds,
  polygonsOverlap,
} from "../model/geometry";
import {
  createSiteContext,
  polylineTouchesPolygon,
  type SiteContext,
} from "./parcels";
import {
  applyCoverageToChannel,
  maskCellGrid,
  stampPolygon,
} from "./paving";
import {
  CENTER_GLOW_SHARE,
  buildingTopY,
  expandCenterBuilding,
  glowPartArea,
} from "./center";

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

function smoothstep(edge0: number, edge1: number, v: number): number {
  const t = clamp((v - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

// --- セットバック(契約: 前面 0.5 / 側面 0.7 / 背面 0.7) ---
const FRONT_SETBACK = 0.5;
const SIDE_SETBACK = 0.7;
const BACK_SETBACK = 0.7;

// --- 役割決定の閾値(契約) ---
/** 広場に面する判定(区画と広場ポリゴンの距離) */
const PLAZA_ADJ_DIST = 3;
/** 橋詰め判定(橋中心からの距離への加算) */
const BRIDGE_NEAR_EXTRA = 10;
/** 密度の裾(外縁の小建築) */
const OUTSKIRT_DENSITY = 0.14;
/** 倉庫・作業小屋の低密度閾値 */
const WAREHOUSE_DENSITY = 0.24;

// --- 向きの揺らぎ ---
/** 最大揺らぎ(度)。tidiness と建物半径でさらに縮む */
const MAX_JITTER_DEG = 3;
/** 揺らぎによる頂点変位の上限(実寸。セットバックを食い潰さない) */
const MAX_JITTER_SHIFT = 0.5;

// --- 水上張り出し(waterside) ---
/** 水面探索の最大距離(背面・左右の各辺の中点から) */
const OVERHANG_SEARCH = 6.0;
/** 水際からの張り出し長 */
const OVERHANG_INTO_WATER = 1.6;
/** 張り出し延長の上限 */
const OVERHANG_MAX = 7.0;
/** 張り出し延長の衝突クリアランス(道路は width/2 + これ) */
const OVERHANG_ROAD_CLEAR = 0.3;

// --- 屋根(art-direction 6節: 勾配 50〜58度) ---
const ROOF_PITCH_MIN = 50;
const ROOF_PITCH_MAX = 58;
/** 同型抑制(下記)による hip 抽選確率・pitch への変調幅(契約の提案値) */
const ROOF_HIP_PARITY_WAVE = 0.1;
const ROOF_PITCH_PARITY_WAVE = 1.5;

// --- 部品展開(contracts/buildings.md「Part の型語彙」) ---
// 階高は model/worldmodel.ts の FLOOR_HEIGHT を正とする(中心建築文法と共有)
export { FLOOR_HEIGHT } from "../model/worldmodel";
/** 軒の張り出し(スパン側)。深めに取る(art-direction 6節) */
const EAVE_OVERHANG = 0.65;
/** 妻側(棟方向)の張り出し */
const GABLE_END_OVERHANG = 0.4;
/** 屋根の底面を壁天端より沈める量(接合部の線を隠す) */
const ROOF_BASE_SINK = 0.12;
/** 基壇の壁面からのはね出し */
const PLINTH_OUTSET = 0.12;
/** 従属翼を主翼へ食い込ませる量(共平面の Z ファイティング回避) */
const WING_JOIN_OVERLAP = 0.06;
/** 杭の間隔・太さ・外周からの引き込み */
const PILE_SPACING = 2.4;
const PILE_WIDTH = 0.3;
const PILE_EDGE_INSET = 0.25;

// --- PHASE 4b commit 14: 開口・木組み・煙突・付属の定数
//     (contracts/buildings.md「PHASE 4b commit 14 の詳細部品の性質」) ---
/** 窓枠の壁面からの突出(セットバックの読み。art-direction 6節) */
const WINDOW_DEPTH = 0.16;
/** 窓下端の階床からの高さ */
const WINDOW_SILL = 0.85;
/** 窓の壁面端からの余白 */
const WINDOW_MARGIN = 0.75;
/** 窓どうしの最小あき(収容数の分母 = 窓幅 + これ) */
const WINDOW_GAP = 1.8;
/** 扉枠の突出 */
const DOOR_DEPTH = 0.18;
/** ジェッティ(上階張り出し)の張り出し量と床帯の高さ */
const JETTY_DEPTH = 0.32;
const JETTY_BAND_HEIGHT = 0.24;
/** 木組み梁の太さ(見付け)と壁面からの厚み */
const BEAM_THICKNESS = 0.16;
const BEAM_DEPTH = 0.1;
/** 煙突: 実寸相当の胴幅 × 15% 過大(art-direction 6節の様式言語) */
export const CHIMNEY_BASE_WIDTH = 0.72;
export const CHIMNEY_OVERSIZE = 1.15;
/** 煙突頂部の棟からの突出 */
const CHIMNEY_TOP_MIN = 0.7;
const CHIMNEY_TOP_MAX = 1.2;
/** 低い石垣の寸法と、建物正面から敷地前面帯への引き出し */
const FENCE_THICKNESS = 0.28;
const FENCE_FRONT_OFFSET = 0.4;
/** 外階段: 蹴上げの目安と 1 段の奥行き */
const STAIR_STEP_RISE = 0.26;
const STAIR_STEP_DEPTH = 0.3;
/** 屋根の小窓の寸法(幅×全高×奥行き)と、置ける屋根の最小スパン */
const DORMER_SIZE: [number, number, number] = [1.2, 1.0, 1.1];
const DORMER_MIN_SPAN = 4.6;

// --- PHASE 6 commit 19: 水辺建築の拡張(waterfront)の定数
//     (contracts/buildings.md「水辺建築の拡張」) ---
/** デッキの奥行き帯・床厚・両側の引き込み */
const DECK_DEPTH_MIN = 1.8;
const DECK_DEPTH_MAX = 2.6;
const DECK_THICKNESS = 0.22;
const DECK_SIDE_INSET = 0.35;
/** デッキ杭の太さ・間隔(建物杭よりわずかに細い) */
const DECK_PILE_W = 0.26;
const DECK_PILE_SPACING = 2.4;
/** 欄干: 柱の寸法・間隔と手すり */
const DECK_RAIL_H = 0.78;
const DECK_RAIL_POST_W = 0.12;
const DECK_RAIL_BAR = 0.09;
const DECK_RAIL_SPACING = 1.9;
/** 杭繋ぎ梁(水面 −0.6 の上)の高さ・断面 */
const PILE_TIE_Y = -0.25;
const PILE_TIE_H = 0.14;
const PILE_TIE_D = 0.1;
/** 張り出し部屋: 張り出し量・壁への食い込み・幅の帯 */
const ROOM_DEPTH = 1.15;
const ROOM_EMBED = 0.25;
const ROOM_MIN_FACE = 3.2;
const ROOM_W_MIN = 2.4;
const ROOM_W_MAX = 5.4;
/** 水路裏口: 水路までの最大距離(外向きプローブ 0.8 から) */
const BACKDOOR_CANAL_DIST = 6.0;
/** 水辺拡張部品の共通フラグ(契約: params.waterfront = 1) */
const WATERFRONT_FLAG = 1;

/** 窓の量の役割係数(倉庫は寡黙に、集会所は開く) */
const WINDOW_ROLE_COUNT: Record<BuildingRole, number> = {
  house: 1,
  waterside: 1,
  bridgehead: 1,
  hall: 1.15,
  warehouse: 0.35,
  outskirt: 0.55,
  center: 1,
};
/** 窓高の役割係数(hall は縦長、warehouse は低い明かり取り) */
const WINDOW_ROLE_HEIGHT: Record<BuildingRole, number> = {
  house: 1,
  waterside: 1,
  bridgehead: 1,
  hall: 1.3,
  warehouse: 0.8,
  outskirt: 0.85,
  center: 1,
};
/** 扉幅の役割帯 [min, max](warehouse は荷入れ口) */
const DOOR_ROLE_WIDTH: Record<BuildingRole, [number, number]> = {
  house: [1.05, 1.25],
  waterside: [1.05, 1.25],
  bridgehead: [1.1, 1.3],
  hall: [1.35, 1.55],
  warehouse: [1.8, 2.1],
  outskirt: [0.95, 1.1],
  center: [1.35, 1.55],
};
/** 煙突採択率の役割基礎(+0.55 × detailAmount) */
const CHIMNEY_ROLE_P: Record<BuildingRole, number> = {
  house: 0.18,
  waterside: 0.18,
  bridgehead: 0.2,
  hall: 0.38,
  warehouse: 0.06,
  outskirt: 0.05,
  center: 0.3,
};
/** 低い石垣・屋根小窓が付きうる役割 */
const FENCE_ROLES = new Set<BuildingRole>(["house", "hall"]);
const DORMER_ROLES = new Set<BuildingRole>([
  "house",
  "hall",
  "waterside",
  "bridgehead",
]);

// --- 素材(contracts/materials.md「materialId の語彙」= art-direction 5.1節) ---
const WALL_MATERIALS = ["rough-wood", "plaster", "stone", "ashlar"] as const;
const ROOF_MATERIALS = ["thatch", "shingle", "tile", "slate"] as const;
/** 石造系の壁(zoneMask 上書きが paved になる。trim も stone) */
const STONE_WALLS = new Set<string>(["stone", "ashlar"]);
/** 素材階層への役割補正(契約) */
const MATERIAL_TIER_ROLE_ADJUST: Record<BuildingRole, number> = {
  house: 0,
  waterside: -0.2,
  bridgehead: 0.2,
  hall: 0.6,
  warehouse: -0.5,
  outskirt: -0.7,
  center: 0,
};
/** 素材階層の seed 揺らぎ幅(±) */
const MATERIAL_TIER_JITTER = 0.6;
/** 同型抑制(下記)による素材階層添字への変調幅(契約の提案値) */
const MATERIAL_PARITY_WAVE = 0.5;

// --- zoneMask の建物上書き(段10 と同じ流儀。契約) ---
const BUILDING_ZONE_BLEND = 1.2;
const BLEND_CELL_RATIO = 0.9;

interface LocalPoint {
  u: number;
  v: number;
}

/** 翼(wing): footprint ローカル軸(u=間口、v=奥行き)に整列した矩形 */
interface Wing {
  u0: number;
  u1: number;
  v0: number;
  v1: number;
}

/** 役割ごとの階数補正 */
const FLOORS_ROLE_ADJUST: Record<BuildingRole, number> = {
  house: 0,
  waterside: 0.1,
  bridgehead: 0.2,
  hall: 0.7,
  warehouse: -0.4,
  outskirt: -0.6,
  center: 0,
};

// --- サイズ勾配(市街中心の一般建物を 4 階まで許容。Phase C。
//     contracts/buildings.md「floors の改訂」) ---
/** urbanity 項の係数(提案値) */
const FLOORS_URBAN_GAIN = 1.1;
/** urbanity 正規化 smoothstep の下端・上端(提案値) */
const FLOORS_URBAN_EDGE0 = 0.55;
const FLOORS_URBAN_EDGE1 = 0.9;
/** この urbanity 以上の建物のみ floors 上限 4(それ以外は上限 3。提案値) */
const FLOORS_URBAN_4F_THRESHOLD = 0.75;

// --- 同型連続の抑制(位置由来の決定論的変調。Phase C。乱数非消費。
//     contracts/buildings.md「同型連続の抑制の設計原理」) ---
/** house の L 字抽選確率への変調幅(提案値: 0.35 ± 0.25) */
const SHAPE_L_PARITY_WAVE = 0.25;

/**
 * parcel.id ("parcel/<edgeId>/<L|R>/<slot>") 末尾のスロット連番を復元する。
 * groupId は同一 edge・同一側の連続採択 run なので、この絶対スロット値の
 * 偶奇はグループ内の隣接判定にそのまま使える(区画から独立に再導出でき、
 * スキーマは増やさない。計画書 C3「スロット序数」)。
 */
function parcelSlot(parcel: Parcel): number {
  const idx = parcel.id.lastIndexOf("/");
  return Number(parcel.id.slice(idx + 1));
}

/**
 * 同型連続の抑制の変調符号(±1。groupId を持たない区画は 0=無変調)。
 * スロット序数の偶奇に groupId のハッシュ由来の位相ビットを足しているため、
 * 同一グループ内では隣接スロットどうしが必ず符号反転する一方、グループが
 * 違えば偶数/奇数どちらに + が付くかもずれる。乱数は消費しない(隣接建物の
 * 生成結果も参照しない。設計原理どおり位置由来のみ)。
 */
function layoutParity(parcel: Parcel): number {
  if (!parcel.groupId) return 0;
  const phase = hashString(parcel.groupId) & 1;
  const slot = parcelSlot(parcel);
  return (slot + phase) % 2 === 0 ? 1 : -1;
}

/** 敷地の接道フレーム・可住寸法(乱数非消費の純幾何。frontSetback の値だけで
 *  可住奥行きが変わる。段12 本番ループとグループ計画(下記)の両方が使う) */
interface SiteGeometry {
  tx: number;
  tz: number;
  backX: number;
  backZ: number;
  origin: Vec2;
  usableW: number;
  usableD: number;
  center: Vec2;
}

function siteGeometry(
  parcel: Parcel,
  frontSetback: number,
  backSetbackExtra = 0,
): SiteGeometry {
  const [fa, fb] = parcel.frontEdge;
  const frontage = Math.hypot(fb.x - fa.x, fb.z - fa.z);
  const depth = frontage > 1e-6 ? polygonArea(parcel.polygon) / frontage : 0;
  const tx = (fb.x - fa.x) / Math.max(frontage, 1e-6);
  const tz = (fb.z - fa.z) / Math.max(frontage, 1e-6);
  const backX = -Math.cos(parcel.facing);
  const backZ = -Math.sin(parcel.facing);
  const frontMid = { x: (fa.x + fb.x) / 2, z: (fa.z + fb.z) / 2 };
  const origin = {
    x: frontMid.x + backX * frontSetback,
    z: frontMid.z + backZ * frontSetback,
  };
  const usableW = Math.max(2.2, frontage - 2 * SIDE_SETBACK);
  const usableD = Math.max(
    2.2,
    depth - frontSetback - BACK_SETBACK - backSetbackExtra,
  );
  const center = {
    x: origin.x + backX * (usableD / 2),
    z: origin.z + backZ * (usableD / 2),
  };
  return { tx, tz, backX, backZ, origin, usableW, usableD, center };
}

/** 役割ごとの基壇高さ補正 */
const PLINTH_ROLE_ADJUST: Record<BuildingRole, number> = {
  house: 0,
  waterside: 0.1,
  bridgehead: 0.05,
  hall: 0.25,
  warehouse: -0.05,
  outskirt: -0.05,
  center: 0,
};

/** 敷地に接する広場(距離 < PLAZA_ADJ_DIST)。無ければ null */
function adjacentPlaza(
  model: WorldModel,
  parcel: Parcel,
): { position: Vec2 } | null {
  const b = polygonBounds(parcel.polygon);
  for (const plaza of model.plazas) {
    const reach = plaza.radius + PLAZA_ADJ_DIST;
    if (
      plaza.position.x < b.minX - reach ||
      plaza.position.x > b.maxX + reach ||
      plaza.position.z < b.minZ - reach ||
      plaza.position.z > b.maxZ + reach
    ) {
      continue;
    }
    for (const p of parcel.polygon) {
      if (polygonSignedDistance(p.x, p.z, plaza.polygon) < PLAZA_ADJ_DIST) {
        return { position: plaza.position };
      }
    }
  }
  return null;
}

/** BridgeSite 近傍か(渡り長/2 + 10 以内) */
function nearBridge(model: WorldModel, center: Vec2): boolean {
  for (const bridge of model.water.bridges) {
    const d = Math.hypot(
      center.x - bridge.position.x,
      center.z - bridge.position.z,
    );
    if (d < bridge.length / 2 + BRIDGE_NEAR_EXTRA) return true;
  }
  return false;
}

/** 役割決定(契約の優先順: hall > bridgehead > waterside > outskirt > warehouse > house) */
function decideRole(
  rng: Rng,
  model: WorldModel,
  parcel: Parcel,
  center: Vec2,
  density: number,
): BuildingRole {
  const { derived } = model.meta;
  const plaza = adjacentPlaza(model, parcel);
  if (plaza && rng.chance(0.3 + 0.6 * derived.detailAmount)) return "hall";
  if (nearBridge(model, center) && rng.chance(0.35 + 0.55 * derived.watersideRate)) {
    return "bridgehead";
  }
  if (
    (parcel.waterside || parcel.canalside) &&
    rng.chance(0.5 + 0.5 * derived.watersideRate)
  ) {
    return "waterside";
  }
  if (density < OUTSKIRT_DENSITY) return "outskirt";
  if (
    density < WAREHOUSE_DENSITY &&
    derived.detailAmount < 0.55 &&
    rng.chance(0.6)
  ) {
    return "warehouse";
  }
  return "house";
}

// ============================================================
// グループ計画(クラスタパターンの抽選)。Phase C タスク C4b。
// contracts/buildings.md「区画グループとクラスタパターン」節・
// 3.4 節(13)(14)(計画書 2026-07-12-worldgen-rework-layout.md)。
// ============================================================

/** クラスタパターン(契約の抽選表)。C4b では rowhouse・courtyard の当選も
 *  single として扱う(生成は単棟のまま。実装は rowhouse が C5、courtyard が
 *  C4c で追いつく。契約 3.4 節(13): 抽選消費・条件判定は最終形と同一にして
 *  先行固定するための意図的な措置であり、仮実装ではない)。 */
export type ClusterPattern = "single" | "rowhouse" | "courtyard" | "stagger";

/** グループ長の条件(契約の表) */
const ROWHOUSE_MIN_LEN = 3;
const COURTYARD_MIN_LEN = 3;
const COURTYARD_MAX_LEN = 5;
const STAGGER_MIN_LEN = 2;
/** 連棟条件: urbanity 下限(契約の表) */
const ROWHOUSE_URBANITY_MIN = 0.6;
/**
 * 中庭型条件「奥行き余裕あり」(契約の表)= グループ内の最小 usableD
 * (前面・背面セットバック控除後の可住奥行き。既定 frontSetback=0.5 で評価)
 * が 6 以上(契約「区画グループとクラスタパターン」節の提案値。
 * C4c / C7 で中庭の実寸と付き合わせて調整しうる)。
 */
const COURTYARD_DEPTH_MARGIN = 6;

/** 連棟の採択率(契約の提案値) */
function rowhouseChance(settle: number): number {
  return clamp(0.2 + 0.6 * settle, 0, 0.75);
}
/** 中庭型の採択率(契約の提案値) */
function courtyardChance(prosper: number): number {
  return 0.12 + 0.28 * prosper;
}
/** 雁行の採択率(契約の提案値: 上記に外れた残りに 0.45) */
const STAGGER_CHANCE = 0.45;

/** 雁行の前面セットバック(序数パリティで交互。契約「雁行(stagger)の性質」の提案値) */
const STAGGER_SETBACK_NEAR = 0.5;
const STAGGER_SETBACK_FAR = 2.0;
/** 雁行の向き変調(±4°。同節の提案値) */
const STAGGER_YAW_DEG = 4;

// ============================================================
// 中庭型(courtyard)の実装定数(Phase C タスク C4c。
// contracts/buildings.md「中庭型(courtyard)の性質」実装補足の提案値)
// ============================================================
/**
 * 建物サイズ式(役割別)の bd = usableD × [0.72, 0.95] 相当の上限
 * (warehouse 0.9 / waterside ≤0.95 / house 系 ≤0.95。役割は本番ループの
 * 時点ではまだ決まっていないため、決定論的な後退量の算出には上限側で
 * 見積もる=安全側)。
 */
const COURTYARD_DEPTH_FRACTION_MAX = 0.95;
/** 端の建物(内向きスナップ)の奥行き(回転後は接道からの奥行きになる)下限・
 *  塀・Plaza との間の隙間 */
const COURTYARD_END_DEPTH_MIN = 3.5;
const COURTYARD_WALL_GAP = 0.6;
/** 端の建物のグループ内側への長さ(回転後)の下限・上限・可住間口に対する比率 */
const COURTYARD_END_LENGTH_MIN = 2.5;
const COURTYARD_END_LENGTH_MAX = 5.5;
const COURTYARD_END_LENGTH_FRACTION = 0.4;
/** 塀からさらに内側へ縮めた matrix が courtyard Plaza(契約の内側マージン) */
const COURTYARD_WALL_INSET = 0.8;
/** 塀の寸法(一般建物の様式に合わせた控えめな高さ・厚み) */
const COURTYARD_WALL_HEIGHT = 2.0;
const COURTYARD_WALL_THICKNESS = 0.4;
/** 中庭として成立させる最小の幅・奥行き(下回れば単棟へフォールバック) */
const COURTYARD_MIN_WIDTH = 6;
const COURTYARD_MIN_DEPTH = 2.5;
/** 帯制約 (12) を満たすための段階的な縮小の試行回数・1回あたりの縮小量 */
const COURTYARD_SHRINK_STEPS = 4;
const COURTYARD_SHRINK_STEP_SIZE = 0.6;
/** 帯制約 (12): 塀・Plaza の全コーナーはグループのいずれかのメンバー区画から
 *  この距離以内 */
const COURTYARD_PARCEL_BAND = 1.2;

/**
 * 中庭型グループの奥行き基準線(courtyard の奥行き後端。区画データのみから
 * 決定論的に導出する。乱数は消費しない)。グループ内メンバーの素の可住奥行き
 * (後退セットバックなし。既定 FRONT_SETBACK で評価)の最小値から、塀との
 * 隙間 COURTYARD_WALL_GAP を引いたもの。本番ループ(中間メンバーの後退量の
 * 目標値算出)と finalizeCourtyardGroups(塀・Plaza の外形算出)の双方が
 * 同じ式を共有する。
 */
function courtyardBackLine(members: readonly Parcel[]): number {
  let vBack = Infinity;
  for (const m of members) {
    const site = siteGeometry(m, FRONT_SETBACK);
    vBack = Math.min(vBack, FRONT_SETBACK + site.usableD);
  }
  return vBack - COURTYARD_WALL_GAP;
}

/** グループ内の 1 区画ぶんの配置計画 */
export interface ParcelLayout {
  /** 抽選で当選したパターン(rowhouse/courtyard は C4b 時点では single 同様に扱う) */
  pattern: ClusterPattern;
  /** グループ内の位置(0 起点。スロット連番順) */
  indexInGroup: number;
  /** グループの長さ */
  groupSize: number;
}

/**
 * 段12「建物」の本番ループの前に、区画グループ(`Parcel.groupId`)ごとに
 * `makeRng(seed, "layout/<groupId>")` の固定消費でクラスタパターンを
 * 1 つ抽選する(契約「クラスタパターンの抽選」「抽選消費の先行(13)」)。
 *
 * 連棟の適格判定に要る役割(role が house 系に揃うか)は、この時点では
 * 本抽選も段12 の建物生成も済んでいないため、`"building/<id>"` と同一
 * ラベルの使い捨ての新規 rng インスタンスで `decideRole` を先読みする
 * (同一 seed・同一ラベルの `makeRng` は常に同一の分岐を再現する純関数の
 * ため、後で段12 の本番ループが同じラベルで rng を作り直しても消費列は
 * 一切影響を受けない。要素独立乱数の規約を壊さない先読み。破棄済みの
 * 偵察実装で機能実績がある方式)。
 *
 * 出力はグループ・区画の反復順に依存しない(model.parcels の走査順が
 * 変わっても同一結果。乱数消費は `layout/<groupId>` ごとに 1 回のみ)。
 */
export function planGroupLayouts(model: WorldModel): Map<string, ParcelLayout> {
  const { seed, params } = model.meta;
  const settle = params.settlement / 100;
  const prosper = params.prosperity / 100;
  const rowP = rowhouseChance(settle);
  const courtP = courtyardChance(prosper);

  const groups = new Map<string, Parcel[]>();
  for (const parcel of model.parcels) {
    if (!parcel.groupId) continue;
    let bucket = groups.get(parcel.groupId);
    if (!bucket) {
      bucket = [];
      groups.set(parcel.groupId, bucket);
    }
    bucket.push(parcel);
  }

  const layoutByParcelId = new Map<string, ParcelLayout>();
  for (const [groupId, members] of groups) {
    // スロット連番順に並べる(id パース非依存の parcelSlot で再導出。
    // groups の走査順・bucket 内の挿入順のいずれにも依存しない)
    members.sort((a, b) => parcelSlot(a) - parcelSlot(b));
    const n = members.length;

    let allHouse = true;
    let anyWaterside = false;
    let urbanitySum = 0;
    let minUsableD = Infinity;
    for (const member of members) {
      if (member.waterside || member.canalside) anyWaterside = true;
      const geo = siteGeometry(member, FRONT_SETBACK);
      minUsableD = Math.min(minUsableD, geo.usableD);
      const density = model.density.final
        ? sampleFieldGrid(model.density.final, geo.center.x, geo.center.z)
        : 0;
      const urbanity = model.zoning
        ? sampleFieldGrid(model.zoning, geo.center.x, geo.center.z)
        : 0;
      urbanitySum += urbanity;
      const probeId = `building/${member.id.slice("parcel/".length)}`;
      const probeRng = makeRng(seed, probeId);
      const predictedRole = decideRole(probeRng, model, member, geo.center, density);
      if (predictedRole !== "house") allHouse = false;
    }
    const avgUrbanity = urbanitySum / n;

    const rowhouseEligible =
      n >= ROWHOUSE_MIN_LEN &&
      avgUrbanity >= ROWHOUSE_URBANITY_MIN &&
      allHouse &&
      !anyWaterside;
    const courtyardEligible =
      n >= COURTYARD_MIN_LEN &&
      n <= COURTYARD_MAX_LEN &&
      minUsableD >= COURTYARD_DEPTH_MARGIN;
    // 3.4 節(14): waterside/canalside を含むグループは雁行の適格から除外する
    const staggerEligible = n >= STAGGER_MIN_LEN && !anyWaterside;

    // 候補は契約の表の並び順で固定(rowhouse → courtyard → stagger → single)。
    // 条件を満たさない候補は除外し、`weighted` の内部正規化(重み合計で割る)
    // に採択率をそのまま渡す(契約:「残る候補の採択率で正規化して抽選する」)
    const candidates: ClusterPattern[] = [];
    const weights: number[] = [];
    let used = 0;
    if (rowhouseEligible) {
      candidates.push("rowhouse");
      weights.push(rowP);
      used += rowP;
    }
    if (courtyardEligible) {
      candidates.push("courtyard");
      weights.push(courtP);
      used += courtP;
    }
    if (staggerEligible) {
      candidates.push("stagger");
      weights.push(STAGGER_CHANCE);
      used += STAGGER_CHANCE;
    }
    candidates.push("single");
    weights.push(Math.max(0, 1 - used));

    const rng = makeRng(seed, `layout/${groupId}`);
    const pattern = rng.weighted(candidates, weights);

    members.forEach((member, i) => {
      layoutByParcelId.set(member.id, { pattern, indexInGroup: i, groupSize: n });
    });
  }
  return layoutByParcelId;
}

/**
 * 形状(ローカル座標。u=間口方向、v=前面からの奥行き)。
 * wings は部品展開用の翼分解(契約: 矩形=1翼、T=前面棟+背面中央翼、
 * L=前面棟+背面隅の翼。従属翼は主翼へ WING_JOIN_OVERLAP 食い込ませる)。
 */
function shapeVertices(
  rng: Rng,
  role: BuildingRole,
  bw: number,
  bd: number,
  parity: number,
): { verts: LocalPoint[]; compound: boolean; wings: Wing[] } {
  const w2 = bw / 2;
  if (role === "hall" && bw >= 8 && bd >= 8) {
    // T字: 前面棟+背面へ伸びる中央翼
    const fd = bd * 0.62;
    const ww = bw * 0.28;
    return {
      verts: [
        { u: -w2, v: 0 },
        { u: w2, v: 0 },
        { u: w2, v: fd },
        { u: ww, v: fd },
        { u: ww, v: bd },
        { u: -ww, v: bd },
        { u: -ww, v: fd },
        { u: -w2, v: fd },
      ],
      compound: true,
      wings: [
        { u0: -w2, u1: w2, v0: 0, v1: fd },
        { u0: -ww, u1: ww, v0: fd - WING_JOIN_OVERLAP, v1: bd },
      ],
    };
  }
  const lShapeP = clamp(0.35 + SHAPE_L_PARITY_WAVE * parity, 0, 1);
  if (role === "house" && bw >= 7.5 && bd >= 7.5 && rng.chance(lShapeP)) {
    // L字: 背面の一角を欠き取る
    const right = rng.chance(0.5);
    const nw = bw * 0.4;
    const nd = bd * 0.4;
    const verts: LocalPoint[] = right
      ? [
          { u: -w2, v: 0 },
          { u: w2, v: 0 },
          { u: w2, v: bd - nd },
          { u: w2 - nw, v: bd - nd },
          { u: w2 - nw, v: bd },
          { u: -w2, v: bd },
        ]
      : [
          { u: -w2, v: 0 },
          { u: w2, v: 0 },
          { u: w2, v: bd },
          { u: -w2 + nw, v: bd },
          { u: -w2 + nw, v: bd - nd },
          { u: -w2, v: bd - nd },
        ];
    return {
      verts,
      compound: true,
      wings: [
        { u0: -w2, u1: w2, v0: 0, v1: bd - nd },
        right
          ? { u0: -w2, u1: w2 - nw, v0: bd - nd - WING_JOIN_OVERLAP, v1: bd }
          : { u0: -w2 + nw, u1: w2, v0: bd - nd - WING_JOIN_OVERLAP, v1: bd },
      ],
    };
  }
  return {
    verts: [
      { u: -w2, v: 0 },
      { u: w2, v: 0 },
      { u: w2, v: bd },
      { u: -w2, v: bd },
    ],
    compound: false,
    wings: [{ u0: -w2, u1: w2, v0: 0, v1: bd }],
  };
}

/** 張り出し延長の衝突検査(契約: 他区画・道路・水路・広場・結界環・境界) */
function overhangBlocked(
  model: WorldModel,
  ctx: SiteContext,
  region: Polygon,
  ownParcelId: string,
): boolean {
  const probes: Vec2[] = [...region];
  for (let i = 0; i < region.length; i++) {
    const a = region[i];
    const b = region[(i + 1) % region.length];
    if (!a || !b) continue;
    probes.push({ x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 });
  }
  for (const p of probes) {
    if (ctx.boundaryInside(p.x, p.z) < 1) return true;
    if (ctx.canalSdf(p.x, p.z) < OVERHANG_ROAD_CLEAR) return true;
  }
  for (const parcel of model.parcels) {
    if (parcel.id === ownParcelId) continue;
    if (polygonsOverlap(region, parcel.polygon)) return true;
  }
  for (const edge of model.network.edges) {
    if (
      polylineTouchesPolygon(
        edge.path,
        region,
        edge.width / 2 + OVERHANG_ROAD_CLEAR,
      )
    ) {
      return true;
    }
  }
  for (const plaza of model.plazas) {
    if (polygonsOverlap(region, plaza.polygon)) return true;
  }
  const ring = model.wards.ringPath;
  if (ring.length >= 3) {
    const closedRing = [...ring, ring[0] as Vec2];
    if (polylineTouchesPolygon(closedRing, region, 2.5)) return true;
  }
  return false;
}

/**
 * 素材の決定(契約: derived の tier + 役割補正 + seed 揺らぎを丸めて添字)。
 * 乱数消費は建物あたり 2 回で固定。基準色の語彙は
 * contracts/materials.md「materialId の語彙」(art-direction 5.1節)。
 * 壁材階層・屋根パレットの本格移行は PHASE 4b(ここは基準色の選定まで)。
 */
function decideMaterials(
  rng: Rng,
  role: BuildingRole,
  wallTier: number,
  roofTier: number,
  parity: number,
): Building["materials"] {
  const adj = MATERIAL_TIER_ROLE_ADJUST[role];
  const parityJitter = MATERIAL_PARITY_WAVE * parity;
  const wallIdx = clamp(
    Math.round(
      wallTier +
        adj +
        rng.range(-MATERIAL_TIER_JITTER, MATERIAL_TIER_JITTER) +
        parityJitter,
    ),
    0,
    WALL_MATERIALS.length - 1,
  );
  const roofIdx = clamp(
    Math.round(
      roofTier +
        adj +
        rng.range(-MATERIAL_TIER_JITTER, MATERIAL_TIER_JITTER) +
        parityJitter,
    ),
    0,
    ROOF_MATERIALS.length - 1,
  );
  const wall = WALL_MATERIALS[wallIdx] ?? "plaster";
  const roof = ROOF_MATERIALS[roofIdx] ?? "shingle";
  return { wall, roof, trim: STONE_WALLS.has(wall) ? "stone" : "wood" };
}

/** 翼分解のワールド変換(揺らぎ回転込みの最終フレーム) */
interface WingFrame {
  /** ローカル (u=0, v=0) のワールド位置 */
  origin: Vec2;
  /** 間口方向(u)の単位ベクトル */
  u: Vec2;
  /** 奥行き方向(v)の単位ベクトル */
  v: Vec2;
}

/** 壁面(開口・梁の取り付き先)。t は面中心からの接線方向距離 */
interface WallFace {
  key: "front" | "back" | "left" | "right";
  /** 面の長さ(壁面の水平幅) */
  length: number;
  /** 面上の点(t: 面中心からの接線方向距離)のワールド xz */
  point(t: number): Vec2;
  /** 外向き法線(ワールド) */
  normal: Vec2;
}

/** 階ごとの壁体矩形(翼ローカル)。ジェッティは正面翼の上階を正面へ張り出す */
function wallRect(
  w: Wing,
  wingIndex: number,
  floor: number,
  hasJetty: boolean,
): Wing {
  if (hasJetty && wingIndex === 0 && floor >= 1) {
    return { u0: w.u0, u1: w.u1, v0: w.v0 - JETTY_DEPTH, v1: w.v1 };
  }
  return w;
}

/**
 * 建築文法: 翼ごとに 基壇(plinth。kind "piles" では杭列)→ 壁体(階数ぶん)→
 * 屋根(gable / hip)の骨格を展開し(commit 13)、続けて
 * 扉 → 窓 → 梁 → ジェッティ床帯 → 煙突 → 屋根小窓 → 石垣 → 外階段 の
 * 詳細部品を展開する(PHASE 4b commit 14。contracts/buildings.md
 * 「建物部品の性質」)。乱数は詳細部品の rng("building/<id>/details")のみ
 * 消費する(骨格は骨格データと materials から決定的)。
 */
function expandParts(
  wings: Wing[],
  frame: WingFrame,
  foundation: Foundation,
  floors: number,
  roof: Building["roof"],
  materials: Building["materials"],
  role: BuildingRole,
  derived: Derived,
  rng: Rng,
  frontSpan: { u0: number; u1: number },
  streetNormal: Vec2,
): Part[] {
  const parts: Part[] = [];
  // rotation は Y 軸まわり(ローカル +x → ワールド (cosθ, 0, −sinθ)。契約)
  const rotU = -Math.atan2(frame.u.z, frame.u.x);
  const rotV = -Math.atan2(frame.v.z, frame.v.x);
  const toWorld = (u: number, v: number): Vec2 => ({
    x: frame.origin.x + frame.u.x * u + frame.v.x * v,
    z: frame.origin.z + frame.u.z * u + frame.v.z * v,
  });
  /** 翼ローカル方向 (du, dv) → ワールド方向 */
  const dirWorld = (du: number, dv: number): Vec2 => ({
    x: frame.u.x * du + frame.v.x * dv,
    z: frame.u.z * du + frame.v.z * dv,
  });
  /** 梁など「+x=接線」の部品の rotation */
  const tangentRot = (d: Vec2): number => -Math.atan2(d.z, d.x);
  /** 開口など「+z=外向き法線」の部品の rotation(契約の開口変換規約) */
  const normalRot = (n: Vec2): number => Math.atan2(n.x, n.z);
  const plinthTop = foundation.plinthHeight;
  const plinthMaterial = materials.wall === "ashlar" ? "ashlar" : "stone";
  const detail = derived.detailAmount;

  // --- 詳細の建物ごと決定(消費順は契約に記載) ---
  // 木組み梁は wall="plaster"(tier 1 = 中 Prosperity 帯)に連動して顕著
  const hasBeams = materials.wall === "plaster" && rng.chance(0.88);
  const hasJetty =
    hasBeams && floors >= 2 && role !== "warehouse" && rng.chance(0.55);
  const windowW = 0.95 + 0.35 * rng.next();
  const windowH = clamp(
    (1.2 + 0.35 * detail) * WINDOW_ROLE_HEIGHT[role],
    0.9,
    1.85,
  );
  const [dw0, dw1] = DOOR_ROLE_WIDTH[role];
  const doorWRaw = dw0 + (dw1 - dw0) * rng.next();
  const doorOffT = rng.range(-1, 1);

  /** 正面翼の屋根の幾何(煙突・屋根小窓の取り付き先) */
  let roofInfo: {
    cu: number;
    cv: number;
    ridgeAlongU: boolean;
    ridgeWallLen: number;
    span: number;
    baseY: number;
    height: number;
  } | null = null;

  for (let wi = 0; wi < wings.length; wi++) {
    const w = wings[wi];
    if (!w) continue;
    const du = w.u1 - w.u0;
    const dv = w.v1 - w.v0;
    const c = toWorld((w.u0 + w.u1) / 2, (w.v0 + w.v1) / 2);

    // --- 基壇 / 杭(接地)。stonebase / 杭は bottomY = -1.6 から立ち上げ、
    //     水面下到達(接地契約)を部品として表す
    if (foundation.kind === "piles") {
      const height = plinthTop - foundation.bottomY;
      const uu0 = w.u0 + PILE_EDGE_INSET;
      const uu1 = w.u1 - PILE_EDGE_INSET;
      const vv0 = w.v0 + PILE_EDGE_INSET;
      const vv1 = w.v1 - PILE_EDGE_INSET;
      const corners: [number, number][] = [
        [uu0, vv0],
        [uu1, vv0],
        [uu1, vv1],
        [uu0, vv1],
      ];
      for (let k = 0; k < corners.length; k++) {
        const a = corners[k];
        const b = corners[(k + 1) % corners.length];
        if (!a || !b) continue;
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const n = Math.max(1, Math.ceil(len / PILE_SPACING));
        for (let i = 0; i < n; i++) {
          const t = i / n;
          const p = toWorld(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t);
          parts.push({
            type: "pile",
            transform: {
              position: [p.x, foundation.bottomY, p.z],
              rotation: rotU,
              scale: [PILE_WIDTH, height, PILE_WIDTH],
            },
            materialId: "wood",
          });
        }
      }
    } else {
      const bottom = foundation.kind === "stonebase" ? foundation.bottomY : 0;
      parts.push({
        type: "plinth",
        transform: {
          position: [c.x, bottom, c.z],
          rotation: rotU,
          scale: [
            du + 2 * PLINTH_OUTSET,
            plinthTop - bottom,
            dv + 2 * PLINTH_OUTSET,
          ],
        },
        materialId: plinthMaterial,
      });
    }

    // --- 壁体(1 階ぶん × 階数。ジェッティは上階を正面へ張り出す)
    for (let i = 0; i < floors; i++) {
      const r = wallRect(w, wi, i, hasJetty);
      const rc = toWorld((r.u0 + r.u1) / 2, (r.v0 + r.v1) / 2);
      parts.push({
        type: "wall",
        transform: {
          position: [rc.x, plinthTop + i * FLOOR_HEIGHT, rc.z],
          rotation: rotU,
          scale: [r.u1 - r.u0, FLOOR_HEIGHT, r.v1 - r.v0],
        },
        materialId: materials.wall,
        params: { floor: i },
      });
    }

    // --- 屋根: 棟は翼の長手方向。切妻基本、hip は矩形のみ、
    //     複合(L/T)は翼ごとの gable の組(契約)。
    //     ジェッティのある翼は張り出し後の最上階寸法に架ける
    const top = wallRect(w, wi, floors - 1, hasJetty);
    const duT = top.u1 - top.u0;
    const dvT = top.v1 - top.v0;
    const cT = toWorld((top.u0 + top.u1) / 2, (top.v0 + top.v1) / 2);
    const ridgeAlongU = duT >= dvT;
    const length = (ridgeAlongU ? duT : dvT) + 2 * GABLE_END_OVERHANG;
    const span = (ridgeAlongU ? dvT : duT) + 2 * EAVE_OVERHANG;
    const height = Math.tan((roof.pitch * Math.PI) / 180) * (span / 2);
    const roofBaseY = plinthTop + floors * FLOOR_HEIGHT - ROOF_BASE_SINK;
    parts.push({
      type: roof.type === "hip" ? "hip" : "gable",
      transform: {
        position: [cT.x, roofBaseY, cT.z],
        rotation: ridgeAlongU ? rotU : rotV,
        scale: [length, height, span],
      },
      materialId: materials.roof,
      params: { pitch: roof.pitch },
    });
    if (wi === 0) {
      roofInfo = {
        cu: (top.u0 + top.u1) / 2,
        cv: (top.v0 + top.v1) / 2,
        ridgeAlongU,
        ridgeWallLen: ridgeAlongU ? duT : dvT,
        span,
        baseY: roofBaseY,
        height,
      };
    }
  }

  // --- 詳細部品(PHASE 4b commit 14) ---
  const w0 = wings[0];
  if (!w0) return parts;
  expandDetailParts(parts, {
    wings,
    w0,
    frontSpan,
    toWorld,
    dirWorld,
    tangentRot,
    normalRot,
    rotU,
    plinthTop,
    plinthMaterial,
    floors,
    materials,
    role,
    detail,
    hasBeams,
    hasJetty,
    windowW,
    windowH,
    doorWRaw,
    doorOffT,
    roofInfo,
    rng,
    streetNormal,
  });
  return parts;
}

/** expandDetailParts へ渡す文脈(骨格展開で確定済みの幾何と決定値) */
interface DetailContext {
  wings: Wing[];
  w0: Wing;
  /** 水上張り出しで延長される前の正面スパン(扉・石垣・外階段のアンカー。
   *  張り出し延長部の中心へ扉が寄らないようにする) */
  frontSpan: { u0: number; u1: number };
  toWorld(u: number, v: number): Vec2;
  dirWorld(du: number, dv: number): Vec2;
  tangentRot(d: Vec2): number;
  normalRot(n: Vec2): number;
  rotU: number;
  plinthTop: number;
  plinthMaterial: string;
  floors: number;
  materials: Building["materials"];
  role: BuildingRole;
  detail: number;
  hasBeams: boolean;
  hasJetty: boolean;
  windowW: number;
  windowH: number;
  doorWRaw: number;
  doorOffT: number;
  roofInfo: {
    cu: number;
    cv: number;
    ridgeAlongU: boolean;
    ridgeWallLen: number;
    span: number;
    baseY: number;
    height: number;
  } | null;
  rng: Rng;
  /** 親区画の facing から導いた街路の外向き法線(契約 (10))。扉は wing0 の
   *  4 exterior faces のうち、これに最も外向き法線が近い面へ置く。
   *  非回転の建物では常に wing0 の front 面が選ばれる(既存挙動を無傷で
   *  再現する。front 面法線は jitter 込みでも streetNormal に極めて近く、
   *  他の面は直交に近いため選択が入れ替わらない) */
  streetNormal: Vec2;
}

/** 翼の外壁面(開口・梁を置く面)。翼どうしの接合面は除く(契約) */
function exteriorFaces(
  ctx: DetailContext,
  wingIndex: number,
  floor: number,
): WallFace[] {
  const w = ctx.wings[wingIndex];
  if (!w) return [];
  const r = wallRect(w, wingIndex, floor, ctx.hasJetty);
  const cu = (r.u0 + r.u1) / 2;
  const cv = (r.v0 + r.v1) / 2;
  const du = r.u1 - r.u0;
  const dv = r.v1 - r.v0;
  const single = ctx.wings.length === 1;
  const keys: WallFace["key"][] =
    wingIndex === 0
      ? single
        ? ["front", "right", "back", "left"]
        : ["front", "right", "left"]
      : ["back", "right", "left"];
  return keys.map((key) => {
    switch (key) {
      case "front":
        return {
          key,
          length: du,
          point: (t: number) => ctx.toWorld(cu + t, r.v0),
          normal: ctx.dirWorld(0, -1),
        };
      case "back":
        return {
          key,
          length: du,
          point: (t: number) => ctx.toWorld(cu + t, r.v1),
          normal: ctx.dirWorld(0, 1),
        };
      case "left":
        return {
          key,
          length: dv,
          point: (t: number) => ctx.toWorld(r.u0, cv + t),
          normal: ctx.dirWorld(-1, 0),
        };
      default:
        return {
          key,
          length: dv,
          point: (t: number) => ctx.toWorld(r.u1, cv + t),
          normal: ctx.dirWorld(1, 0),
        };
    }
  });
}

/**
 * 詳細部品の展開(PHASE 4b commit 14): 扉 → 窓 → 梁 → ジェッティ床帯 →
 * 煙突 → 屋根小窓 → 石垣 → 外階段 の順(契約の部品配列順)。
 * 乱数は "building/<id>/details" ストリーム(ctx.rng)のみ消費する。
 */
function expandDetailParts(parts: Part[], ctx: DetailContext): void {
  const {
    w0,
    toWorld,
    dirWorld,
    tangentRot,
    normalRot,
    rotU,
    plinthTop,
    plinthMaterial,
    floors,
    materials,
    role,
    detail,
    rng,
    streetNormal,
  } = ctx;

  // --- 扉(街路側の壁面に必ず 1 つ。契約 (10)) ---
  // wing0 の 4 外壁面のうち、外向き法線が親区画の facing(streetNormal)に
  // 最も近い面を選ぶ。回転していない建物は front 面の法線が streetNormal と
  // ほぼ一致するため常に front が選ばれ(既存挙動を無傷で再現する)、
  // 中庭型メンバーの 90° 内向きスナップでは front/back が街路と直交するため
  // left/right のいずれかが選ばれる(契約「中庭型(courtyard)の性質」(10))
  const doorFaces = exteriorFaces(ctx, 0, 0);
  let doorFace: WallFace =
    doorFaces[0] ??
    ({
      key: "front",
      length: w0.u1 - w0.u0,
      point: (t: number) => toWorld(t, w0.v0),
      normal: dirWorld(0, -1),
    } satisfies WallFace);
  let bestFaceDot = -Infinity;
  for (const f of doorFaces) {
    const dot = f.normal.x * streetNormal.x + f.normal.z * streetNormal.z;
    if (dot > bestFaceDot) {
      bestFaceDot = dot;
      doorFace = f;
    }
  }
  const isStreetFront = doorFace.key === "front";
  // アンカーは front 面のときのみ張り出し前の正面スパンを使う(水上張り出しで
  // wing0.u0/u1 が伸びても扉が延長部へ寄らないようにする既存挙動)。
  // それ以外(中庭型メンバーの回転済み胴体)は選択した面自身の座標系を使う
  // (waterside の端建物は回転対象外のため水上張り出しとは干渉しない)
  const du0 = isStreetFront
    ? ctx.frontSpan.u1 - ctx.frontSpan.u0
    : doorFace.length;
  const doorPosAt = isStreetFront
    ? (t: number): Vec2 =>
        toWorld((ctx.frontSpan.u0 + ctx.frontSpan.u1) / 2 + t, w0.v0)
    : (t: number): Vec2 => doorFace.point(t);
  const frontN = doorFace.normal;
  const frontRot = normalRot(frontN);
  // 面自身の接線方向(front/back は u 方向、left/right は v 方向。契約 (11)
  // の基準は footprint 多角形からの符号付き距離のため、回転しても部品帯の
  // 判定は無傷。ここは石垣・外階段の向きの見た目の整合のみに使う)
  const faceTangent =
    doorFace.key === "front" || doorFace.key === "back"
      ? dirWorld(1, 0)
      : dirWorld(0, 1);
  const faceRot = tangentRot(faceTangent);
  const doorW = clamp(ctx.doorWRaw, 0.85, Math.max(0.85, du0 - 1.0));
  const doorH = Math.min(
    role === "warehouse" ? 2.5 : 2.15,
    FLOOR_HEIGHT - 0.5,
  );
  const doorMax = Math.max(0, du0 / 2 - doorW / 2 - 0.45);
  const doorOff = clamp(ctx.doorOffT * 0.2 * du0, -doorMax, doorMax);
  const doorPos = doorPosAt(doorOff);
  const facePointOffset = (t: number, dist: number): Vec2 => {
    const p = doorPosAt(t);
    return { x: p.x + frontN.x * dist, z: p.z + frontN.z * dist };
  };
  parts.push({
    type: "door",
    transform: {
      position: [doorPos.x, plinthTop, doorPos.z],
      rotation: frontRot,
      scale: [doorW, doorH, DOOR_DEPTH],
    },
    materialId: "wood",
  });

  // --- 窓(少なく大きく。数と整列度は detailAmount / 役割。契約) ---
  // 列の本数は面ごとに 1 回だけ決め、全階で同じ列に整列させる
  const densityF =
    clamp(0.35 + 0.6 * detail, 0, 1) * WINDOW_ROLE_COUNT[role];
  for (let wi = 0; wi < ctx.wings.length; wi++) {
    const baseFaces = exteriorFaces(ctx, wi, 0);
    for (let fi = 0; fi < baseFaces.length; fi++) {
      const base = baseFaces[fi];
      if (!base) continue;
      const countRoll = rng.next();
      const usable = base.length - 2 * WINDOW_MARGIN;
      const slots = Math.floor(usable / (ctx.windowW + WINDOW_GAP));
      if (slots <= 0) continue;
      const n = Math.min(
        slots,
        Math.max(0, Math.round(slots * densityF + (countRoll - 0.5) * 0.8)),
      );
      if (n <= 0) continue;
      for (let floor = 0; floor < floors; floor++) {
        const face = exteriorFaces(ctx, wi, floor)[fi];
        if (!face) continue;
        const y = plinthTop + floor * FLOOR_HEIGHT + WINDOW_SILL;
        for (let i = 0; i < n; i++) {
          const t0 = -usable / 2 + (i + 0.5) * (usable / n);
          // 整列度 = detailAmount(高いほど等間隔に揃う)
          const jit = rng.range(-1, 1) * (1 - detail) * 0.5;
          const t = clamp(
            t0 + jit,
            -usable / 2 + ctx.windowW / 2,
            usable / 2 - ctx.windowW / 2,
          );
          // 扉のある壁面近傍は空ける(乱数は消費済み。契約 (10) により
          // 扉は wing0 の doorFace 面に置かれる。回転していない建物では
          // doorFace.key は常に "front")
          if (
            wi === 0 &&
            face.key === doorFace.key &&
            floor === 0 &&
            Math.abs(t - doorOff) < (doorW + ctx.windowW) / 2 + 0.25
          ) {
            continue;
          }
          const p = face.point(t);
          parts.push({
            type: "window",
            transform: {
              position: [p.x, y, p.z],
              rotation: normalRot(face.normal),
              scale: [ctx.windowW, ctx.windowH, WINDOW_DEPTH],
            },
            materialId: materials.trim,
          });
        }
      }
    }
  }

  // --- 木組み梁(plaster 帯。外壁面ごと・階ごとに横架材 2 + 隅柱 2) ---
  if (ctx.hasBeams) {
    for (let wi = 0; wi < ctx.wings.length; wi++) {
      for (let floor = 0; floor < floors; floor++) {
        for (const face of exteriorFaces(ctx, wi, floor)) {
          const y = plinthTop + floor * FLOOR_HEIGHT;
          const off = BEAM_DEPTH / 2 + 0.01;
          const c = face.point(0);
          const px = c.x + face.normal.x * off;
          const pz = c.z + face.normal.z * off;
          const tan = dirWorld(
            face.key === "front" || face.key === "back" ? 1 : 0,
            face.key === "front" || face.key === "back" ? 0 : 1,
          );
          const rot = tangentRot(tan);
          const railScale: [number, number, number] = [
            Math.max(0.4, face.length - 0.08),
            BEAM_THICKNESS,
            BEAM_DEPTH,
          ];
          parts.push({
            type: "beam",
            transform: {
              position: [px, y + 0.02, pz],
              rotation: rot,
              scale: railScale,
            },
            materialId: "wood",
          });
          parts.push({
            type: "beam",
            transform: {
              position: [px, y + FLOOR_HEIGHT - BEAM_THICKNESS - 0.02, pz],
              rotation: rot,
              scale: railScale,
            },
            materialId: "wood",
          });
          for (const s of [-1, 1]) {
            const q = face.point(s * (face.length / 2 - 0.18));
            parts.push({
              type: "beam",
              transform: {
                position: [
                  q.x + face.normal.x * off,
                  y + 0.02,
                  q.z + face.normal.z * off,
                ],
                rotation: rot,
                scale: [BEAM_THICKNESS, FLOOR_HEIGHT - 0.04, BEAM_DEPTH],
              },
              materialId: "wood",
            });
          }
        }
      }
    }
  }

  // --- ジェッティ床帯(張り出した上階の下端を受ける横木) ---
  if (ctx.hasJetty) {
    // 帯は実際の(張り出し込みの)正面壁の幅に合わせる
    const band = toWorld((w0.u0 + w0.u1) / 2, w0.v0 - JETTY_DEPTH / 2);
    parts.push({
      type: "jetty",
      transform: {
        position: [band.x, plinthTop + FLOOR_HEIGHT - JETTY_BAND_HEIGHT, band.z],
        rotation: rotU,
        scale: [w0.u1 - w0.u0 + 0.12, JETTY_BAND_HEIGHT, JETTY_DEPTH + 0.1],
      },
      materialId: "wood",
    });
  }

  // --- 煙突(Prosperity 駆動。胴幅 = 0.72 × 1.15 の 15% 過大で固定) ---
  const roofInfo = ctx.roofInfo;
  if (
    roofInfo &&
    rng.chance(clamp(CHIMNEY_ROLE_P[role] + 0.55 * detail, 0, 0.95))
  ) {
    const chimneyW = CHIMNEY_BASE_WIDTH * CHIMNEY_OVERSIZE;
    const margin = Math.max(
      chimneyW / 2 + 0.2,
      rng.range(0.15, 0.4) * roofInfo.ridgeWallLen,
    );
    const side = rng.chance(0.5) ? 1 : -1;
    const topExtra = rng.range(CHIMNEY_TOP_MIN, CHIMNEY_TOP_MAX);
    const along = side * Math.max(0, roofInfo.ridgeWallLen / 2 - margin);
    const pos = roofInfo.ridgeAlongU
      ? toWorld(roofInfo.cu + along, roofInfo.cv)
      : toWorld(roofInfo.cu, roofInfo.cv + along);
    const baseY = plinthTop + floors * FLOOR_HEIGHT - 0.3;
    const topY = roofInfo.baseY + roofInfo.height + topExtra;
    parts.push({
      type: "chimney",
      transform: {
        position: [pos.x, baseY, pos.z],
        rotation: rotU,
        scale: [chimneyW, topY - baseY, chimneyW],
      },
      materialId: plinthMaterial,
    });
  }

  // --- 屋根の小窓(スパンの広い屋根の正面側勾配面に 1 つ) ---
  if (
    roofInfo &&
    DORMER_ROLES.has(role) &&
    roofInfo.span >= DORMER_MIN_SPAN &&
    rng.chance(0.1 + 0.35 * detail)
  ) {
    const tFrac = rng.range(-0.28, 0.28);
    const sideRoll = rng.chance(0.5);
    const along = tFrac * Math.max(0, roofInfo.ridgeWallLen - 1.6);
    const d = 0.68 * (roofInfo.span / 2);
    // 棟が正面と平行なら正面側(−v)の勾配面へ。直交なら左右いずれか
    const cross = roofInfo.ridgeAlongU
      ? { u: 0, v: -1 }
      : { u: sideRoll ? 1 : -1, v: 0 };
    const pos = roofInfo.ridgeAlongU
      ? toWorld(roofInfo.cu + along, roofInfo.cv + cross.v * d)
      : toWorld(roofInfo.cu + cross.u * d, roofInfo.cv + along);
    const nrm = dirWorld(cross.u, cross.v);
    parts.push({
      type: "dormer",
      transform: {
        position: [pos.x, roofInfo.baseY + roofInfo.height * 0.32, pos.z],
        rotation: normalRot(nrm),
        scale: [...DORMER_SIZE],
      },
      materialId: materials.roof,
    });
  }

  // --- 低い石垣(敷地前面帯。扉前を開けた 2 セグメント) ---
  if (
    FENCE_ROLES.has(role) &&
    du0 >= 3.4 &&
    rng.chance(0.18 + 0.4 * detail)
  ) {
    const fenceH = 0.42 + 0.25 * rng.next();
    const gapHalf = doorW / 2 + 0.7;
    // 面は常に中心(t=0)対称(front は frontSpan、それ以外は doorFace 自身が
    // 対称な座標系のため。cu0 相当は常に 0)
    const segs: [number, number][] = [
      [-du0 / 2 + 0.15, doorOff - gapHalf],
      [doorOff + gapHalf, du0 / 2 - 0.15],
    ];
    for (const [a, b] of segs) {
      if (b - a < 1.0) continue;
      const mid = facePointOffset((a + b) / 2, FENCE_FRONT_OFFSET);
      parts.push({
        type: "fence",
        transform: {
          position: [mid.x, 0, mid.z],
          rotation: faceRot,
          scale: [b - a, fenceH, FENCE_THICKNESS],
        },
        materialId: "stone",
      });
    }
  }

  // --- 外階段(高い基壇の建物の扉前。地面 → 基壇天端) ---
  if (plinthTop >= 0.32 && rng.chance(0.85)) {
    const steps = clamp(Math.ceil(plinthTop / STAIR_STEP_RISE), 2, 4);
    const depth = steps * STAIR_STEP_DEPTH;
    parts.push({
      type: "stair",
      transform: {
        position: [
          doorPos.x + frontN.x * (depth / 2),
          0,
          doorPos.z + frontN.z * (depth / 2),
        ],
        rotation: frontRot,
        scale: [doorW + 0.5, plinthTop, depth],
      },
      materialId: plinthMaterial,
      params: { steps },
    });
  }
}

// --- PHASE 6 commit 19: 水辺建築の拡張(waterfront) ---

/** 水辺拡張が部品を付ける面(正面=接道側は対象外) */
type WaterfrontSide = "back" | "right" | "left";

/**
 * 水辺拡張の入力(段12 の主ループが建物ごとに収集し、全一般建物の
 * footprint 確定後の第2パスで展開する。デッキが後続建物の footprint と
 * 重ならないことを機械的に保証するため)。
 */
interface WaterfrontSite {
  parcel: Parcel;
  frame: WingFrame;
  wing: Wing;
  extSide: WaterfrontSide | null;
  foundation: Foundation;
  floors: number;
  roofPitch: number;
  materials: Building["materials"];
  parts: Part[];
}

/** 面の幾何(翼ローカル): 接線範囲 [t0, t1] と 点(t, 外向きオフセット o) */
interface WaterfrontFace {
  side: WaterfrontSide;
  t0: number;
  t1: number;
  local(t: number, o: number): LocalPoint;
  /** 外向き(翼ローカルの単位方向) */
  out: { du: number; dv: number };
}

function waterfrontFace(w: Wing, side: WaterfrontSide): WaterfrontFace {
  if (side === "back") {
    return {
      side,
      t0: w.u0,
      t1: w.u1,
      local: (t, o) => ({ u: t, v: w.v1 + o }),
      out: { du: 0, dv: 1 },
    };
  }
  if (side === "right") {
    return {
      side,
      t0: w.v0,
      t1: w.v1,
      local: (t, o) => ({ u: w.u1 + o, v: t }),
      out: { du: 1, dv: 0 },
    };
  }
  return {
    side,
    t0: w.v0,
    t1: w.v1,
    local: (t, o) => ({ u: w.u0 - o, v: t }),
    out: { du: -1, dv: 0 },
  };
}

/** 点から線分への距離(窓の除去判定) */
function distToSegment2(
  px: number,
  pz: number,
  a: Vec2,
  b: Vec2,
): number {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const lenSq = dx * dx + dz * dz;
  const t =
    lenSq > 0
      ? clamp(((px - a.x) * dx + (pz - a.z) * dz) / lenSq, 0, 1)
      : 0;
  return Math.hypot(px - (a.x + dx * t), pz - (a.z + dz * t));
}

/**
 * 面上の開口(waterfront の扉・部屋)に重なる既存の窓を配列から取り除く
 * (契約: 除去は配列からの削除のみで、乱数は消費しない)。
 * faceA→faceB は面の世界座標セグメント、centerAlong は faceA からの
 * 接線距離、halfSpan は開口の半幅(窓自身の半幅は窓ごとに加算)。
 */
function removeWindowsOnFace(
  parts: Part[],
  faceA: Vec2,
  faceB: Vec2,
  y0: number,
  y1: number,
  centerAlong: number,
  halfSpan: number,
): void {
  const dx = faceB.x - faceA.x;
  const dz = faceB.z - faceA.z;
  const len = Math.hypot(dx, dz);
  if (len < 1e-6) return;
  const tx = dx / len;
  const tz = dz / len;
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    if (!p || p.type !== "window" || p.params?.waterfront) continue;
    const [px, py, pz] = p.transform.position;
    if (py < y0 - 1e-6 || py > y1 + 1e-6) continue;
    if (distToSegment2(px, pz, faceA, faceB) > 0.12) continue;
    const along = (px - faceA.x) * tx + (pz - faceA.z) * tz;
    if (Math.abs(along - centerAlong) < halfSpan + p.transform.scale[0] / 2 + 0.2) {
      parts.splice(i, 1);
    }
  }
}

/**
 * 水辺拡張の展開(PHASE 6 commit 19。contracts/buildings.md
 * 「水辺建築の拡張」): 杭繋ぎ梁 → デッキ(床→杭→欄干柱→手すり→扉)→
 * 張り出し部屋(壁→屋根→窓→持ち送り梁)→ 水路裏口(扉→段)の順で
 * waterside 建物の parts へ追記する。乱数は "building/<id>/waterfront"
 * ストリーム(rng)のみ消費し、部品はすべて params.waterfront = 1 を持つ。
 */
function expandWaterfrontParts(
  model: WorldModel,
  ctx: SiteContext,
  site: WaterfrontSite,
  buildings: Building[],
  selfIndex: number,
  claimedRegions: { region: Polygon; owner: number }[],
  rng: Rng,
): void {
  const { parcel, frame, wing, extSide, foundation, floors, materials, parts } =
    site;
  const { derived } = model.meta;
  const toWorld = (u: number, v: number): Vec2 => ({
    x: frame.origin.x + frame.u.x * u + frame.v.x * v,
    z: frame.origin.z + frame.u.z * u + frame.v.z * v,
  });
  const dirWorld = (du: number, dv: number): Vec2 => ({
    x: frame.u.x * du + frame.v.x * dv,
    z: frame.u.z * du + frame.v.z * dv,
  });
  const tangentRot = (d: Vec2): number => -Math.atan2(d.z, d.x);
  const normalRot = (n: Vec2): number => Math.atan2(n.x, n.z);
  const plinthTop = foundation.plinthHeight;

  const push = (
    type: string,
    position: [number, number, number],
    rotation: number,
    scale: [number, number, number],
    materialId: string,
    params?: Record<string, number>,
  ): void => {
    parts.push({
      type,
      transform: { position, rotation, scale },
      materialId,
      params: { ...params, waterfront: WATERFRONT_FLAG },
    });
  };

  /** 張り出し領域の衝突(区画・道路・水路・広場・結界環・境界+
   *  全一般建物 footprint+採択済みの水辺領域) */
  const regionBlocked = (region: Polygon): boolean => {
    if (overhangBlocked(model, ctx, region, parcel.id)) return true;
    for (let i = 0; i < buildings.length; i++) {
      if (i === selfIndex) continue;
      const other = buildings[i];
      if (!other) continue;
      if (polygonsOverlap(region, other.footprint)) return true;
    }
    for (const claimed of claimedRegions) {
      // 同一建物のデッキと張り出し部屋は高さが違う(床 vs 最上階)ため
      // 平面の重なりを許す(排他は他建物の水辺領域とのみ)
      if (claimed.owner === selfIndex) continue;
      if (polygonsOverlap(region, claimed.region)) return true;
    }
    return false;
  };

  /** 外縁プローブ(外側2隅+外縁中点)の過半が水上か */
  const outerOverWater = (
    face: WaterfrontFace,
    ta: number,
    tb: number,
    depth: number,
  ): boolean => {
    let n = 0;
    for (const t of [ta, (ta + tb) / 2, tb]) {
      const lp = face.local(t, depth);
      const p = toWorld(lp.u, lp.v);
      if (ctx.waterBodySdf(p.x, p.z) < 0) n++;
    }
    return n >= 2;
  };

  // --- 杭繋ぎ梁(kind "piles" の杭列の各辺。乱数非消費) ---
  if (foundation.kind === "piles") {
    const uu0 = wing.u0 + PILE_EDGE_INSET;
    const uu1 = wing.u1 - PILE_EDGE_INSET;
    const vv0 = wing.v0 + PILE_EDGE_INSET;
    const vv1 = wing.v1 - PILE_EDGE_INSET;
    const corners: [number, number][] = [
      [uu0, vv0],
      [uu1, vv0],
      [uu1, vv1],
      [uu0, vv1],
    ];
    for (let k = 0; k < corners.length; k++) {
      const a = corners[k];
      const b = corners[(k + 1) % corners.length];
      if (!a || !b) continue;
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < 1.2) continue;
      const mid = toWorld((a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
      const dir = dirWorld(b[0] - a[0], b[1] - a[1]);
      push(
        "beam",
        [mid.x, PILE_TIE_Y, mid.z],
        tangentRot(dir),
        [len, PILE_TIE_H, PILE_TIE_D],
        "wood",
      );
    }
  }

  const face = extSide ? waterfrontFace(wing, extSide) : null;
  const faceA = face ? toWorld(face.local(face.t0, 0).u, face.local(face.t0, 0).v) : null;
  const faceB = face ? toWorld(face.local(face.t1, 0).u, face.local(face.t1, 0).v) : null;
  const outward = face ? dirWorld(face.out.du, face.out.dv) : null;
  const tangentWorld = face
    ? dirWorld(
        face.side === "back" ? 1 : 0,
        face.side === "back" ? 0 : 1,
      )
    : null;

  // --- 杭支持デッキ(overWater の水側の面) ---
  if (
    face &&
    faceA &&
    faceB &&
    outward &&
    tangentWorld &&
    foundation.overWater &&
    rng.chance(clamp(0.4 + 0.6 * derived.watersideRate, 0, 1))
  ) {
    const depth = rng.range(DECK_DEPTH_MIN, DECK_DEPTH_MAX);
    const ta = face.t0 + DECK_SIDE_INSET;
    const tb = face.t1 - DECK_SIDE_INSET;
    if (tb - ta >= 1.6) {
      const cLocal = [
        face.local(ta, 0),
        face.local(tb, 0),
        face.local(tb, depth),
        face.local(ta, depth),
      ].map((lp) => toWorld(lp.u, lp.v));
      const region = ensureClockwise(cLocal);
      if (outerOverWater(face, ta, tb, depth) && !regionBlocked(region)) {
        claimedRegions.push({ region, owner: selfIndex });
        const deckBottom = plinthTop - DECK_THICKNESS;
        const cMid = face.local((ta + tb) / 2, depth / 2);
        const cw = toWorld(cMid.u, cMid.v);
        const rotT = tangentRot(tangentWorld);
        // 床
        push(
          "deck",
          [cw.x, deckBottom, cw.z],
          rotT,
          [tb - ta, DECK_THICKNESS, depth],
          "wood",
        );
        // 杭(外縁の列+両脇の中間)
        const pileTargets: LocalPoint[] = [];
        const edgeLen = tb - ta - 0.5;
        const n = Math.max(2, Math.ceil(edgeLen / DECK_PILE_SPACING) + 1);
        for (let i = 0; i < n; i++) {
          const t = ta + 0.25 + (edgeLen * i) / (n - 1);
          pileTargets.push(face.local(t, depth - 0.22));
        }
        pileTargets.push(face.local(ta + 0.25, depth * 0.5));
        pileTargets.push(face.local(tb - 0.25, depth * 0.5));
        for (const lp of pileTargets) {
          const p = toWorld(lp.u, lp.v);
          push(
            "pile",
            [p.x, SHORE_SKIRT_BOTTOM_Y, p.z],
            rotT,
            [DECK_PILE_W, deckBottom - SHORE_SKIRT_BOTTOM_Y, DECK_PILE_W],
            "wood",
          );
        }
        // 欄干(外縁+両脇の 3 辺): 柱と手すり
        const rails: [LocalPoint, LocalPoint][] = [
          [face.local(ta + 0.08, depth - 0.1), face.local(tb - 0.08, depth - 0.1)],
          [face.local(ta + 0.08, 0.3), face.local(ta + 0.08, depth - 0.1)],
          [face.local(tb - 0.08, 0.3), face.local(tb - 0.08, depth - 0.1)],
        ];
        for (const [la, lb] of rails) {
          const a = toWorld(la.u, la.v);
          const b = toWorld(lb.u, lb.v);
          const len = Math.hypot(b.x - a.x, b.z - a.z);
          if (len < 0.8) continue;
          const posts = Math.max(2, Math.round(len / DECK_RAIL_SPACING) + 1);
          for (let i = 0; i < posts; i++) {
            const t = i / (posts - 1);
            push(
              "beam",
              [a.x + (b.x - a.x) * t, plinthTop, a.z + (b.z - a.z) * t],
              rotT,
              [DECK_RAIL_POST_W, DECK_RAIL_H, DECK_RAIL_POST_W],
              "wood",
            );
          }
          push(
            "beam",
            [
              (a.x + b.x) / 2,
              plinthTop + DECK_RAIL_H - DECK_RAIL_BAR,
              (a.z + b.z) / 2,
            ],
            -Math.atan2(b.z - a.z, b.x - a.x),
            [len + DECK_RAIL_POST_W, DECK_RAIL_BAR, DECK_RAIL_BAR],
            "wood",
          );
        }
        // デッキへの出入り口(壁面側)+重なる 1 階の窓の除去
        const doorT = clamp((ta + tb) / 2, face.t0 + 0.8, face.t1 - 0.8);
        const dLocal = face.local(doorT, 0);
        const dPos = toWorld(dLocal.u, dLocal.v);
        const doorW = 1.0;
        push(
          "door",
          [dPos.x, plinthTop, dPos.z],
          normalRot(outward),
          [doorW, 2.05, DOOR_DEPTH],
          "wood",
        );
        removeWindowsOnFace(
          parts,
          faceA,
          faceB,
          plinthTop,
          plinthTop + FLOOR_HEIGHT,
          doorT - face.t0,
          doorW / 2 + 0.25,
        );
      }
    }
  }

  // --- 張り出し部屋(overWater × 2階以上の最上階) ---
  if (
    face &&
    faceA &&
    faceB &&
    outward &&
    tangentWorld &&
    foundation.overWater &&
    floors >= 2 &&
    rng.chance(clamp(0.25 + 0.55 * derived.watersideRate, 0, 1))
  ) {
    const faceLen = face.t1 - face.t0;
    if (faceLen >= ROOM_MIN_FACE) {
      const roomW = clamp(faceLen * 0.55, ROOM_W_MIN, ROOM_W_MAX);
      const tc =
        (face.t0 + face.t1) / 2 +
        rng.range(-0.15, 0.15) * Math.max(0, faceLen - roomW);
      const ra = tc - roomW / 2;
      const rb = tc + roomW / 2;
      const region = ensureClockwise(
        [
          face.local(ra, 0),
          face.local(rb, 0),
          face.local(rb, ROOM_DEPTH + 0.3),
          face.local(ra, ROOM_DEPTH + 0.3),
        ].map((lp) => toWorld(lp.u, lp.v)),
      );
      if (outerOverWater(face, ra, rb, ROOM_DEPTH) && !regionBlocked(region)) {
        claimedRegions.push({ region, owner: selfIndex });
        const y0 = plinthTop + (floors - 1) * FLOOR_HEIGHT;
        const rotT = tangentRot(tangentWorld);
        const cLocal = face.local(tc, (ROOM_DEPTH - ROOM_EMBED) / 2);
        const cw = toWorld(cLocal.u, cLocal.v);
        // 壁体(最上階の階高。壁へ 0.25 食い込ませる)
        push(
          "wall",
          [cw.x, y0, cw.z],
          rotT,
          [roomW, FLOOR_HEIGHT, ROOM_DEPTH + ROOM_EMBED],
          materials.wall,
          { floor: floors - 1 },
        );
        // 小屋根(棟は面と平行。勾配は建物の roof.pitch と共有)
        const span = ROOM_DEPTH + ROOM_EMBED + 0.6;
        const roofH = Math.tan((site.roofPitch * Math.PI) / 180) * (span / 2);
        push(
          "gable",
          [cw.x, y0 + FLOOR_HEIGHT - ROOF_BASE_SINK, cw.z],
          rotT,
          [roomW + 0.6, roofH, span],
          materials.roof,
          { pitch: site.roofPitch },
        );
        // 外面の窓(1〜2)
        const winW = 1.0 + 0.2 * rng.next();
        const winH = 1.15 + 0.25 * rng.next();
        const winTs = roomW >= 3.6 ? [tc - roomW / 4, tc + roomW / 4] : [tc];
        for (const t of winTs) {
          const lp = face.local(t, ROOM_DEPTH);
          const p = toWorld(lp.u, lp.v);
          push(
            "window",
            [p.x, y0 + WINDOW_SILL, p.z],
            normalRot(outward),
            [winW, winH, WINDOW_DEPTH],
            materials.trim,
          );
        }
        // 床下の持ち送り梁(×3。x = 外向き)
        const rotOut = tangentRot(outward);
        for (const t of [ra + 0.45, tc, rb - 0.45]) {
          const lp = face.local(t, (ROOM_DEPTH - ROOM_EMBED) / 2);
          const p = toWorld(lp.u, lp.v);
          push(
            "beam",
            [p.x, y0 - 0.2, p.z],
            rotOut,
            [ROOM_DEPTH + ROOM_EMBED, 0.2, 0.16],
            "wood",
          );
        }
        // 部屋に重なる同じ面・最上階の窓を除去
        removeWindowsOnFace(
          parts,
          faceA,
          faceB,
          y0,
          y0 + FLOOR_HEIGHT,
          tc - face.t0,
          roomW / 2,
        );
      }
    }
  }

  // --- 水路裏口(canalside × overWater でない建物) ---
  if (!foundation.overWater && parcel.canalside) {
    let bestFace: WaterfrontFace | null = null;
    let bestDist = BACKDOOR_CANAL_DIST;
    for (const side of ["back", "right", "left"] as const) {
      const f = waterfrontFace(wing, side);
      const mid = f.local((f.t0 + f.t1) / 2, 0.8);
      const p = toWorld(mid.u, mid.v);
      const d = ctx.canalSdf(p.x, p.z);
      if (d < bestDist) {
        bestDist = d;
        bestFace = f;
      }
    }
    if (
      bestFace &&
      bestFace.t1 - bestFace.t0 >= 2.2 &&
      rng.chance(clamp(0.5 + 0.4 * derived.watersideRate, 0, 1))
    ) {
      const f = bestFace;
      const out = dirWorld(f.out.du, f.out.dv);
      const doorW = 0.95 + 0.15 * rng.next();
      const faceLen = f.t1 - f.t0;
      const tDoor = clamp(
        (f.t0 + f.t1) / 2 + rng.range(-1, 1) * 0.15 * faceLen,
        f.t0 + doorW / 2 + 0.45,
        f.t1 - doorW / 2 - 0.45,
      );
      const lp = f.local(tDoor, 0);
      const p = toWorld(lp.u, lp.v);
      push(
        "door",
        [p.x, plinthTop, p.z],
        normalRot(out),
        [doorW, 2.05, DOOR_DEPTH],
        "wood",
      );
      const a0 = f.local(f.t0, 0);
      const b0 = f.local(f.t1, 0);
      removeWindowsOnFace(
        parts,
        toWorld(a0.u, a0.v),
        toWorld(b0.u, b0.v),
        plinthTop,
        plinthTop + FLOOR_HEIGHT,
        tDoor - f.t0,
        doorW / 2 + 0.25,
      );
      if (plinthTop >= 0.32) {
        push(
          "stair",
          [p.x + out.x * 0.3, 0, p.z + out.z * 0.3],
          normalRot(out),
          [doorW + 0.4, plinthTop, 0.6],
          materials.wall === "ashlar" ? "ashlar" : "stone",
          { steps: 2 },
        );
      }
    }
  }
}

/**
 * 段12「建物」の1区画ぶんの生成に与える配置パラメータ(Phase C)。
 * 乱数は一切消費しない(セットバック・向き・矩形固定の変調のみ)。
 */
interface BuildLayoutOptions {
  frontSetback: number;
  /** 背面セットバックへの追加分(中庭型グループの全メンバー。契約
   *  「中庭型(courtyard)の性質」実装補足の後退量。グループの奥行き基準線
   *  (vBack)から呼び出し側が決定論的に逆算する) */
  backSetbackExtra: number;
  /** true の場合、L字・T字の抽選結果を破棄して矩形へ固定する(rng 消費は
   *  shapeVertices 呼び出しにより通常どおり行われ、結果だけを捨てる) */
  forceRectangle: boolean;
  /** null = 通常のランダム揺らぎ(tidiness 連動)をそのまま使う。数値を渡すと
   *  その値へ**置き換える**(揺らぎの抽選値は消費するが結果は捨てる。
   *  雁行(stagger)・中庭型の 90° 内向きスナップと同じ意味論) */
  overrideJitter: number | null;
  /** 回転の軸。"centroid" = footprint 重心(既存の揺らぎ・雁行と同じ)、
   *  "origin" = 接道正面セットバック線上の点(中庭型の 90° 内向きスナップ。
   *  重心回転だと bw≠bd の矩形が道路側へ食み出すため、正面帯上の点を軸に
   *  回して回転前の背面方向へ bw/2 だけ並進補正する) */
  rotatePivot: "centroid" | "origin";
  /** 非 null の場合、役割別のサイズ式(bw/bd)を無視してこの値を使う(中庭型の
   *  端建物の 90° 回転専用)。widthT/depthT の rng 消費は通常どおり行い、
   *  結果だけ破棄する("building/<id>" の消費順は不変)。forceRectangle との
   *  併用が前提 */
  sizeOverride: { bw: number; bd: number } | null;
}

const SINGLE_BUILD_OPTIONS: BuildLayoutOptions = {
  frontSetback: FRONT_SETBACK,
  backSetbackExtra: 0,
  forceRectangle: false,
  overrideJitter: null,
  rotatePivot: "centroid",
  sizeOverride: null,
};

/** 段12「建物」1棟ぶんの生成結果(骨格・素材・部品込みの Building と、
 *  水辺拡張(第2パス)・中庭型の後処理が必要とする中間情報) */
interface BuiltParcelResult {
  building: Building;
  role: BuildingRole;
  wing0: Wing | null;
  frame: WingFrame;
  waterExtSide: WaterfrontSide | null;
  foundation: Foundation;
  floors: number;
  roofPitch: number;
}

/**
 * 1 区画ぶんの建物骨格・素材・部品を生成する(段12「建物」commit 12〜14 の
 * 本体。従来の段12 本番ループの1反復と同一の計算を、`BuildLayoutOptions`
 * (セットバック・矩形固定・向きの変調)を入力として切り出したもの)。
 * `opts` は乱数を消費しない決定論的な変調のみのため、`"building/<id>"` 系の
 * 消費順・消費数は `opts` の値に依らず一定(同一 parcel・同一 opts の呼び出しは
 * 常に同一の結果を返す純関数)。中庭型の端建物の内向きスナップ候補生成・
 * 帯制約超過時のグループ全体フォールバック(単棟への再生成)は、この関数を
 * 異なる `opts` で複数回呼び出すことで実現する。
 */
function buildParcelBuilding(
  model: WorldModel,
  ctx: SiteContext,
  parcel: Parcel,
  opts: BuildLayoutOptions,
): BuiltParcelResult {
  const { seed, derived } = model.meta;
  const final = model.density.final;
  const id = `building/${parcel.id.slice("parcel/".length)}`;
  const rng = makeRng(seed, id);
  // 同型連続の抑制(Phase C。位置由来・乱数非消費。上記 layoutParity)
  const parity = layoutParity(parcel);

  // --- 幾何の下ごしらえ(接道フレーム) ---
  const geo = siteGeometry(parcel, opts.frontSetback, opts.backSetbackExtra);
  const tx = geo.tx;
  const tz = geo.tz;
  let backX = geo.backX;
  let backZ = geo.backZ;
  const origin = geo.origin;
  const usableW = geo.usableW;
  const usableD = geo.usableD;
  const center = geo.center;
  const density = final ? sampleFieldGrid(final, center.x, center.z) : 0;
  const urbanity = model.zoning
    ? sampleFieldGrid(model.zoning, center.x, center.z)
    : 0;

  // --- 役割 ---
  const role = decideRole(rng, model, parcel, center, density);

  // --- 寸法と形状 ---
  const widthT = rng.next();
  const depthT = rng.next();
  let bw = usableW * (0.82 + 0.18 * widthT);
  let bd = usableD * (0.72 + 0.23 * depthT);
  if (role === "warehouse") {
    bw = usableW * 0.9;
    bd = usableD * 0.9;
  } else if (role === "outskirt") {
    bw *= 0.65;
    bd *= 0.65;
  } else if (role === "waterside") {
    // 水辺建築は敷地の奥行きを使い切り、水面へ寄る
    bd = usableD * (0.88 + 0.07 * depthT);
  }
  bw = clamp(bw, 2.2, usableW);
  bd = clamp(bd, 2.2, usableD);
  if (opts.sizeOverride) {
    // 中庭型の端建物の 90° 回転専用サイズ(実装補足)。widthT/depthT の
    // rng 消費は上で済んでいるため、ここでは値だけ置き換える
    bw = opts.sizeOverride.bw;
    bd = opts.sizeOverride.bd;
  }
  // waterside は shapeVertices が矩形を返す(張り出しの合成を単純に保つ。契約)
  const shaped = shapeVertices(rng, role, bw, bd, parity);
  let localVerts = shaped.verts;
  let compound = shaped.compound;
  let wings = shaped.wings;
  if (opts.forceRectangle && compound) {
    // 中庭型は footprint を矩形に固定する(契約「中庭型(courtyard)の性質」)。
    // L/T 抽選の rng 消費は上の shapeVertices 呼び出しで通常どおり済んでいる
    // ため、ここでは結果だけ破棄する("building/<id>" の消費順は不変)
    const w2 = bw / 2;
    localVerts = [
      { u: -w2, v: 0 },
      { u: w2, v: 0 },
      { u: w2, v: bd },
      { u: -w2, v: bd },
    ];
    compound = false;
    wings = [{ u0: -w2, u1: w2, v0: 0, v1: bd }];
  }
  // 張り出し前の正面スパン(扉・石垣・外階段のアンカー。4b)
  const fw = wings[0];
  const frontSpan = fw ? { u0: fw.u0, u1: fw.u1 } : { u0: 0, u1: 0 };

  // ローカル → ワールド
  let verts: Vec2[] = localVerts.map((lp) => ({
    x: origin.x + tx * lp.u + backX * lp.v,
    z: origin.z + tz * lp.u + backZ * lp.v,
  }));

  // --- 向き: 広場 > 道路 > 水面 の優先 ---
  let facing = parcel.facing;
  const plaza = adjacentPlaza(model, parcel);
  if (plaza) {
    const toPlaza = Math.atan2(
      plaza.position.z - center.z,
      plaza.position.x - center.x,
    );
    let best = facing;
    let bestDot = -Infinity;
    for (let k = 0; k < 4; k++) {
      const a = parcel.facing + (k * Math.PI) / 2;
      const dot = Math.cos(a - toPlaza);
      if (dot > bestDot) {
        bestDot = dot;
        best = a;
      }
    }
    facing = best;
  }

  // --- 揺らぎ(tidiness 高で減。頂点変位 0.5 以下にクランプ)+
  //     Phase C の雁行・中庭型の向き変調(乱数非消費) ---
  let cx = 0;
  let cz = 0;
  for (const v of verts) {
    cx += v.x;
    cz += v.z;
  }
  cx /= verts.length;
  cz /= verts.length;
  let radius = 0;
  for (const v of verts) {
    radius = Math.max(radius, Math.hypot(v.x - cx, v.z - cz));
  }
  const shiftCap = MAX_JITTER_SHIFT / Math.max(radius, 1e-6);
  const jitterMax = Math.min((MAX_JITTER_DEG * Math.PI) / 180, shiftCap);
  // rng の消費順・消費数は opts に関わらず不変(契約の規約)。雁行・中庭型は
  // 既存の向き揺らぎ(±3°・tidiness 連動)に「加算せず置き換える」
  // (抽選値は消費するが捨てる)
  const randomJitter = rng.range(-1, 1) * (1 - derived.tidiness) * jitterMax;
  const jitter = opts.overrideJitter !== null ? opts.overrideJitter : randomJitter;
  const cosJ = Math.cos(jitter);
  const sinJ = Math.sin(jitter);
  // 中庭型の内向きスナップ(rotatePivot "origin")は footprint 重心ではなく
  // 前面セットバック線上の origin を軸に回す(重心まわりに回すと bw≠bd の
  // 矩形が道路側へ食み出すため。実装補足参照)
  const pivot = opts.rotatePivot === "origin" ? origin : { x: cx, z: cz };
  const rotate = (p: Vec2): Vec2 => ({
    x: pivot.x + (p.x - pivot.x) * cosJ - (p.z - pivot.z) * sinJ,
    z: pivot.z + (p.x - pivot.x) * sinJ + (p.z - pivot.z) * cosJ,
  });
  verts = verts.map(rotate);
  facing += jitter;
  // シフト前(=回転前)の背面方向。中庭型の内向きスナップの並進補正に使う
  const preRotateBackX = backX;
  const preRotateBackZ = backZ;
  const backRot = {
    x: backX * cosJ - backZ * sinJ,
    z: backX * sinJ + backZ * cosJ,
  };
  backX = backRot.x;
  backZ = backRot.z;
  // 揺らぎ回転後のローカルフレーム(部品展開の翼が footprint と同じ変換を共有する)
  const uDir = { x: tx * cosJ - tz * sinJ, z: tx * sinJ + tz * cosJ };
  let originRot = rotate(origin);
  if (opts.rotatePivot === "origin") {
    // 90° 回転で「間口方向(u=bw、origin を中心に対称)」が奥行き軸へ写ると、
    // 対称範囲 [-bw/2, bw/2] のまま道路側へ bw/2 食み出す。origin を中心に
    // [0, bw](内側へ全部)へ揃うよう、回転前の背面方向へ bw/2 だけ並進させる
    // (乱数非消費)
    const shiftX = preRotateBackX * (bw / 2);
    const shiftZ = preRotateBackZ * (bw / 2);
    verts = verts.map((v) => ({ x: v.x + shiftX, z: v.z + shiftZ }));
    originRot = { x: originRot.x + shiftX, z: originRot.z + shiftZ };
  }

  // --- 水上張り出し(waterside × 湖・池) ---
  // 背面・左右の3辺の中点から水面を探索し、最も近い水面へ向けて
  // その辺を延長する(正面=接道側は張り出さない)。
  let overWater = false;
  let waterExtSide: WaterfrontSide | null = null;
  if (role === "waterside" && verts.length === 4) {
    // 矩形の頂点順は [fl, fr, br, bl]
    const sides: { d: Vec2; a: number; b: number }[] = [
      { d: { x: backX, z: backZ }, a: 2, b: 3 }, // 背面(br, bl)
      { d: uDir, a: 1, b: 2 }, // 右側面(fr, br)
      { d: { x: -uDir.x, z: -uDir.z }, a: 3, b: 0 }, // 左側面(bl, fl)
    ];
    let best: { d: Vec2; a: number; b: number; gap: number } | null = null;
    for (const side of sides) {
      const va = verts[side.a];
      const vb = verts[side.b];
      if (!va || !vb) continue;
      // 辺の中点と両端(コーナーの斜め先の水面も拾う)から探索する
      const starts: Vec2[] = [
        { x: (va.x + vb.x) / 2, z: (va.z + vb.z) / 2 },
        va,
        vb,
      ];
      for (const s of starts) {
        for (let g = 0.5; g <= OVERHANG_SEARCH + 1e-9; g += 0.5) {
          if (ctx.waterBodySdf(s.x + side.d.x * g, s.z + side.d.z * g) < 0) {
            if (!best || g < best.gap) best = { ...side, gap: g };
            break;
          }
        }
      }
    }
    if (best) {
      const va = verts[best.a];
      const vb = verts[best.b];
      if (va && vb) {
        const ext = Math.min(best.gap + OVERHANG_INTO_WATER, OVERHANG_MAX);
        const region: Polygon = ensureClockwise([
          { x: va.x, z: va.z },
          { x: va.x + best.d.x * ext, z: va.z + best.d.z * ext },
          { x: vb.x + best.d.x * ext, z: vb.z + best.d.z * ext },
          { x: vb.x, z: vb.z },
        ]);
        if (!overhangBlocked(model, ctx, region, parcel.id)) {
          verts[best.a] = {
            x: va.x + best.d.x * ext,
            z: va.z + best.d.z * ext,
          };
          verts[best.b] = {
            x: vb.x + best.d.x * ext,
            z: vb.z + best.d.z * ext,
          };
          // 翼(部品展開)にも同じ張り出しを反映する(footprint と一致させる)
          const wing0 = wings[0];
          if (wing0) {
            if (best.a === 2) wing0.v1 += ext; // 背面
            else if (best.a === 1) wing0.u1 += ext; // 右側面
            else wing0.u0 -= ext; // 左側面
          }
          // 水辺拡張(commit 19)がデッキ・張り出し部屋を付ける面
          waterExtSide = best.a === 2 ? "back" : best.a === 1 ? "right" : "left";
        }
      }
    }
  }
  const footprint = ensureClockwise(verts);
  for (const v of footprint) {
    if (ctx.waterBodySdf(v.x, v.z) < 0) overWater = true;
  }

  // --- 階数(Settlement / Prosperity / 役割 / urbanity。サイズ勾配
  //     (Phase C。contracts/buildings.md「floors の改訂」)) ---
  const floorsBase =
    1.05 +
    derived.floorsBias +
    0.4 * derived.detailAmount +
    FLOORS_ROLE_ADJUST[role] +
    FLOORS_URBAN_GAIN *
      smoothstep(FLOORS_URBAN_EDGE0, FLOORS_URBAN_EDGE1, urbanity) +
    rng.range(-0.3, 0.5);
  const floorsMax = urbanity >= FLOORS_URBAN_4F_THRESHOLD ? 4 : 3;
  const floors = clamp(Math.round(floorsBase), 1, floorsMax);

  // --- 屋根(50〜58度。L/T は複合屋根。hip 抽選・pitch は同型抑制の
  //     序数変調込み) ---
  const hipRoleP =
    role === "hall"
      ? clamp(0.6 + ROOF_HIP_PARITY_WAVE * parity, 0, 1)
      : clamp(0.2 + ROOF_HIP_PARITY_WAVE * parity, 0, 1);
  let roofType: Building["roof"]["type"] = "gable";
  if (compound) roofType = "compound";
  else if (role === "hall" && rng.chance(hipRoleP)) roofType = "hip";
  else if (floors >= 2 && rng.chance(hipRoleP)) roofType = "hip";
  const pitch = clamp(
    ROOF_PITCH_MIN +
      (ROOF_PITCH_MAX - ROOF_PITCH_MIN) * rng.next() +
      ROOF_PITCH_PARITY_WAVE * parity,
    ROOF_PITCH_MIN,
    ROOF_PITCH_MAX,
  );

  // --- 接地(基壇・杭・石基礎。契約の機械判定表現) ---
  const plinthHeight = clamp(
    0.15 + 0.55 * derived.detailAmount + PLINTH_ROLE_ADJUST[role],
    0.1,
    1.0,
  );
  const foundation: Foundation = overWater
    ? {
        kind: derived.detailAmount > 0.55 ? "stonebase" : "piles",
        plinthHeight,
        overWater: true,
        bottomY: SHORE_SKIRT_BOTTOM_Y,
      }
    : { kind: "plinth", plinthHeight, overWater: false, bottomY: 0 };

  // --- 素材と部品展開(commit 13。乱数は派生サブストリーム
  //     "building/<id>/parts" のみ・建物あたり固定消費) ---
  const partsRng = makeRng(seed, `${id}/parts`);
  const materials = decideMaterials(
    partsRng,
    role,
    derived.wallTier,
    derived.roofTier,
    parity,
  );
  // 詳細部品(PHASE 4b commit 14)は派生サブストリーム
  // "building/<id>/details" のみ消費する(骨格・materials の消費は不変)
  const detailsRng = makeRng(seed, `${id}/details`);
  const frame: WingFrame = {
    origin: originRot,
    u: uDir,
    v: { x: backX, z: backZ },
  };
  // 扉の街路側判定(契約 (10))の基準。回転していても親区画の facing 自体は
  // 変わらないため、常に parcel.facing から直接導く
  const streetNormal: Vec2 = {
    x: Math.cos(parcel.facing),
    z: Math.sin(parcel.facing),
  };
  const parts = expandParts(
    wings,
    frame,
    foundation,
    floors,
    { type: roofType, pitch },
    materials,
    role,
    derived,
    detailsRng,
    frontSpan,
    streetNormal,
  );

  const building: Building = {
    id,
    parcelId: parcel.id,
    role,
    footprint,
    facing,
    floors,
    roof: { type: roofType, pitch },
    foundation,
    materials,
    parts,
  };

  return {
    building,
    role,
    wing0: wings[0] ?? null,
    frame,
    waterExtSide,
    foundation,
    floors,
    roofPitch: pitch,
  };
}

/** 塀セグメントの衝突判定領域(セグメント中心線 ± 厚み/2 の帯状矩形) */
function wallSegmentRegion(a: Vec2, b: Vec2, thickness: number): Polygon {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len = Math.hypot(dx, dz) || 1e-6;
  const nx = (-dz / len) * (thickness / 2);
  const nz = (dx / len) * (thickness / 2);
  return ensureClockwise([
    { x: a.x - nx, z: a.z - nz },
    { x: b.x - nx, z: b.z - nz },
    { x: b.x + nx, z: b.z + nz },
    { x: a.x + nx, z: a.z + nz },
  ]);
}

/**
 * 中庭壁セグメントの衝突検査(契約: 道路・水域・広場・区画。グループ自身の
 * 区画は除く。建物との重なりは契約に明記は無いが、絵の破綻を避ける安全側の
 * 追加検査として建物 footprint も見る)。乱数は消費しない。当たる区間
 * (=このセグメント全体)は呼び出し側が開口として省略する。
 */
function wallRegionBlocked(
  model: WorldModel,
  ctx: SiteContext,
  region: Polygon,
  ownParcelIds: Set<string>,
  buildings: readonly Building[],
): boolean {
  const probes: Vec2[] = [...region];
  for (let i = 0; i < region.length; i++) {
    const p = region[i];
    const q = region[(i + 1) % region.length];
    if (p && q) probes.push({ x: (p.x + q.x) / 2, z: (p.z + q.z) / 2 });
  }
  for (const p of probes) {
    if (ctx.boundaryInside(p.x, p.z) < 1) return true;
    if (ctx.canalSdf(p.x, p.z) < 0.3) return true;
    if (ctx.waterBodySdf(p.x, p.z) < 0.3) return true;
  }
  for (const parcel of model.parcels) {
    if (ownParcelIds.has(parcel.id)) continue;
    if (polygonsOverlap(region, parcel.polygon)) return true;
  }
  for (const edge of model.network.edges) {
    if (polylineTouchesPolygon(edge.path, region, edge.width / 2 + 0.3)) {
      return true;
    }
  }
  for (const plaza of model.plazas) {
    if (polygonsOverlap(region, plaza.polygon)) return true;
  }
  for (const b of buildings) {
    if (polygonsOverlap(region, b.footprint)) return true;
  }
  return false;
}

/**
 * 中庭型グループ(契約「中庭型(courtyard)の性質」)の後処理。乱数は消費しない
 * (決定論。`buildParcelBuilding` の再呼び出しはいずれも純関数)。
 *
 * 1. 端の建物(グループ先頭・末尾)を、他の建物・道路・広場と衝突しない
 *    範囲で 90° 内向きスナップの候補へ置き換える(waterside は回転対象外。
 *    水辺拡張の第2パスとの干渉を避けるため)。
 * 2. 塀(courtyard-wall)・courtyard Plaza の外形をグループの区画データと
 *    確定した中間メンバーの footprint から導出し、帯制約 (12) を満たすまで
 *    間口方向を段階的に縮める。
 * 3. 2 が最小寸法を下回る、または帯制約を満たせない場合は、グループ全体を
 *    単棟(single)へ再生成し、塀・Plaza は追加しない。
 */
function finalizeCourtyardGroups(
  model: WorldModel,
  ctx: SiteContext,
  buildings: Building[],
  layoutByParcelId: Map<string, ParcelLayout>,
): void {
  const groups = new Map<string, Parcel[]>();
  for (const parcel of model.parcels) {
    const layout = layoutByParcelId.get(parcel.id);
    if (layout?.pattern !== "courtyard") continue;
    let bucket = groups.get(parcel.groupId);
    if (!bucket) {
      bucket = [];
      groups.set(parcel.groupId, bucket);
    }
    bucket.push(parcel);
  }
  if (groups.size === 0) return;

  const buildingIdOf = (parcel: Parcel): string =>
    `building/${parcel.id.slice("parcel/".length)}`;
  const indexById = new Map<string, number>();
  for (let i = 0; i < buildings.length; i++) {
    const b = buildings[i];
    if (b) indexById.set(b.id, i);
  }

  for (const [groupId, unsorted] of groups) {
    const members = [...unsorted].sort(
      (a, b) => parcelSlot(a) - parcelSlot(b),
    );
    const n = members.length;
    // 契約の適格条件(長さ3〜5)は planGroupLayouts が保証するが、防御的に確認
    if (n < 3) continue;

    const fallbackToSingle = (): void => {
      for (const m of members) {
        const idx = indexById.get(buildingIdOf(m));
        if (idx === undefined) continue;
        const rebuilt = buildParcelBuilding(
          model,
          ctx,
          m,
          SINGLE_BUILD_OPTIONS,
        );
        buildings[idx] = rebuilt.building;
      }
    };

    // --- グループの基準フレーム(中央寄りのメンバーの接道方位。乱数非消費) ---
    const refMember = members[Math.floor((n - 1) / 2)];
    if (!refMember) continue;
    const [fa, fb] = refMember.frontEdge;
    const frontage = Math.hypot(fb.x - fa.x, fb.z - fa.z) || 1e-6;
    const tx = (fb.x - fa.x) / frontage;
    const tz = (fb.z - fa.z) / frontage;
    const backX = -Math.cos(refMember.facing);
    const backZ = -Math.sin(refMember.facing);
    const projOrigin = { x: (fa.x + fb.x) / 2, z: (fa.z + fb.z) / 2 };
    const projU = (p: Vec2): number =>
      (p.x - projOrigin.x) * tx + (p.z - projOrigin.z) * tz;
    const projV = (p: Vec2): number =>
      (p.x - projOrigin.x) * backX + (p.z - projOrigin.z) * backZ;
    const toWorld = (u: number, v: number): Vec2 => ({
      x: projOrigin.x + tx * u + backX * v,
      z: projOrigin.z + tz * u + backZ * v,
    });

    // --- 間口方向の範囲: 全メンバーの区画ポリゴン頂点の投影(タンジェントの
    //     符号(どちらが「内側」か)に依存しない。内側マージン
    //     COURTYARD_WALL_GAP。帯制約 (12) を構成的に満たすための基準) ---
    let uMin = Infinity;
    let uMax = -Infinity;
    for (const m of members) {
      for (const v of m.polygon) {
        uMin = Math.min(uMin, projU(v));
        uMax = Math.max(uMax, projU(v));
      }
    }
    uMin += COURTYARD_WALL_GAP;
    uMax -= COURTYARD_WALL_GAP;

    // --- 奥行きの後端(中庭の奥行き基準線)。区画データのみから導出する
    //     (本番ループの中間メンバー後退量の目標値算出と同じ式を共有する) ---
    const vBack = courtyardBackLine(members);

    // --- 奥行きの前端: 中間メンバー(街路向きのまま)の確定済み建物背面の
    //     投影の最大値。マージン COURTYARD_WALL_GAP だけ後方 ---
    let vFront = -Infinity;
    for (let i = 1; i <= n - 2; i++) {
      const m = members[i];
      if (!m) continue;
      const idx = indexById.get(buildingIdOf(m));
      const b = idx !== undefined ? buildings[idx] : undefined;
      if (!b) continue;
      for (const v of b.footprint) vFront = Math.max(vFront, projV(v));
    }
    if (!Number.isFinite(vFront)) {
      fallbackToSingle();
      continue;
    }
    vFront += COURTYARD_WALL_GAP;

    if (
      uMax - uMin < COURTYARD_MIN_WIDTH ||
      vBack - vFront < COURTYARD_MIN_DEPTH
    ) {
      fallbackToSingle();
      continue;
    }

    // --- 端の建物の 90° 内向きスナップ候補(waterside は回転対象外)。
    //     成功した側は、その建物が実際にグループ内側へ食い込む長さ
    //     (rowLength)を記録し、courtyard Plaza の内側マージンへ反映する
    //     (食い込みぶんだけ Plaza を後退させ、Plaza と回転済み建物の
    //     footprint が重ならないようにする) ---
    const endReach = { first: 0, last: 0 };
    const ends: { member: Parcel; isFirst: boolean }[] = [
      { member: members[0] as Parcel, isFirst: true },
      { member: members[n - 1] as Parcel, isFirst: false },
    ];
    for (const { member, isFirst } of ends) {
      const idx = indexById.get(buildingIdOf(member));
      if (idx === undefined) continue;
      const current = buildings[idx];
      if (!current || current.role === "waterside") continue;

      // グループ内側の方向(refMember の tx,tz を基準に、先頭は +、末尾は −)
      const target = {
        x: (isFirst ? 1 : -1) * tx,
        z: (isFirst ? 1 : -1) * tz,
      };
      const memberSite = siteGeometry(member, FRONT_SETBACK);
      // 回転後は bw が接道からの奥行きを担う(実装補足): 中庭の奥行き
      // 基準線まで届かせる
      const depthReach = clamp(
        vBack - FRONT_SETBACK,
        COURTYARD_END_DEPTH_MIN,
        memberSite.usableD,
      );
      // 回転後は bd がグループ内側への長さを担う: 隣接メンバーへの食い込みを
      // 抑えるため、自区画の可住間口の COURTYARD_END_LENGTH_FRACTION 倍に留める
      const rowLength = clamp(
        memberSite.usableW * COURTYARD_END_LENGTH_FRACTION,
        COURTYARD_END_LENGTH_MIN,
        COURTYARD_END_LENGTH_MAX,
      );

      // jitter = ±90° のどちらがグループ内側へ回るかを、回転後に
      // グループ内側への長さ軸となる方向(元の接線 tx,tz の回転先)と
      // target の内積で判定する(区画の frontEdge 端点の符号に依存しない)
      let bestJitter = Math.PI / 2;
      let bestDot = -Infinity;
      for (const sign of [1, -1]) {
        const jitter = sign * (Math.PI / 2);
        const cosJ = Math.cos(jitter);
        const sinJ = Math.sin(jitter);
        const rotatedTangent = {
          x: memberSite.tx * cosJ - memberSite.tz * sinJ,
          z: memberSite.tx * sinJ + memberSite.tz * cosJ,
        };
        const dot =
          rotatedTangent.x * target.x + rotatedTangent.z * target.z;
        if (dot > bestDot) {
          bestDot = dot;
          bestJitter = jitter;
        }
      }

      const candidateOpts: BuildLayoutOptions = {
        frontSetback: FRONT_SETBACK,
        backSetbackExtra: 0,
        forceRectangle: true,
        overrideJitter: bestJitter,
        rotatePivot: "origin",
        sizeOverride: { bw: depthReach, bd: rowLength },
      };
      const candidate = buildParcelBuilding(model, ctx, member, candidateOpts);
      if (candidate.role === "waterside") continue;

      let blocked = false;
      for (let j = 0; j < buildings.length && !blocked; j++) {
        if (j === idx) continue;
        const other = buildings[j];
        if (
          other &&
          polygonsOverlap(candidate.building.footprint, other.footprint)
        ) {
          blocked = true;
        }
      }
      for (const edge of model.network.edges) {
        if (blocked) break;
        if (
          polylineTouchesPolygon(
            edge.path,
            candidate.building.footprint,
            edge.width / 2,
          )
        ) {
          blocked = true;
        }
      }
      for (const p of model.plazas) {
        if (blocked) break;
        if (polygonsOverlap(candidate.building.footprint, p.polygon)) {
          blocked = true;
        }
      }
      if (!blocked) {
        buildings[idx] = candidate.building;
        // 実際に確定した footprint のグループ内側への到達点(projU の実測値)。
        // 回転の軸(origin)は端建物自身の frontEdge 中点であり、グループ全体の
        // 外周(uMin/uMax。全メンバー頂点の投影)からは離れているため、
        // rowLength だけからは食い込み量を正しく見積もれない(実測が必要)
        const reachU = candidate.building.footprint.map((v) => projU(v));
        if (isFirst) endReach.first = Math.max(...reachU) - uMin;
        else endReach.last = uMax - Math.min(...reachU);
      }
    }
    // courtyard Plaza の内側マージン(回転済み端建物のグループ内側への
    // 実測の食い込みぶん+隙間。回転しなかった側は通常の COURTYARD_WALL_INSET
    // のみ)
    const insetFirst = Math.max(
      COURTYARD_WALL_INSET,
      endReach.first + COURTYARD_WALL_GAP,
    );
    const insetLast = Math.max(
      COURTYARD_WALL_INSET,
      endReach.last + COURTYARD_WALL_GAP,
    );

    // --- 帯制約 (12): 塀・Plaza の全コーナーがグループのいずれかのメンバー
    //     区画から 1.2 以内かを検証し、満たさなければ間口方向を段階的に
    //     縮める(決定論。乱数は消費しない。Plaza のコーナーは回転済み端建物の
    //     食い込みぶん(insetFirst/insetLast)を反映した内側マージンで見る) ---
    let curUMin = uMin;
    let curUMax = uMax;
    const plazaVBack = vBack - COURTYARD_WALL_INSET;
    let bandOk = false;
    for (let step = 0; step <= COURTYARD_SHRINK_STEPS; step++) {
      const plazaUMinTry = curUMin + insetFirst;
      const plazaUMaxTry = curUMax - insetLast;
      if (
        curUMax - curUMin < COURTYARD_MIN_WIDTH ||
        plazaUMaxTry - plazaUMinTry < COURTYARD_MIN_WIDTH ||
        plazaVBack - vFront < COURTYARD_MIN_DEPTH
      ) {
        break;
      }
      const corners = [
        toWorld(curUMin, vFront),
        toWorld(curUMax, vFront),
        toWorld(curUMax, vBack),
        toWorld(curUMin, vBack),
        toWorld(plazaUMinTry, vFront),
        toWorld(plazaUMaxTry, vFront),
        toWorld(plazaUMaxTry, plazaVBack),
        toWorld(plazaUMinTry, plazaVBack),
      ];
      const withinBand = corners.every((c) =>
        members.some(
          (m) =>
            polygonSignedDistance(c.x, c.z, m.polygon) <=
            COURTYARD_PARCEL_BAND,
        ),
      );
      if (withinBand) {
        bandOk = true;
        break;
      }
      curUMin += COURTYARD_SHRINK_STEP_SIZE;
      curUMax -= COURTYARD_SHRINK_STEP_SIZE;
    }
    if (!bandOk) {
      fallbackToSingle();
      continue;
    }
    uMin = curUMin;
    uMax = curUMax;

    // --- courtyard Plaza の外形(塀からさらに内側マージン。回転済み端建物の
    //     食い込みぶんを反映)。建物と重なる場合はグループ全体を
    //     単棟へフォールバックする(寸法は上のループで検証済み) ---
    const plazaUMin = uMin + insetFirst;
    const plazaUMax = uMax - insetLast;
    const plazaPolygon = ensureClockwise([
      toWorld(plazaUMin, vFront),
      toWorld(plazaUMax, vFront),
      toWorld(plazaUMax, plazaVBack),
      toWorld(plazaUMin, plazaVBack),
    ]);
    let plazaBlocked = false;
    for (const b of buildings) {
      if (polygonsOverlap(plazaPolygon, b.footprint)) {
        plazaBlocked = true;
        break;
      }
    }
    if (plazaBlocked) {
      fallbackToSingle();
      continue;
    }

    const leaderIdx = indexById.get(buildingIdOf(members[0] as Parcel));
    const leader = leaderIdx !== undefined ? buildings[leaderIdx] : undefined;
    if (!leader) {
      fallbackToSingle();
      continue;
    }
    const wallMaterial = STONE_WALLS.has(leader.materials.wall)
      ? leader.materials.wall
      : "stone";
    const rotU = -Math.atan2(tz, tx);
    const rotV = -Math.atan2(backZ, backX);
    const ownParcelIds = new Set(members.map((m) => m.id));

    const pushWall = (a: Vec2, b: Vec2, rotation: number): void => {
      const region = wallSegmentRegion(a, b, COURTYARD_WALL_THICKNESS);
      if (wallRegionBlocked(model, ctx, region, ownParcelIds, buildings)) {
        return;
      }
      const mid = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
      const length = Math.hypot(b.x - a.x, b.z - a.z);
      if (length < 0.5) return;
      leader.parts.push({
        type: "courtyard-wall",
        transform: {
          position: [mid.x, 0, mid.z],
          rotation,
          scale: [
            length + COURTYARD_WALL_THICKNESS,
            COURTYARD_WALL_HEIGHT,
            COURTYARD_WALL_THICKNESS,
          ],
        },
        materialId: wallMaterial,
      });
    };

    // 開いた3辺(奥+両側)を塀で閉じる(当たる区間は開口として省略。契約)
    pushWall(toWorld(uMin, vBack), toWorld(uMax, vBack), rotU);
    pushWall(toWorld(uMin, vFront), toWorld(uMin, vBack), rotV);
    pushWall(toWorld(uMax, vFront), toWorld(uMax, vBack), rotV);

    // 囲まれた領域に kind:"courtyard" の Plaza を追加(契約: id は
    // "plaza/courtyard/<groupId>"。道路接続保証の対象外)
    const position = toWorld(
      (plazaUMin + plazaUMax) / 2,
      (vFront + plazaVBack) / 2,
    );
    const plaza: Plaza = {
      id: `plaza/courtyard/${groupId}`,
      kind: "courtyard",
      position,
      radius: Math.hypot(
        (plazaUMax - plazaUMin) / 2,
        (plazaVBack - vFront) / 2,
      ),
      polygon: plazaPolygon,
    };
    model.plazas.push(plaza);
  }
}

const DIRT_CHANNEL = ZONE_KINDS.indexOf("dirt");
const PAVED_CHANNEL = ZONE_KINDS.indexOf("paved");

/**
 * 建物 footprint による zoneMask の土/舗装上書き(契約: 段10 と同じ流儀の
 * ポリゴンスタンプ max 合成 → (1−p) 縮め。石造系の壁は paved、他は dirt。
 * dirt → paved の順で適用。乱数サブストリームは消費しない)。
 */
function stampBuildingsZone(model: WorldModel): void {
  const mask = model.ground.zoneMask;
  if (mask.resolution <= 0 || model.buildings.length === 0) return;
  const grid = maskCellGrid(mask);
  const blend = Math.max(BUILDING_ZONE_BLEND, mask.cellSize * BLEND_CELL_RATIO);
  const cells = mask.resolution * mask.resolution;
  const dirt = new Float64Array(cells);
  const paved = new Float64Array(cells);
  for (const b of model.buildings) {
    const target = STONE_WALLS.has(b.materials.wall) ? paved : dirt;
    stampPolygon(grid, target, b.footprint, blend);
  }
  applyCoverageToChannel(mask, dirt, DIRT_CHANNEL);
  applyCoverageToChannel(mask, paved, PAVED_CHANNEL);
}

/** パイプライン段の実体: buildings(骨格+素材+部品)を埋める */
export function runBuildings(model: WorldModel): void {
  const { seed, derived } = model.meta;
  const ctx = createSiteContext(model);
  const buildings: Building[] = [];
  // 水辺拡張(commit 19)の第2パス入力(建物 id → 展開文脈)
  const waterfrontSites = new Map<string, WaterfrontSite>();
  let violations = 0;
  // グループ計画(クラスタパターンの抽選。Phase C C4b)。段12 の本番ループの
  // 前に固定消費で決める(契約「抽選消費の先行(13)」)
  const groupLayouts = planGroupLayouts(model);

  // 中庭型グループの奥行き基準線(vBack)を区画データのみから先に求める
  // (乱数非消費。中間メンバーの後退セットバックの目標値算出に使う。
  // finalizeCourtyardGroups の外形算出と同じ式 courtyardBackLine を共有する)
  const courtyardVBack = new Map<string, number>();
  {
    const courtyardGroupMembers = new Map<string, Parcel[]>();
    for (const parcel of model.parcels) {
      const layout = groupLayouts.get(parcel.id);
      if (layout?.pattern !== "courtyard") continue;
      let bucket = courtyardGroupMembers.get(parcel.groupId);
      if (!bucket) {
        bucket = [];
        courtyardGroupMembers.set(parcel.groupId, bucket);
      }
      bucket.push(parcel);
    }
    for (const [groupId, members] of courtyardGroupMembers) {
      courtyardVBack.set(groupId, courtyardBackLine(members));
    }
  }

  for (const parcel of model.parcels) {
    const id = `building/${parcel.id.slice("parcel/".length)}`;

    // --- グループ計画(雁行・中庭型。C4b では rowhouse 当選も単棟同様に
    //     扱う。パリティはグループ内序数の偶奇=契約「序数パリティ」) ---
    const layout = groupLayouts.get(parcel.id);
    let opts: BuildLayoutOptions = SINGLE_BUILD_OPTIONS;
    if (layout?.pattern === "stagger") {
      const parityEven = layout.indexInGroup % 2 === 0;
      opts = {
        ...SINGLE_BUILD_OPTIONS,
        frontSetback: parityEven ? STAGGER_SETBACK_NEAR : STAGGER_SETBACK_FAR,
        // rng の消費順・消費数は雁行の有無に関わらず不変(契約の規約)。雁行
        // グループは既存の向き揺らぎ(±3°・tidiness 連動)に
        // 「加算せず置き換える」(抽選値は消費するが捨てる)—
        // 序数パリティ由来の決定論的な ±4°。加算だと最悪 7° になり扉の
        // 外向き判定の閾値 cos 6° を超えうるため(契約「雁行の性質」)
        overrideJitter:
          (parityEven ? 1 : -1) * ((STAGGER_YAW_DEG * Math.PI) / 180),
      };
    } else if (layout?.pattern === "courtyard") {
      // 中庭型グループの全メンバーは背面セットバックを後退させ、footprint を
      // 矩形へ固定する(契約「中庭型(courtyard)の性質」実装補足)。後退量は
      // 「この区画の役割別サイズ式(bd = usableD × 最大 0.95 相当)で建てても、
      // グループの奥行き基準線(vBack)の手前に中庭の最小奥行きぶんの
      // 余地が残る」ように、グループの vBack(区画データのみから決定論的に
      // 導出済み)から逆算する。役割はこの時点ではまだ決まっていないため、
      // サイズ式の上限(COURTYARD_DEPTH_FRACTION_MAX)で安全側に見積もる
      const naturalUsableD = siteGeometry(parcel, FRONT_SETBACK).usableD;
      const vBack = courtyardVBack.get(parcel.groupId) ?? 0;
      // courtyard Plaza の奥行きは vFront(中間メンバーの建物背面+GAP)から
      // plazaVBack(vBack − COURTYARD_WALL_INSET)までなので、両方の余白を
      // 差し引いて逆算する(finalizeCourtyardGroups の plazaVBack と同じ式)
      const targetUsableD = clamp(
        (vBack -
          COURTYARD_WALL_INSET -
          FRONT_SETBACK -
          COURTYARD_MIN_DEPTH -
          COURTYARD_WALL_GAP) /
          COURTYARD_DEPTH_FRACTION_MAX,
        2.2,
        naturalUsableD,
      );
      opts = {
        ...SINGLE_BUILD_OPTIONS,
        backSetbackExtra: naturalUsableD - targetUsableD,
        forceRectangle: true,
      };
    }

    const result = buildParcelBuilding(model, ctx, parcel, opts);
    buildings.push(result.building);

    // 水辺拡張(commit 19)の文脈を収集(展開は全一般建物の確定後の
    // 第2パス。デッキが後続建物の footprint と重ならないことを保証する)
    if (result.role === "waterside" && result.wing0) {
      waterfrontSites.set(id, {
        parcel,
        frame: result.frame,
        wing: result.wing0,
        extSide: result.waterExtSide,
        foundation: result.foundation,
        floors: result.floors,
        roofPitch: result.roofPitch,
        materials: result.building.materials,
        parts: result.building.parts,
      });
    }
  }

  // --- Phase C タスク C4c: 中庭型グループの端建物の内向きスナップ・塀
  //     (courtyard-wall)・courtyard Plaza の追記(契約「中庭型(courtyard)
  //     の性質」)。乱数は消費しない(決定論)。水辺拡張の第2パスより前に
  //     行う(courtyard 端建物が waterside の場合は回転を試みず waterfrontSites
  //     の内容もそのまま有効なため、フォールバックの入れ替えとは衝突しない) ---
  finalizeCourtyardGroups(model, ctx, buildings, groupLayouts);

  // --- 水辺建築の拡張(PHASE 6 commit 19。contracts/buildings.md
  //     「水辺建築の拡張」)。乱数は "building/<id>/waterfront" のみ消費 ---
  {
    const claimed: { region: Polygon; owner: number }[] = [];
    for (let i = 0; i < buildings.length; i++) {
      const b = buildings[i];
      if (!b || b.role !== "waterside") continue;
      const site = waterfrontSites.get(b.id);
      if (!site) continue;
      const wfRng = makeRng(seed, `${b.id}/waterfront`);
      expandWaterfrontParts(model, ctx, site, buildings, i, claimed, wfRng);
    }
  }

  // --- 中心建築(PHASE 5a commit 16。一般建物の後に展開する:
  //     スカイライン検証が周辺一般建物の最高点を入力とするため。
  //     契約は contracts/buildings.md「中心建築(PHASE 5a commit 16)」) ---
  const centerBuilding = expandCenterBuilding(model, ctx, buildings);
  buildings.push(centerBuilding);
  model.buildings = buildings;

  // --- 建物 footprint による zoneMask の土/舗装上書き(commit 13) ---
  stampBuildingsZone(model);

  // --- パイプライン内アサーション(throw せず件数を console に出す) ---
  const parcelById = new Map(model.parcels.map((p) => [p.id, p]));
  const edgeById = new Map(model.network.edges.map((e) => [e.id, e]));
  const boundsList = buildings.map((b) => polygonBounds(b.footprint));
  for (let i = 0; i < buildings.length; i++) {
    const b = buildings[i];
    if (!b) continue;

    // (1) 接道正面: 親区画の frontEdge が接道 edge の近傍にある
    //     (中心建築は親区画を持たないため対象外。契約の例外)
    const parcel = b.parcelId ? parcelById.get(b.parcelId) : undefined;
    const edge = parcel ? edgeById.get(parcel.roadEdgeId) : undefined;
    if (b.role === "center") {
      // 接道検査なし
    } else if (!parcel || !edge) {
      violations++;
    } else {
      const [a, c] = parcel.frontEdge;
      const mid = { x: (a.x + c.x) / 2, z: (a.z + c.z) / 2 };
      let minD = Infinity;
      for (let k = 0; k + 1 < edge.path.length; k++) {
        const p = edge.path[k];
        const q = edge.path[k + 1];
        if (!p || !q) continue;
        const dx = q.x - p.x;
        const dz = q.z - p.z;
        const lenSq = dx * dx + dz * dz;
        const t =
          lenSq > 0
            ? clamp(((mid.x - p.x) * dx + (mid.z - p.z) * dz) / lenSq, 0, 1)
            : 0;
        minD = Math.min(
          minD,
          Math.hypot(mid.x - (p.x + dx * t), mid.z - (p.z + dz * t)),
        );
      }
      if (minD > edge.width / 2 + 2.0) violations++;
    }

    // (2) 接地契約: overWater ⇔ 頂点の水上、杭・基礎の水面下到達
    let vertOverWater = false;
    for (const v of b.footprint) {
      if (ctx.waterBodySdf(v.x, v.z) < 0) vertOverWater = true;
      if (ctx.canalSdf(v.x, v.z) < 0) violations++; // 水路上は常に禁止
    }
    if (vertOverWater !== b.foundation.overWater) violations++;
    if (b.foundation.overWater) {
      if (b.foundation.kind === "plinth") violations++;
      if (b.foundation.bottomY > SHORE_SKIRT_BOTTOM_Y + 1e-9) violations++;
    }

    // (3) 建物どうし・道路・広場との重なりゼロ
    const bb = boundsList[i];
    if (!bb) continue;
    for (let j = i + 1; j < buildings.length; j++) {
      const other = buildings[j];
      const ob = boundsList[j];
      if (!other || !ob) continue;
      if (
        ob.minX > bb.maxX ||
        ob.maxX < bb.minX ||
        ob.minZ > bb.maxZ ||
        ob.maxZ < bb.minZ
      ) {
        continue;
      }
      if (polygonsOverlap(b.footprint, other.footprint)) violations++;
    }
    // 道路・広場との重なり(中心建築は対象外: 主道は中心へ収束して
    // footprint 下で終端する設計。契約の例外)
    if (b.role === "center") continue;
    for (const e of model.network.edges) {
      if (polylineTouchesPolygon(e.path, b.footprint, e.width / 2)) {
        violations++;
      }
    }
    for (const plaza of model.plazas) {
      if (polygonsOverlap(b.footprint, plaza.polygon)) violations++;
    }
  }

  // --- スカイライン契約(PHASE 5a): 中心最高点 ≥ 周辺最高点 × skylineRatio ---
  let peripheralTop = 0;
  for (const b of buildings) {
    if (b.role !== "center") peripheralTop = Math.max(peripheralTop, buildingTopY(b));
  }
  const centerTop = buildingTopY(centerBuilding);
  if (centerTop + 1e-6 < peripheralTop * derived.skylineRatio) {
    violations++;
    console.warn(
      `buildings: スカイライン契約違反 center=${centerTop.toFixed(2)} < ` +
        `${(peripheralTop * derived.skylineRatio).toFixed(2)}`,
    );
  }

  // --- 発光面積の上限(PHASE 5a): glowAreaCap × 箱庭面積 × 中心の取り分 ---
  let glowArea = 0;
  for (const p of centerBuilding.parts) glowArea += glowPartArea(p);
  const glowBudget =
    Math.abs(polygonArea(model.ground.boundary)) *
    derived.glowAreaCap *
    CENTER_GLOW_SHARE;
  if (glowArea > glowBudget + 1e-6) violations++;

  if (violations > 0) {
    console.warn(`buildings: パイプライン内アサーション違反 ${violations} 件`);
  }
}
