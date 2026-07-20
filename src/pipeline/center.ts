/**
 * 中心建築の拡張文法(建築群)。
 * 契約は docs/internal/contracts/buildings.md「中心建築」、
 * 設計は implementation-spec 1.7節(4軸スコア・モードなし連続分岐)、
 * 造形の規範は art-direction 6節「建築群(中心建築)の様式」。
 *
 * - 段12「建物」が一般建物の展開後に呼び、buildings の末尾へ 1 棟追加する
 *   (スカイライン検証が周辺一般建物の最高点を入力とするため)
 * - 中心建築は建築群(precinct): 囲い(壁・門)+中庭 1 つ以上+
 *   役割を持つ量塊(主館・クラウン・門楼・離れ)+縫合の複合体。
 *   展開は 2 層 — 第 1 層 planPrecinct(pipeline/precinct)が敷地計画を
 *   純データで決め、本ファイル(第 2 層)が部品へ展開する
 * - 4軸(centerPlan.axes)の最大軸が敷地計画の型を、2位軸が装飾傾向を
 *   決める: authority=城郭・宮殿 / arcane=聖域・修道院 /
 *   waterside=湖畔の荘園 / rustic=農場屋敷。
 *   2位軸 arcane → 紋様・発光開口を付加、authority → 薔薇窓・尖頭窓を付加
 * - スカイライン契約: 中心最高点 ≥ 周辺一般建物の最高点 × derived.skylineRatio。
 *   担い手はクラウン(屋根の層を持つ塔状の建物。天守・段塔・望楼)のみ。
 *   屋根層の積層で高さを消化する(素の角柱の引き伸ばしは契約で禁止)
 * - 発光(crystal / sigil / glow-window)は art-direction 5.4節の規律に従い、
 *   面積合計を glowAreaCap × 箱庭面積 × CENTER_GLOW_SHARE 以下に打ち切る。
 *   配置はクラウンの最上層・頂部(と聖域型の回廊欄間)へ集中させる
 * - 乱数は "building/center"(骨格)と "building/center/details"(窓の詳細)
 *   のみ消費する(消費数の固定は要求しない。契約「乱数」)
 * - 浮遊要素クラスタの立体化は contracts/wards.md「魔法灯・浮遊要素・橋の
 *   立体化」の担当(wards.floaters の計画は towers / gates / shrines を
 *   anchor とし、中心建築へは接続しない)
 */
import { makeRng } from "../rng";
import {
  FLOOR_HEIGHT,
  SHORE_SKIRT_BOTTOM_Y,
  type Building,
  type Derived,
  type Part,
  type Plaza,
  type Polygon,
  type Vec2,
  type WorldModel,
} from "../model/worldmodel";
import { polygonArea } from "../model/waterfield";
import { ensureClockwise } from "../model/geometry";
import type { SiteContext } from "./parcels";
import {
  planPrecinct,
  type OpenSide,
  type PrecinctMass,
  type PrecinctRect,
} from "./precinct";

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/** 4軸の順位付けの固定順(同点のタイブレーク。契約) */
const AXIS_ORDER = ["arcane", "authority", "waterside", "rustic"] as const;
export type CenterAxisKey = (typeof AXIS_ORDER)[number];

/** 発光面積の中心建築の取り分(残りは契約 wards.md「結界構造の立体化」の
 *  結界要素。0.65/0.35 の取り分は同節を参照) */
export const CENTER_GLOW_SHARE = 0.35;

/** 使用領域のマージン(footprint 内接正方形から引く。契約) */
const USABLE_MARGIN = 1.2;
/** 軒の張り出し(一般建物と同じ様式言語。art-direction 6節) */
const EAVE_OVERHANG = 0.65;
const GABLE_END_OVERHANG = 0.4;
const ROOF_BASE_SINK = 0.12;
/** 開口の枠の見付け(mesh/buildings.ts の FRAME_T と同値。発光面積の算定に使う) */
const FRAME_T = 0.13;
/** 発光開口の寸法(開口は 1 階高の 1/3 以下。art-direction 5.4節) */
const GLOW_WINDOW_W = 0.72;
const GLOW_WINDOW_H = 1.0;
const GLOW_WINDOW_DEPTH = 0.16;
/** 結界紋様の帯幅 */
const SIGIL_BAND = 0.16;
/** 開放辺の判定しきい値(側面の中点から水面までの距離) */
const OPEN_SIDE_WATER_DIST = 8;

/** axes の最大軸(骨格)と2位軸(装飾傾向)。implementation-spec 1.7節 */
export function rankCenterAxes(axes: {
  arcane: number;
  authority: number;
  waterside: number;
  rustic: number;
}): { dominant: CenterAxisKey; second: CenterAxisKey } {
  let dominant: CenterAxisKey = AXIS_ORDER[0];
  for (const key of AXIS_ORDER) {
    if (axes[key] > axes[dominant]) dominant = key;
  }
  let second: CenterAxisKey | null = null;
  for (const key of AXIS_ORDER) {
    if (key === dominant) continue;
    if (second === null || axes[key] > axes[second]) second = key;
  }
  return { dominant, second: second ?? dominant };
}

/** 建物の最高点(全部品の position.y + scale.y の最大。スカイライン契約の正) */
export function buildingTopY(b: Building): number {
  let top = 0;
  for (const p of b.parts) {
    top = Math.max(top, p.transform.position[1] + p.transform.scale[1]);
  }
  return top;
}

/**
 * 発光部品の発光面積(契約の正)。glow-window は枠を除いた開口面、
 * sigil は帯面、crystal は八面体の表面積の近似。
 */
export function glowPartArea(part: Part): number {
  const [sx, sy, sz] = part.transform.scale;
  switch (part.type) {
    case "glow-window":
      return Math.max(0, sx - 2 * FRAME_T) * Math.max(0, sy - 2 * FRAME_T);
    case "sigil":
      return sx * sy;
    case "crystal":
      return 1.8 * ((sx + sz) / 2) * sy;
    default:
      return 0;
  }
}

/** 支配軸 → 基準素材(契約の表) */
export function centerMaterials(
  dominant: CenterAxisKey,
  derived: Derived,
): Building["materials"] {
  let wall: string;
  let roof: string;
  switch (dominant) {
    case "arcane":
      wall = derived.wallTier >= 2.2 ? "ashlar" : "stone";
      roof = "slate";
      break;
    case "authority":
      wall = "ashlar";
      roof = "slate";
      break;
    case "waterside":
      wall = "stone";
      roof = "tile";
      break;
    default:
      wall = derived.wallTier >= 0.8 ? "plaster" : "rough-wood";
      roof = derived.roofTier >= 1.0 ? "shingle" : "thatch";
      break;
  }
  const trim = wall === "stone" || wall === "ashlar" ? "stone" : "wood";
  return { wall, roof, trim };
}

/** 展開結果(Building と、zoneMask 上書き対象 = 量塊の実体 footprint) */
export interface CenterExpansion {
  building: Building;
  /** main-hall / annex / gatehouse / crown の実体 footprint
   *  (契約「footprint」: zoneMask の上書きは量塊の実体のみ) */
  zoneRects: Polygon[];
}

/**
 * 段12「建物」から呼ばれる中心建築(建築群)の展開。
 * buildings へは呼び出し側が追加する。中庭の Plaza(kind "courtyard"、
 * id "plaza/courtyard/center/<連番>")はこの関数が model.plazas へ追記する。
 */
export function expandCenterBuilding(
  model: WorldModel,
  ctx: SiteContext,
  general: readonly Building[],
): CenterExpansion {
  const { seed, params, derived } = model.meta;
  const plan = model.centerPlan;
  // 骨格ストリーム(敷地計画と共有。消費数の固定は要求しない。契約)
  const rng = makeRng(seed, "building/center");
  const pitch = 50 + 8 * rng.next();
  const sideRoll = rng.next();
  const chimneyRoll = rng.next();
  // 窓の詳細ストリーム(面ごとの本数揺らぎ)
  const detailsRng = makeRng(seed, "building/center/details");

  const mon = params.monumentality / 100;
  const { dominant, second } = rankCenterAxes(plan.axes);
  // 2位軸の装飾はスコア ≥ 0.15 のときのみ(微小スコアの揺らぎで
  // 装飾が跳ばないようにする。契約)
  const SECOND_DECO_MIN = 0.15;
  const secondActive = plan.axes[second] >= SECOND_DECO_MIN;
  const arcaneDeco =
    dominant === "arcane" || (second === "arcane" && secondActive);
  const authorityDeco =
    dominant === "authority" || (second === "authority" && secondActive);
  const materials = centerMaterials(dominant, derived);
  const plinthMaterial = materials.wall === "ashlar" ? "ashlar" : "stone";
  const rustic = dominant === "rustic";

  // --- 使用領域(footprint に内接する facing 向きの正方形。契約) ---
  const side = derived.centerFootprint;
  const facing = plan.facing;
  const quarter = Math.PI / 2;
  const delta = ((facing % quarter) + quarter) % quarter;
  const k = 1 / (Math.abs(Math.cos(delta)) + Math.abs(Math.sin(delta)));
  const usable = Math.max(10, side * k - USABLE_MARGIN);
  const H = usable / 2;

  // ローカルフレーム: f = 正面(広場)方向。v は正面 → 背面、u は間口方向
  const f = { x: Math.cos(facing), z: Math.sin(facing) };
  const vDir = { x: -f.x, z: -f.z };
  const uDir = { x: -f.z, z: f.x };
  const toWorld = (u: number, v: number): Vec2 => ({
    x: plan.position.x + uDir.x * u + vDir.x * v,
    z: plan.position.z + uDir.z * u + vDir.z * v,
  });
  // 部品の rotation(ローカル +x → ワールド (cosθ, 0, −sinθ)。変換規約)
  const rotU = -Math.atan2(uDir.z, uDir.x);
  const rotV = -Math.atan2(vDir.z, vDir.x);
  // 開口(+z = 外向き法線)の rotation
  const normalRot = (n: Vec2): number => Math.atan2(n.x, n.z);
  const frontRot = normalRot(f);

  // --- 開放辺(waterside: 最も水面に近い側面/背面。契約 4軸表) ---
  let openSide: OpenSide = null;
  if (dominant === "waterside") {
    const probes: { side: Exclude<OpenSide, null>; u: number; v: number }[] = [
      { side: "back", u: 0, v: H },
      { side: "left", u: -H, v: 0 },
      { side: "right", u: H, v: 0 },
    ];
    let bestSdf = Infinity;
    for (const p of probes) {
      const w = toWorld(p.u * 1.2, p.v * 1.2);
      const sdf = ctx.waterBodySdf(w.x, w.z);
      if (sdf < bestSdf) {
        bestSdf = sdf;
        openSide = p.side;
      }
    }
    if (bestSdf > OPEN_SIDE_WATER_DIST) openSide = null;
  }

  // --- 敷地計画(第 1 層。契約「敷地計画(precinct plan)」) ---
  // 塔の幅決定用に、スカイライン目標の近似(主館の屋根頂を除く 2 項)を
  // 先に計算して渡す(周辺最高点は引数 general から確定できる)
  let peripheralTop = 0;
  for (const b of general) peripheralTop = Math.max(peripheralTop, buildingTopY(b));
  const towerTopHint = Math.max(
    plan.heightHint,
    peripheralTop * derived.skylineRatio * 1.03,
  );
  const precinct = planPrecinct({
    axis: dominant,
    monument: mon,
    usable,
    openSide,
    towerTopHint,
    rng,
  });

  // --- footprint(群の外郭 = 使用領域の矩形。契約) ---
  const footprint = ensureClockwise([
    toWorld(-H, -H),
    toWorld(H, -H),
    toWorld(H, H),
    toWorld(-H, H),
  ]);

  // --- 接地(群外郭が水面にかかる場合は接地契約に従う) ---
  const overWater = footprint.some((p) => ctx.waterBodySdf(p.x, p.z) < 0);
  const bottomY = overWater ? SHORE_SKIRT_BOTTOM_Y : 0;
  const plinthH = rustic ? 0.3 : clamp(0.5 + 0.6 * mon, 0.5, 1.1);

  // --- 発光面積の予算(契約: glowAreaCap × 箱庭面積 × 取り分) ---
  const groundArea = Math.abs(polygonArea(model.ground.boundary));
  const glowBudget = groundArea * derived.glowAreaCap * CENTER_GLOW_SHARE;
  let glowUsed = 0;

  const parts: Part[] = [];
  const push = (
    type: string,
    position: [number, number, number],
    rotation: number,
    scale: [number, number, number],
    materialId: string,
    extra?: Record<string, number>,
  ): Part => {
    const part: Part = { type, transform: { position, rotation, scale }, materialId };
    if (extra) part.params = extra;
    parts.push(part);
    return part;
  };
  /** 発光部品の追加(予算内のみ。水晶は force で必ず置き、面積は計上する) */
  const pushGlow = (
    type: string,
    position: [number, number, number],
    rotation: number,
    scale: [number, number, number],
    materialId: string,
    extra?: Record<string, number>,
    force = false,
  ): boolean => {
    const probe: Part = { type, transform: { position, rotation, scale }, materialId };
    const area = glowPartArea(probe);
    if (!force && glowUsed + area > glowBudget) return false;
    glowUsed += area;
    if (extra) probe.params = extra;
    parts.push(probe);
    return true;
  };

  const tanPitch = Math.tan((pitch * Math.PI) / 180);
  /** 矩形の中心 */
  const rectCenter = (r: PrecinctRect): { u: number; v: number } => ({
    u: (r.u0 + r.u1) / 2,
    v: (r.v0 + r.v1) / 2,
  });
  /** 矩形 → ワールド多角形 */
  const rectPolygon = (r: PrecinctRect): Polygon =>
    ensureClockwise([
      toWorld(r.u0, r.v0),
      toWorld(r.u1, r.v0),
      toWorld(r.u1, r.v1),
      toWorld(r.u0, r.v1),
    ]);

  // --- 窓の整列列(壁面ごと。乱数は details ストリームのみ) ---
  const winW = 1.15;
  const winH = clamp(1.35 + 0.5 * mon, 1.35, 1.8);
  const doorW = clamp(1.5 + 1.0 * mon, 1.5, 2.5);
  const emitWindowRow = (
    rect: PrecinctRect,
    floors: number,
    face: "front" | "back" | "left" | "right",
    skipDoor: boolean,
  ): void => {
    const du = rect.u1 - rect.u0;
    const dv = rect.v1 - rect.v0;
    const cu = (rect.u0 + rect.u1) / 2;
    const cv = (rect.v0 + rect.v1) / 2;
    const len = face === "front" || face === "back" ? du : dv;
    const usableLen = len - 1.9;
    const slots = Math.floor(usableLen / (winW + 1.9));
    if (slots <= 0) return;
    const roll = detailsRng.next();
    const fill = 0.45 + 0.45 * derived.detailAmount;
    const n = Math.min(slots, Math.max(0, Math.round(slots * fill + (roll - 0.5) * 0.8)));
    if (n <= 0) return;
    const at = (t: number): Vec2 => {
      switch (face) {
        case "front":
          return toWorld(cu + t, rect.v0);
        case "back":
          return toWorld(cu + t, rect.v1);
        case "left":
          return toWorld(rect.u0, cv + t);
        default:
          return toWorld(rect.u1, cv + t);
      }
    };
    const normal =
      face === "front"
        ? f
        : face === "back"
          ? vDir
          : face === "left"
            ? { x: -uDir.x, z: -uDir.z }
            : uDir;
    for (let floor = 0; floor < floors; floor++) {
      const y = plinthH + floor * FLOOR_HEIGHT + 0.95;
      for (let i = 0; i < n; i++) {
        const t = -usableLen / 2 + (i + 0.5) * (usableLen / n);
        if (skipDoor && floor === 0 && Math.abs(t) < doorW / 2 + winW / 2 + 0.4) {
          continue;
        }
        const p = at(t);
        push(
          "window",
          [p.x, y, p.z],
          normalRot(normal),
          [winW, winH, GLOW_WINDOW_DEPTH],
          materials.trim,
        );
      }
    }
  };

  // --- 量塊の躯体(基壇 → 壁 → 屋根)。屋根頂の y を返す ---
  const emitMassBody = (
    m: PrecinctMass,
    wallMaterial: string,
    roofMaterial: string,
  ): number => {
    const du = m.rect.u1 - m.rect.u0;
    const dv = m.rect.v1 - m.rect.v0;
    const c0 = rectCenter(m.rect);
    const c = toWorld(c0.u, c0.v);
    push(
      "plinth",
      [c.x, bottomY, c.z],
      rotU,
      [du + 0.3, plinthH - bottomY, dv + 0.3],
      plinthMaterial,
    );
    for (let i = 0; i < m.floors; i++) {
      push(
        "wall",
        [c.x, plinthH + i * FLOOR_HEIGHT, c.z],
        rotU,
        [du, FLOOR_HEIGHT, dv],
        wallMaterial,
        { floor: i },
      );
    }
    const length = (m.ridgeAlongU ? du : dv) + 2 * GABLE_END_OVERHANG;
    const span = (m.ridgeAlongU ? dv : du) + 2 * EAVE_OVERHANG;
    const rh = tanPitch * (span / 2);
    const baseY = plinthH + m.floors * FLOOR_HEIGHT - ROOF_BASE_SINK;
    push(
      m.roofType,
      [c.x, baseY, c.z],
      m.ridgeAlongU ? rotU : rotV,
      [length, rh, span],
      roofMaterial,
      { pitch },
    );
    return baseY + rh;
  };

  // --- 主館(main-hall): 躯体+正面の大扉・前庭階段・装飾・窓 ---
  const hallMass = precinct.masses.find((m) => m.role === "main-hall");
  if (!hallMass) throw new Error("center: 敷地計画に main-hall がない");
  const hallRect = hallMass.rect;
  const hallFloors = hallMass.floors;
  const hallW = hallRect.u1 - hallRect.u0;
  const hw = hallW / 2;
  const hallRoofTop = emitMassBody(hallMass, materials.wall, materials.roof);

  // 正面の大扉+前庭階段(契約「量塊の造形」)
  const doorH = Math.min(2.7, FLOOR_HEIGHT - 0.3);
  const doorPos = toWorld(0, hallRect.v0);
  push("door", [doorPos.x, plinthH, doorPos.z], frontRot, [doorW, doorH, 0.2], "wood");
  const steps = clamp(Math.ceil(plinthH / 0.18), 2, 8);
  const stairDepth = steps * 0.34;
  push(
    "stair",
    [doorPos.x + f.x * (stairDepth / 2), 0, doorPos.z + f.z * (stairDepth / 2)],
    frontRot,
    [doorW + 2.6 + 4 * mon, plinthH, stairDepth],
    plinthMaterial,
    { steps },
  );

  // 大型開口(権威装飾: 薔薇窓+整列した尖頭窓)
  const frontFaceAt = (u: number): Vec2 => toWorld(u, hallRect.v0);
  const archW = 0.95;
  const archH = 2.3;
  if (authorityDeco) {
    const off0 = doorW / 2 + 1.3;
    for (let i = 0; ; i++) {
      const off = off0 + i * 2.3;
      if (off + archW / 2 > hw - 1.0) break;
      for (const s of [-1, 1]) {
        const p = frontFaceAt(s * off);
        push(
          "arch-window",
          [p.x, plinthH + 0.7, p.z],
          frontRot,
          [archW, archH, 0.18],
          materials.trim,
        );
      }
    }
    if (hallFloors >= 2) {
      const d = Math.min(2.2, hallW * 0.3);
      const y = plinthH + (hallFloors - 1) * FLOOR_HEIGHT + (FLOOR_HEIGHT - d) / 2;
      const p = frontFaceAt(0);
      push("rose-window", [p.x, y, p.z], frontRot, [d, d, 0.18], materials.trim);
    }
  }
  // 魔導装飾: 正面の最上階に発光開口(塔の光を正面にも通わせる)
  if (arcaneDeco && hallFloors >= 2) {
    for (const s of [-1, 1]) {
      const p = frontFaceAt(s * (doorW / 2 + 1.7));
      pushGlow(
        "glow-window",
        [p.x, plinthH + (hallFloors - 1) * FLOOR_HEIGHT + 0.95, p.z],
        frontRot,
        [GLOW_WINDOW_W, GLOW_WINDOW_H, GLOW_WINDOW_DEPTH],
        materials.trim,
      );
    }
  }
  // 主館の窓(正面は装飾と扉を避ける)
  if (!authorityDeco) emitWindowRow(hallRect, hallFloors, "front", true);
  emitWindowRow(hallRect, hallFloors, "left", false);
  emitWindowRow(hallRect, hallFloors, "right", false);
  emitWindowRow(hallRect, hallFloors, "back", false);

  // 煙突(素朴・水辺の主館。実寸比 15% 過大は一般建物と同じ規範)
  if ((rustic || dominant === "waterside") && chimneyRoll < 0.85) {
    const cw = 0.72 * 1.15;
    const along = (sideRoll < 0.5 ? -1 : 1) * Math.max(0, hw - 1.6);
    const pos = toWorld(along, (hallRect.v0 + hallRect.v1) / 2);
    const baseY = plinthH + hallFloors * FLOOR_HEIGHT - 0.3;
    const topY = hallRoofTop + 0.9;
    push("chimney", [pos.x, baseY, pos.z], rotU, [cw, topY - baseY, cw], plinthMaterial);
  }

  // --- 離れ(annex): 一般建物スケールの躯体+窓(中庭側の面) ---
  const annexWall = rustic ? "rough-wood" : materials.wall;
  const annexRoof = rustic ? materials.roof : materials.roof;
  for (const m of precinct.masses) {
    if (m.role !== "annex") continue;
    emitMassBody(m, annexWall, annexRoof);
    // 中庭側(内側)の面に窓と扉
    const innerFace = (m.rect.u0 + m.rect.u1) / 2 < 0 ? "right" : "left";
    emitWindowRow(m.rect, m.floors, innerFace, false);
    const c = rectCenter(m.rect);
    const doorU = innerFace === "right" ? m.rect.u1 : m.rect.u0;
    const dp = toWorld(doorU, c.v);
    const n = innerFace === "right" ? uDir : { x: -uDir.x, z: -uDir.z };
    push("door", [dp.x, plinthH, dp.z], normalRot(n), [1.3, 2.2, 0.18], "wood");
  }

  // --- 船小屋の水上張り出し(deck + pile。「水辺建築の拡張」の部品流儀。
  //     契約 4軸表: overWater は群外郭の接地契約のままで量塊単位には持たない) ---
  if (precinct.boathouse) {
    const bh = precinct.boathouse;
    const bw = bh.u1 - bh.u0;
    const cu = (bh.u0 + bh.u1) / 2;
    const deckD = 1.2; // 群外郭からの張り出し許容(契約 1.2)内
    const deckMid = toWorld(cu, H + deckD / 2);
    // 床板(床の天端 0.35 = 桟橋・デッキと同じ読み)
    push(
      "deck",
      [deckMid.x, 0.13, deckMid.z],
      rotU,
      [bw * 0.9, 0.22, deckD],
      "rough-wood",
      { waterfront: 1 },
    );
    for (const su of [-1, 1]) {
      const pp = toWorld(cu + su * (bw * 0.45 - 0.2), H + deckD - 0.25);
      push(
        "pile",
        [pp.x, SHORE_SKIRT_BOTTOM_Y, pp.z],
        rotU,
        [0.28, 0.13 - SHORE_SKIRT_BOTTOM_Y, 0.28],
        "wood",
        { waterfront: 1 },
      );
    }
  }

  // --- スカイライン契約: クラウンのみが目標高へ届く(契約) ---
  const targetTop = Math.max(towerTopHint, hallRoofTop + 4);

  // --- クラウン(屋根の層を持つ塔状の建物。天守方式。契約「量塊の造形」) ---
  const crownBodyMaterial = rustic ? "rough-wood" : materials.wall;
  /** クラウンの軒の張り出し(層の屋根スカート。主館の軒より浅め) */
  const CROWN_EAVE = 0.55;
  const emitCrown = (): number => {
    const { u, v, width } = precinct.crown;
    const p = toWorld(u, v);
    push(
      "plinth",
      [p.x, bottomY, p.z],
      rotU,
      [width + 0.6, plinthH - bottomY, width + 0.6],
      plinthMaterial,
    );
    // 層の数(契約 4軸表)と各層の幅(上へ逓減)
    const nTiers =
      dominant === "authority" || dominant === "arcane"
        ? mon > 0.55
          ? 4
          : 3
        : dominant === "waterside"
          ? 2
          : targetTop - plinthH > 13
            ? 2
            : 1;
    const tierW: number[] = [];
    for (let i = 0; i < nTiers; i++) tierW.push(width * (1 - 0.17 * i));
    // 層間スカート露出高: 下層の屋根面が次層の壁面に切られる高さ
    const skirt: number[] = [];
    for (let i = 0; i < nTiers - 1; i++) {
      const halfSpan = (tierW[i]! + 2 * CROWN_EAVE) / 2;
      skirt.push(tanPitch * (halfSpan - tierW[i + 1]! / 2));
    }
    // 最上層の屋根(正方形 hip = 方形)の立ち上がり
    const topRise = tanPitch * ((tierW[nTiers - 1]! + 2 * CROWN_EAVE) / 2);
    // 頂部飾り(topper)の高さ
    const watchW = Math.max(1.5, tierW[nTiers - 1]! * 0.36);
    const crystalW = Math.min(1.0, tierW[nTiers - 1]! * 0.3);
    const crystalH = clamp(tierW[nTiers - 1]! * 0.5, 1.1, 2.2);
    const topperH =
      dominant === "arcane"
        ? crystalH * 0.7
        : dominant === "authority"
          ? 1.7 + watchW * 1.2 - 0.8
          : tierW[nTiers - 1]! * 0.45;
    // 壁高の配分: 合計 = 目標高 − 基壇 − スカート − 最上屋根 − 頂部飾り
    const sumSkirt = skirt.reduce((a, b) => a + b, 0);
    const wallBudget =
      targetTop - plinthH - sumSkirt - topRise - topperH +
      ROOF_BASE_SINK * nTiers;
    const weights: number[] = [];
    for (let i = 0; i < nTiers; i++) weights.push(i === 0 ? 1.5 : 1.0);
    const wSum = weights.reduce((a, b) => a + b, 0);
    const tierH: number[] = weights.map((w) =>
      Math.max(2.3, (wallBudget * w) / wSum),
    );

    // 層の展開(壁ブロックは tower 部品の緩い batter で締める)
    let y = plinthH;
    const tierBaseY: number[] = [];
    for (let i = 0; i < nTiers; i++) {
      tierBaseY.push(y);
      push(
        "tower",
        [p.x, y, p.z],
        rotU,
        [tierW[i]!, tierH[i]!, tierW[i]!],
        crownBodyMaterial,
        { taper: 0.97 },
      );
      const roofSpan = tierW[i]! + 2 * CROWN_EAVE;
      const rise = tanPitch * (roofSpan / 2);
      push(
        "hip",
        [p.x, y + tierH[i]! - ROOF_BASE_SINK, p.z],
        rotU,
        [roofSpan, rise, roofSpan],
        materials.roof,
        { pitch },
      );
      if (i < nTiers - 1) {
        y += tierH[i]! - ROOF_BASE_SINK + skirt[i]!;
      } else {
        y += tierH[i]! - ROOF_BASE_SINK + topRise;
      }
    }
    let actualTop = y;

    // 最上層の開口(4 面。魔導 = 発光開口、城郭 = 尖頭窓、他 = 窓)
    const topTierY = tierBaseY[nTiers - 1]!;
    const topW = tierW[nTiers - 1]!;
    const faces: { du: number; dv: number; n: Vec2 }[] = [
      { du: 0, dv: -1, n: f },
      { du: 0, dv: 1, n: vDir },
      { du: -1, dv: 0, n: { x: -uDir.x, z: -uDir.z } },
      { du: 1, dv: 0, n: uDir },
    ];
    for (const face of faces) {
      const bp = toWorld(u + face.du * (topW / 2), v + face.dv * (topW / 2));
      const oy = topTierY + Math.max(0.5, (tierH[nTiers - 1]! - 1.5) * 0.4);
      if (dominant === "arcane") {
        pushGlow(
          "glow-window",
          [bp.x, oy, bp.z],
          normalRot(face.n),
          [GLOW_WINDOW_W, GLOW_WINDOW_H, GLOW_WINDOW_DEPTH],
          materials.trim,
        );
      } else if (dominant === "authority") {
        push(
          "arch-window",
          [bp.x, oy, bp.z],
          normalRot(face.n),
          [0.9, 1.7, 0.18],
          materials.trim,
        );
      } else {
        push(
          "window",
          [bp.x, oy, bp.z],
          normalRot(face.n),
          [0.95, 1.35, GLOW_WINDOW_DEPTH],
          materials.trim,
        );
      }
    }
    // 下層の正面窓(層ごとに 1〜2)
    for (let i = 0; i < nTiers - 1; i++) {
      const wy = tierBaseY[i]! + Math.max(0.6, tierH[i]! * 0.35);
      const nWin = tierW[i]! > 7 ? 2 : 1;
      for (let k = 0; k < nWin; k++) {
        const off = nWin === 1 ? 0 : (k === 0 ? -1 : 1) * tierW[i]! * 0.22;
        const fp = toWorld(u + off, v - tierW[i]! / 2);
        push(
          "window",
          [fp.x, wy, fp.z],
          frontRot,
          [winW * 0.9, winH * 0.9, GLOW_WINDOW_DEPTH],
          materials.trim,
        );
      }
    }

    // 頂部飾り(軸別)
    if (dominant === "arcane") {
      // 方形屋根の頂に水晶灯(ソケット+水晶。契約 4軸表)
      push(
        "tower",
        [p.x, actualTop - 0.35, p.z],
        rotU,
        [crystalW * 1.4, 0.5, crystalW * 1.4],
        plinthMaterial,
        { taper: 0.6 },
      );
      pushGlow(
        "crystal",
        [p.x, actualTop + 0.05, p.z],
        rotU + Math.PI / 4,
        [crystalW, crystalH, crystalW],
        "glow",
        undefined,
        true,
      );
      actualTop += 0.05 + crystalH;
    } else if (dominant === "authority") {
      // 小さな物見+尖塔(契約 4軸表)
      const wy = actualTop - 0.5;
      push(
        "tower",
        [p.x, wy, p.z],
        rotU,
        [watchW, 1.7, watchW],
        crownBodyMaterial,
        { taper: 0.94 },
      );
      push(
        "spire",
        [p.x, wy + 1.65, p.z],
        rotU,
        [watchW * 1.25, watchW * 1.2, watchW * 1.25],
        materials.roof,
      );
      actualTop = wy + 1.65 + watchW * 1.2;
      if (arcaneDeco) {
        pushGlow(
          "crystal",
          [p.x, actualTop - 0.3, p.z],
          rotU + Math.PI / 4,
          [0.55, 0.9, 0.55],
          "glow",
          undefined,
          true,
        );
        actualTop += 0.6;
      }
    } else {
      // 望楼・物見: 方形屋根の頂に細い尖塔
      const sw = Math.max(0.9, topW * 0.22);
      push(
        "spire",
        [p.x, actualTop - 0.4, p.z],
        rotU,
        [sw, topW * 0.5, sw],
        materials.roof,
      );
      actualTop += -0.4 + topW * 0.5;
      if (arcaneDeco) {
        pushGlow(
          "crystal",
          [p.x, actualTop - 0.25, p.z],
          rotU + Math.PI / 4,
          [0.5, 0.85, 0.5],
          "glow",
          undefined,
          true,
        );
        actualTop += 0.6;
      }
    }

    // 結界紋様(魔導: 層の壁面の帯+正面の菱形紋。契約 4軸表・予算内のみ)
    if (arcaneDeco) {
      const ringTiers = nTiers >= 3 ? [1, nTiers - 1] : [nTiers - 1];
      outer: for (const ti of ringTiers) {
        const ry = tierBaseY[ti]! + tierH[ti]! * 0.72;
        const half = tierW[ti]! / 2;
        const len = tierW[ti]! * 0.8;
        for (const face of faces) {
          const pos = toWorld(
            u + face.du * (half + 0.04),
            v + face.dv * (half + 0.04),
          );
          if (
            !pushGlow(
              "sigil",
              [pos.x, ry, pos.z],
              face.du === 0 ? rotU : rotV,
              [len, SIGIL_BAND, 1],
              "glow",
            )
          ) {
            break outer;
          }
        }
      }
      // 菱形紋(最下層の正面)
      const dy = tierBaseY[0]! + tierH[0]! * 0.55;
      const r = 0.8;
      const halfD = tierW[0]! / 2 + 0.05;
      const edges: { ou: number; oy: number; tilt: number }[] = [
        { ou: r / 2, oy: r / 2, tilt: -Math.PI / 4 },
        { ou: r / 2, oy: -r / 2, tilt: Math.PI / 4 },
        { ou: -r / 2, oy: -r / 2, tilt: -Math.PI / 4 },
        { ou: -r / 2, oy: r / 2, tilt: Math.PI / 4 },
      ];
      const dlen = r * Math.SQRT2;
      for (const e of edges) {
        const pos = toWorld(u + e.ou, v - halfD);
        if (
          !pushGlow(
            "sigil",
            [pos.x, dy + e.oy - SIGIL_BAND / 2, pos.z],
            rotU,
            [dlen, SIGIL_BAND * 0.8, 1],
            "glow",
            { tilt: e.tilt },
          )
        ) {
          break;
        }
      }
    }
    return actualTop;
  };
  const crownTop = emitCrown();

  // --- 囲い(壁セグメント+門+胸壁)。契約 4軸表 ---
  const enclosureKind = precinct.enclosure.kind;
  const wallH =
    enclosureKind === "wall"
      ? clamp(2.8 + 1.4 * mon, 2.8, 4.2)
      : enclosureKind === "low-wall"
        ? 2.0
        : 1.15;
  const wallT = enclosureKind === "wall" ? 0.62 : enclosureKind === "low-wall" ? 0.5 : 0.16;
  const wallMaterialId = enclosureKind === "fence" ? "rough-wood" : plinthMaterial;
  for (const seg of precinct.enclosure.segments) {
    const du = seg.b.u - seg.a.u;
    const dv = seg.b.v - seg.a.v;
    const len = Math.hypot(du, dv);
    if (len < 0.6) continue;
    const mid = toWorld((seg.a.u + seg.b.u) / 2, (seg.a.v + seg.b.v) / 2);
    const horizontal = Math.abs(du) >= Math.abs(dv);
    const rot = horizontal ? rotU : rotV;
    if (enclosureKind === "fence") {
      push("fence", [mid.x, 0, mid.z], rot, [len, wallH, wallT], wallMaterialId);
    } else {
      push(
        "courtyard-wall",
        [mid.x, 0, mid.z],
        rot,
        [len, wallH, wallT],
        wallMaterialId,
      );
      // 胸壁(城郭型の囲いの天端。契約「Phase E の追加語彙」)
      if (enclosureKind === "wall") {
        push(
          "battlement",
          [mid.x, wallH, mid.z],
          rot,
          [len, 0.55, wallT * 0.8],
          wallMaterialId,
        );
        // バットレス(外面に等間隔。契約「囲い」のリズム要素)
        const nBut = Math.floor(len / 4.5);
        for (let bi = 1; bi <= nBut; bi++) {
          const t = -len / 2 + (bi * len) / (nBut + 1);
          // セグメント方向の単位ベクトル(ローカル)と外向き法線
          const ux = horizontal ? 1 : 0;
          const uv = horizontal ? 0 : 1;
          const bu = (seg.a.u + seg.b.u) / 2 + ux * t;
          const bv = (seg.a.v + seg.b.v) / 2 + uv * t;
          const outU = horizontal ? 0 : Math.sign(seg.a.u);
          const outV = horizontal ? Math.sign(seg.a.v) : 0;
          const bp = toWorld(
            bu + outU * (wallT / 2 + 0.22),
            bv + outV * (wallT / 2 + 0.22),
          );
          push(
            "plinth",
            [bp.x, 0, bp.z],
            rot,
            [0.6, wallH * 0.72, 0.55],
            wallMaterialId,
          );
        }
      }
    }
  }
  // 門柱(門楼の無い門の両脇)
  const hasGatehouse = precinct.masses.some((m) => m.role === "gatehouse");
  for (const gate of precinct.gates) {
    if (gate.main && hasGatehouse) continue;
    if (enclosureKind === "fence" && !gate.main) continue;
    const horizontal = Math.abs(gate.v) > Math.abs(gate.u);
    for (const s of [-1, 1]) {
      const pu = horizontal ? gate.u + s * (gate.width / 2 + 0.3) : gate.u;
      const pv = horizontal ? gate.v : gate.v + s * (gate.width / 2 + 0.3);
      const pp = toWorld(pu, pv);
      push(
        "courtyard-wall",
        [pp.x, 0, pp.z],
        horizontal ? rotU : rotV,
        [0.6, wallH + 0.5, 0.6],
        wallMaterialId,
      );
    }
  }

  // --- 内郭の横断壁(城郭型の 2 段構え。契約「囲い」のリズム要素) ---
  if (precinct.innerWall) {
    const iw = precinct.innerWall;
    const gw = iw.gateWidth;
    const innerH = wallH * 1.0;
    for (const [u0, u1] of [
      [-H + 0.4, -gw / 2],
      [gw / 2, H - 0.4],
    ] as const) {
      const len = u1 - u0;
      if (len < 1.2) continue;
      const mid = toWorld((u0 + u1) / 2, iw.v);
      push(
        "courtyard-wall",
        [mid.x, 0, mid.z],
        rotU,
        [len, innerH, 0.55],
        wallMaterialId,
      );
      push(
        "battlement",
        [mid.x, innerH, mid.z],
        rotU,
        [len, 0.5, 0.45],
        wallMaterialId,
      );
    }
    // 内門(小さなアーチ)
    const gp = toWorld(0, iw.v);
    push(
      "arch",
      [gp.x, 0, gp.z],
      rotU,
      [gw + 1.6, innerH + 0.9, 1.0],
      plinthMaterial,
      { open: gw / (gw + 1.6), rise: 0.68 },
    );
  }

  // --- 門楼(gatehouse): アーチ開口+小屋根 ---
  const gatehouseMass = precinct.masses.find((m) => m.role === "gatehouse");
  if (gatehouseMass) {
    const gw = gatehouseMass.rect.u1 - gatehouseMass.rect.u0;
    const gd = gatehouseMass.rect.v1 - gatehouseMass.rect.v0;
    const gc = rectCenter(gatehouseMass.rect);
    const gp = toWorld(gc.u, gc.v);
    const archTotalH = wallH + 1.6;
    const mainGate = precinct.gates.find((g) => g.main);
    push(
      "arch",
      [gp.x, 0, gp.z],
      rotU,
      [gw, archTotalH, gd],
      plinthMaterial,
      {
        open: clamp((mainGate?.width ?? 3.2) / gw, 0.3, 0.8),
        rise: 0.62,
      },
    );
    if (enclosureKind === "wall") {
      // 城郭型: 門楼の天端に胸壁+両脇の双塔(契約「囲い」のリズム要素)
      push(
        "battlement",
        [gp.x, archTotalH, gp.z],
        rotU,
        [gw + 0.4, 0.55, gd * 0.8],
        plinthMaterial,
      );
      const ftw = 2.1;
      const flankH = archTotalH + 1.4;
      for (const s of [-1, 1]) {
        const fp = toWorld(gc.u + s * (gw / 2 + ftw / 2 - 0.2), gc.v);
        push(
          "tower",
          [fp.x, 0, fp.z],
          rotU,
          [ftw, flankH, ftw],
          materials.wall,
          { taper: 0.93 },
        );
        push(
          "battlement",
          [fp.x, flankH, fp.z],
          rotU,
          [ftw + 0.2, 0.5, ftw * 0.8],
          plinthMaterial,
        );
      }
    } else {
      // 聖域型: 小さな寄棟屋根
      const rh = tanPitch * ((gd + 1.2) / 2) * 0.7;
      push(
        "hip",
        [gp.x, archTotalH - 0.05, gp.z],
        rotU,
        [gw + 0.8, rh, gd + 1.2],
        materials.roof,
        { pitch },
      );
    }
  }

  // --- 隅塔(authority。頂部高はアクセント塔の 0.6 倍以下。契約) ---
  const turretCap = crownTop * 0.6;
  for (const t of precinct.turrets) {
    const tw = t.width;
    const tu = clamp(t.u, -H + tw / 2, H - tw / 2);
    const tv = clamp(t.v, -H + tw / 2, H - tw / 2);
    const tp = toWorld(tu, tv);
    const spireH = tw * 1.25;
    const bodyH = Math.min(wallH + 2.2 + 2.0 * mon, turretCap - spireH) - plinthH;
    if (bodyH < 1.5) continue;
    push(
      "plinth",
      [tp.x, bottomY, tp.z],
      rotU,
      [tw + 0.4, plinthH - bottomY, tw + 0.4],
      plinthMaterial,
    );
    push("tower", [tp.x, plinthH, tp.z], rotU, [tw, bodyH, tw], materials.wall, {
      taper: 0.9,
    });
    push(
      "spire",
      [tp.x, plinthH + bodyH - 0.05, tp.z],
      rotU,
      [tw * 0.9 * 1.3, spireH, tw * 0.9 * 1.3],
      materials.roof,
    );
  }

  // --- 縫合(connector): 低い接続壁 / 屋根付き渡り廊下(契約「量塊の造形」) ---
  for (const c of precinct.connectors) {
    const du = c.b.u - c.a.u;
    const dv = c.b.v - c.a.v;
    const len = Math.hypot(du, dv);
    if (len < 0.5) continue;
    const mid = toWorld((c.a.u + c.b.u) / 2, (c.a.v + c.b.v) / 2);
    const horizontal = Math.abs(du) >= Math.abs(dv);
    const rot = horizontal ? rotU : rotV;
    if (c.kind === "passage") {
      // 渡り廊下: 壁体+切妻屋根(主館とクラウンを繋ぐ)
      const pw = 1.9;
      const ph = 2.9;
      push(
        "wall",
        [mid.x, plinthH, mid.z],
        rot,
        [len + 0.4, ph, pw],
        materials.wall,
        { floor: 0 },
      );
      const span = pw + 2 * EAVE_OVERHANG;
      push(
        "gable",
        [mid.x, plinthH + ph - ROOF_BASE_SINK, mid.z],
        rot,
        [len + 0.4 + 2 * GABLE_END_OVERHANG, tanPitch * (span / 2) * 0.8, span],
        materials.roof,
        { pitch },
      );
    } else {
      push(
        "courtyard-wall",
        [mid.x, 0, mid.z],
        rot,
        [len, Math.min(wallH, 2.2), 0.45],
        wallMaterialId,
      );
    }
  }

  // --- 回廊(聖域型: cloister の中庭を囲む列柱+片流れ屋根) ---
  const cloister = precinct.courts.find((c) => c.kind === "cloister");
  if (cloister && dominant === "arcane") {
    const walkW = 1.7; // 回廊の奥行き
    const colH = 2.4;
    const r = cloister.rect;
    const inner: PrecinctRect = {
      u0: r.u0 + walkW,
      u1: r.u1 - walkW,
      v0: r.v0 + walkW,
      v1: r.v1 - walkW,
    };
    if (inner.u1 - inner.u0 > 4 && inner.v1 - inner.v0 > 4) {
      // 四辺の片流れ屋根(高い側 = 外)と柱列
      const sides: {
        cu: number;
        cv: number;
        len: number;
        rot: number;
        horizontal: boolean;
        sign: number;
      }[] = [
        { cu: (r.u0 + r.u1) / 2, cv: r.v0 + walkW / 2, len: r.u1 - r.u0, rot: rotU, horizontal: true, sign: -1 },
        { cu: (r.u0 + r.u1) / 2, cv: r.v1 - walkW / 2, len: r.u1 - r.u0, rot: rotU, horizontal: true, sign: 1 },
        { cu: r.u0 + walkW / 2, cv: (inner.v0 + inner.v1) / 2, len: inner.v1 - inner.v0, rot: rotV, horizontal: false, sign: -1 },
        { cu: r.u1 - walkW / 2, cv: (inner.v0 + inner.v1) / 2, len: inner.v1 - inner.v0, rot: rotV, horizontal: false, sign: 1 },
      ];
      for (const sdef of sides) {
        const mid = toWorld(sdef.cu, sdef.cv);
        // 片流れ屋根(lean-to): 高い縁がローカル −z。外側が高くなるよう
        // sign で回転を選ぶ(u 辺は ±v、v 辺は ±u が外)
        const rot =
          sdef.horizontal
            ? sdef.sign < 0
              ? rotU + Math.PI
              : rotU
            : sdef.sign < 0
              ? rotV + Math.PI
              : rotV;
        // 回廊の外縁の壁(浮いた屋根帯にしない。内縁は柱列、外縁は壁)
        const outerOff = sdef.sign * (walkW / 2);
        const wallMid = toWorld(
          sdef.horizontal ? sdef.cu : sdef.cu + outerOff,
          sdef.horizontal ? sdef.cv + outerOff : sdef.cv,
        );
        push(
          "courtyard-wall",
          [wallMid.x, 0, wallMid.z],
          sdef.horizontal ? rotU : rotV,
          [sdef.len, colH - 0.05, 0.3],
          plinthMaterial,
        );
        push(
          "lean-to",
          [mid.x, colH, mid.z],
          rot,
          [sdef.len, 0.9, walkW + 0.5],
          materials.roof,
        );
        // 柱列(回廊の内縁 = 中庭側。beam の縦使い)
        const nCol = Math.max(2, Math.round(sdef.len / 2.6));
        const innerOff = -sdef.sign * (walkW / 2 - 0.15);
        for (let i = 0; i < nCol; i++) {
          const t = -sdef.len / 2 + (i + 0.5) * (sdef.len / nCol);
          const cu = sdef.horizontal ? sdef.cu + t : sdef.cu + innerOff;
          const cv = sdef.horizontal ? sdef.cv + innerOff : sdef.cv + t;
          const cp = toWorld(cu, cv);
          push("beam", [cp.x, 0, cp.z], rotU, [0.3, colH, 0.3], materials.trim);
        }
        // 回廊欄間の紋様(聖域型。予算内のみ)
        if (glowUsed < glowBudget) {
          pushGlow(
            "sigil",
            [mid.x, colH - 0.4, mid.z],
            sdef.horizontal ? rotU : rotV,
            [sdef.len * 0.7, SIGIL_BAND * 0.8, 1],
            "glow",
          );
        }
      }
    }
  }

  // --- 中庭 Plaza(計画された中庭ごと。内接円径 6 以上のみ。契約) ---
  let courtyardIndex = 0;
  for (const court of precinct.courts) {
    const w = court.rect.u1 - court.rect.u0;
    const d = court.rect.v1 - court.rect.v0;
    if (Math.min(w, d) < 6) continue;
    const c = rectCenter(court.rect);
    const plaza: Plaza = {
      id: `plaza/courtyard/center/${courtyardIndex}`,
      kind: "courtyard",
      position: toWorld(c.u, c.v),
      radius: Math.hypot(w / 2, d / 2),
      polygon: rectPolygon(court.rect),
    };
    model.plazas.push(plaza);
    courtyardIndex++;
  }

  // --- zoneMask 上書き対象(量塊の実体 footprint のみ。契約) ---
  const zoneRects: Polygon[] = [];
  for (const m of precinct.masses) {
    zoneRects.push(rectPolygon(m.rect));
  }

  const building: Building = {
    id: "building/center",
    parcelId: null,
    spanParcelIds: [],
    role: "center",
    footprint,
    facing,
    floors: hallFloors,
    roof: { type: "compound", pitch },
    foundation: {
      kind: overWater ? "stonebase" : "plinth",
      plinthHeight: plinthH,
      overWater,
      bottomY,
    },
    materials,
    parts,
  };
  return { building, zoneRects };
}
