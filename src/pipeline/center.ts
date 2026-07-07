/**
 * 中心建築の拡張文法(PHASE 5a commit 16)。
 * 契約は docs/internal/contracts/buildings.md「中心建築(PHASE 5a commit 16)」、
 * 設計は implementation-spec 1.7節(4軸スコア・モードなし連続分岐)・PHASE 5a。
 *
 * - 段12「建物」が一般建物の展開後に呼び、buildings の末尾へ 1 棟追加する
 *   (スカイライン検証が周辺一般建物の最高点を入力とするため)
 * - 4軸(centerPlan.axes)の最大軸が骨格を、2位軸が装飾傾向を決める:
 *   arcane=大魔導塔+水晶+発光開口・紋様 / authority=双塔+薔薇窓+尖頭窓 /
 *   waterside=館+水側の塔 / rustic=大農家+物見塔。
 *   2位軸 arcane → 紋様・発光開口を付加、authority → 薔薇窓・尖頭窓を付加
 * - スカイライン契約: 中心最高点 ≥ 周辺一般建物の最高点 × derived.skylineRatio。
 *   主塔の塔身高を必要高まで引き上げて満たす(検証は段12 のアサーション)
 * - 発光(crystal / sigil / glow-window)は art-direction 5.4節の規律に従い、
 *   面積合計を glowAreaCap × 箱庭面積 × CENTER_GLOW_SHARE 以下に打ち切る
 * - 乱数は "building/center"(骨格。消費数固定)と
 *   "building/center/details"(窓の詳細)のみ消費する
 * - 浮遊要素クラスタの立体化は PHASE 5b の担当(wards.floaters の計画は
 *   towers / gates / shrines を anchor とし、中心建築へは接続しない)
 */
import { makeRng } from "../rng";
import {
  FLOOR_HEIGHT,
  SHORE_SKIRT_BOTTOM_Y,
  type Building,
  type Derived,
  type Part,
  type Plaza,
  type Vec2,
  type WorldModel,
} from "../model/worldmodel";
import { polygonArea } from "../model/waterfield";
import { ensureClockwise } from "../model/geometry";
import type { SiteContext } from "./parcels";

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/** 4軸の順位付けの固定順(同点のタイブレーク。契約) */
const AXIS_ORDER = ["arcane", "authority", "waterside", "rustic"] as const;
export type CenterAxisKey = (typeof AXIS_ORDER)[number];

/** 発光面積の中心建築の取り分(残りは PHASE 5b の結界要素。契約) */
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

/** 矩形の翼(mass)。u=間口方向、v=正面からの奥行き方向 */
interface Mass {
  u0: number;
  u1: number;
  v0: number;
  v1: number;
  floors: number;
  /** 棟の向き(true = 間口方向 u に沿う) */
  ridgeAlongU: boolean;
  /** 屋根型 */
  roofType: "gable" | "hip";
}

/** 塔の仕様 */
interface TowerSpec {
  u: number;
  v: number;
  width: number;
  /** 頂部(水晶・尖塔の先端)の目標 y */
  topY: number;
  taper: number;
  top: "crystal" | "spire" | "spire-crystal";
  bodyMaterial: string;
  spireMaterial: string;
  /** 発光開口の列(塔正面)を付けるか */
  glowWindows: boolean;
  /** 結界紋様(リング+菱形紋)を刻むか */
  sigils: boolean;
}

/**
 * 段12「建物」から呼ばれる中心建築の展開。
 * buildings へは呼び出し側が追加する。中庭の Plaza(kind "courtyard")は
 * この関数が model.plazas へ追記する。
 */
export function expandCenterBuilding(
  model: WorldModel,
  ctx: SiteContext,
  general: readonly Building[],
): Building {
  const { seed, params, derived } = model.meta;
  const plan = model.centerPlan;
  // 骨格ストリーム(消費数は入力に依らず固定: 5 値)
  const rng = makeRng(seed, "building/center");
  const pitch = 50 + 8 * rng.next();
  const widthJitter = 0.96 + 0.08 * rng.next();
  const depthJitter = 0.96 + 0.08 * rng.next();
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

  // --- 骨格寸法(支配軸+Monumentality) ---
  const rustic = dominant === "rustic";
  const hallW = usable * (rustic ? 0.72 : 0.62) * widthJitter;
  const hallD = usable * (rustic ? 0.42 : 0.36) * depthJitter;
  const hw = hallW / 2;
  const forecourt = Math.max(3.2, usable * 0.22);
  const v0 = -H + forecourt;
  const hallBackV = v0 + hallD;
  const hallFloorsBase =
    dominant === "arcane"
      ? 1.6 + 1.8 * mon
      : dominant === "authority"
        ? 1.8 + 2.4 * mon
        : dominant === "waterside"
          ? 1.4 + 1.6 * mon
          : 1.0 + 1.0 * mon;
  const hallFloors = clamp(Math.round(hallFloorsBase), 1, 5);
  const hallRoofType: Mass["roofType"] =
    dominant === "authority" || dominant === "waterside" ? "hip" : "gable";

  // 翼棟(Monumentality と敷地規模で 0〜2)
  const wingW = usable * 0.19;
  const wingD = usable * 0.34;
  let wingCount = 0;
  if (usable >= 18 && mon >= 0.35) wingCount = 2;
  else if (usable >= 15 && mon >= 0.18) wingCount = 1;
  if (rustic) wingCount = Math.min(wingCount, 1);
  const wingSide = sideRoll < 0.5 ? -1 : 1;
  const wingFloors = Math.max(1, hallFloors - 1);
  const wingBackV = hallBackV + wingD;

  const masses: Mass[] = [
    {
      u0: -hw,
      u1: hw,
      v0,
      v1: hallBackV,
      floors: hallFloors,
      ridgeAlongU: true,
      roofType: hallRoofType,
    },
  ];
  const wingSides: number[] =
    wingCount === 2 ? [-1, 1] : wingCount === 1 ? [wingSide] : [];
  for (const s of wingSides) {
    masses.push({
      u0: s > 0 ? hw - wingW : -hw,
      u1: s > 0 ? hw : -hw + wingW,
      v0: hallBackV - 0.06,
      v1: wingBackV,
      floors: wingFloors,
      ridgeAlongU: false,
      roofType: "gable",
    });
  }

  // --- footprint(主棟+翼棟の外形。矩形 / L / U。契約) ---
  const local: [number, number][] = [[-hw, v0], [hw, v0]];
  if (wingSides.includes(1)) {
    local.push([hw, wingBackV], [hw - wingW, wingBackV], [hw - wingW, hallBackV]);
  } else {
    local.push([hw, hallBackV]);
  }
  if (wingSides.includes(-1)) {
    local.push([-hw + wingW, hallBackV], [-hw + wingW, wingBackV], [-hw, wingBackV]);
  } else {
    local.push([-hw, hallBackV]);
  }
  const footprint = ensureClockwise(local.map(([u, v]) => toWorld(u, v)));

  // --- 接地(footprint が水面にかかる場合は接地契約に従う) ---
  const overWater = footprint.some((p) => ctx.riverLakeSdf(p.x, p.z) < 0);
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

  // --- 主棟・翼棟: 基壇 → 壁 → 屋根 ---
  const tanPitch = Math.tan((pitch * Math.PI) / 180);
  let hallRoofTop = 0;
  for (let mi = 0; mi < masses.length; mi++) {
    const m = masses[mi];
    if (!m) continue;
    const du = m.u1 - m.u0;
    const dv = m.v1 - m.v0;
    const c = toWorld((m.u0 + m.u1) / 2, (m.v0 + m.v1) / 2);
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
        materials.wall,
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
      materials.roof,
      { pitch },
    );
    if (mi === 0) hallRoofTop = baseY + rh;
  }

  // --- 煙突(素朴・水辺の主棟。実寸比 15% 過大は一般建物と同じ規範) ---
  if ((rustic || dominant === "waterside") && chimneyRoll < 0.85) {
    const cw = 0.72 * 1.15;
    const along = (sideRoll < 0.5 ? -1 : 1) * Math.max(0, hw - 1.6);
    const pos = toWorld(along, (v0 + hallBackV) / 2);
    const baseY = plinthH + hallFloors * FLOOR_HEIGHT - 0.3;
    const topY = hallRoofTop + 0.9;
    push("chimney", [pos.x, baseY, pos.z], rotU, [cw, topY - baseY, cw], plinthMaterial);
  }

  // --- スカイライン契約: 周辺最高点 × skylineRatio まで主塔を引き上げる ---
  let peripheralTop = 0;
  for (const b of general) peripheralTop = Math.max(peripheralTop, buildingTopY(b));
  const requiredTop = peripheralTop * derived.skylineRatio;
  const targetTop = Math.max(plan.heightHint, requiredTop * 1.03, hallRoofTop + 4);

  /** 塔の展開(基壇 → 塔身 → 頂部)。実際の頂部 y を返す */
  const emitTower = (spec: TowerSpec): number => {
    const p = toWorld(spec.u, spec.v);
    push(
      "plinth",
      [p.x, bottomY, p.z],
      rotU,
      [spec.width + 0.5, plinthH - bottomY, spec.width + 0.5],
      plinthMaterial,
    );
    // 頂部の高さ配分
    const crystalW = Math.min(1.0, spec.width * 0.28);
    const crystalH = clamp(spec.width * 0.52, 1.1, 2.2);
    const spireH = spec.width * 1.5;
    let topH: number;
    if (spec.top === "crystal") {
      topH = 0.35 + crystalH; // ソケット 0.6 − 食い込み 0.25
    } else if (spec.top === "spire-crystal") {
      topH = spireH + 0.55; // 先端の小水晶 0.9 − 食い込み 0.35
    } else {
      topH = spireH;
    }
    const bodyH = Math.max(4, spec.topY - topH - plinthH);
    const bodyTop = plinthH + bodyH;
    push(
      "tower",
      [p.x, plinthH, p.z],
      rotU,
      [spec.width, bodyH, spec.width],
      spec.bodyMaterial,
      { taper: spec.taper },
    );
    const topW = spec.width * spec.taper;
    let actualTop = bodyTop;
    if (spec.top === "crystal") {
      // 石のソケット(小さな先細り)+頂部水晶(発光コア。細身の規律)
      push(
        "tower",
        [p.x, bodyTop, p.z],
        rotU,
        [topW * 0.6, 0.6, topW * 0.6],
        plinthMaterial,
        { taper: 0.45 },
      );
      pushGlow(
        "crystal",
        [p.x, bodyTop + 0.35, p.z],
        rotU + Math.PI / 4,
        [crystalW, crystalH, crystalW],
        "glow",
        undefined,
        true,
      );
      actualTop = bodyTop + 0.35 + crystalH;
    } else {
      push(
        "spire",
        [p.x, bodyTop - 0.05, p.z],
        rotU,
        [topW * 1.3, spireH, topW * 1.3],
        spec.spireMaterial,
      );
      actualTop = bodyTop - 0.05 + spireH;
      if (spec.top === "spire-crystal") {
        pushGlow(
          "crystal",
          [p.x, actualTop - 0.35, p.z],
          rotU + Math.PI / 4,
          [0.55, 0.9, 0.55],
          "glow",
          undefined,
          true,
        );
        actualTop += 0.55;
      }
    }
    // 塔面の半幅(先細りを考慮)
    const halfAt = (y: number): number =>
      (spec.width / 2) *
      (1 - (1 - spec.taper) * clamp((y - plinthH) / bodyH, 0, 1));
    // 発光開口の列(塔正面 = −v 側。開口は 1 階高の 1/3 以下)
    if (spec.glowWindows) {
      const y0 = plinthH + 4;
      const y1 = bodyTop - 2.4;
      const n = clamp(Math.floor((y1 - y0) / 4.4), 1, 5);
      for (let i = 0; i < n; i++) {
        const y = y0 + ((y1 - y0) / Math.max(1, n - 1)) * i;
        const face = toWorld(spec.u, spec.v - halfAt(y + GLOW_WINDOW_H / 2));
        if (
          !pushGlow(
            "glow-window",
            [face.x, y, face.z],
            frontRot,
            [GLOW_WINDOW_W, GLOW_WINDOW_H, GLOW_WINDOW_DEPTH],
            materials.trim,
          )
        ) {
          break;
        }
      }
    }
    // 結界紋様: リング(3 段 × 4 面)+正面の菱形紋
    if (spec.sigils) {
      const ringYs = [
        plinthH + bodyH * 0.3,
        plinthH + bodyH * 0.62,
        bodyTop - 1.0,
      ];
      for (const y of ringYs) {
        const half = halfAt(y);
        const len = half * 2 * 0.85;
        const faces: { du: number; dv: number; rot: number }[] = [
          { du: 0, dv: -1, rot: rotU }, // 正面
          { du: 0, dv: 1, rot: rotU }, // 背面
          { du: -1, dv: 0, rot: rotV }, // 左
          { du: 1, dv: 0, rot: rotV }, // 右
        ];
        for (const face of faces) {
          const pos = toWorld(
            spec.u + face.du * (half + 0.04),
            spec.v + face.dv * (half + 0.04),
          );
          if (
            !pushGlow(
              "sigil",
              [pos.x, y, pos.z],
              face.rot,
              [len, SIGIL_BAND, 1],
              "glow",
            )
          ) {
            return actualTop;
          }
        }
      }
      // 菱形紋(正面の上部。4 本の帯を面内回転 tilt で組む)
      const dy = bodyTop - 2.2;
      const r = 0.8;
      const halfD = halfAt(dy) + 0.05;
      const edges: { ou: number; oy: number; tilt: number }[] = [
        { ou: r / 2, oy: r / 2, tilt: -Math.PI / 4 },
        { ou: r / 2, oy: -r / 2, tilt: Math.PI / 4 },
        { ou: -r / 2, oy: -r / 2, tilt: -Math.PI / 4 },
        { ou: -r / 2, oy: r / 2, tilt: Math.PI / 4 },
      ];
      const len = r * Math.SQRT2;
      for (const e of edges) {
        const pos = toWorld(spec.u + e.ou, spec.v - halfD);
        if (
          !pushGlow(
            "sigil",
            [pos.x, dy + e.oy - SIGIL_BAND / 2, pos.z],
            rotU,
            [len, SIGIL_BAND * 0.8, 1],
            "glow",
            { tilt: e.tilt },
          )
        ) {
          return actualTop;
        }
      }
    }
    return actualTop;
  };

  // --- 塔(骨格) ---
  const towers: TowerSpec[] = [];
  if (dominant === "arcane") {
    // 大魔導塔: 細長い塔身+頂部水晶(様式言語 6節の高さの誇張)
    const tw = clamp(3.4 + 2.0 * mon, 3.4, 5.4);
    towers.push({
      u: 0,
      v: hallBackV + tw / 2 - 0.3,
      width: tw,
      topY: targetTop,
      taper: 0.8,
      top: "crystal",
      bodyMaterial: materials.wall,
      spireMaterial: materials.roof,
      glowWindows: true,
      sigils: true,
    });
    if (mon >= 0.65 && wingCount === 2) {
      // 中庭奥の隅の小塔(頂部水晶)
      for (const s of [-1, 1]) {
        towers.push({
          u: s * (hw - 1.2),
          v: Math.min(H - 2.0, wingBackV + 2.4),
          width: 2.2,
          topY: targetTop * 0.45,
          taper: 0.85,
          top: "crystal",
          bodyMaterial: materials.wall,
          spireMaterial: materials.roof,
          glowWindows: false,
          sigils: arcaneDeco,
        });
      }
    }
  } else if (dominant === "authority") {
    // 正面両脇の双塔(尖塔屋根)
    const tw = clamp(3.4 + 1.8 * mon, 3.4, 5.2);
    for (const s of [-1, 1]) {
      towers.push({
        u: s * (hw - tw / 2 + 0.4),
        v: v0 + tw / 2 - 0.4,
        width: tw,
        topY: targetTop,
        taper: 0.88,
        top: arcaneDeco ? "spire-crystal" : "spire",
        bodyMaterial: materials.wall,
        spireMaterial: materials.roof,
        glowWindows: false,
        sigils: arcaneDeco,
      });
    }
  } else if (dominant === "waterside") {
    // 最も水面に近い背面隅の塔(湖畔の館・川沿いの塔)
    let bestDir = { x: 1, z: 0 };
    let bestSdf = Infinity;
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const dir = { x: Math.cos(a), z: Math.sin(a) };
      const probe = ctx.riverLakeSdf(
        plan.position.x + dir.x * side * 0.75,
        plan.position.z + dir.z * side * 0.75,
      );
      if (probe < bestSdf) {
        bestSdf = probe;
        bestDir = dir;
      }
    }
    const du = bestDir.x * uDir.x + bestDir.z * uDir.z;
    const su = du >= 0 ? 1 : -1;
    const tw = clamp(3.4 + 1.2 * mon, 3.4, 4.6);
    towers.push({
      u: su * (hw - tw / 2 + 0.3),
      v: hallBackV + tw / 2 - 0.3,
      width: tw,
      topY: targetTop,
      taper: 0.86,
      top: arcaneDeco ? "spire-crystal" : "spire",
      bodyMaterial: materials.wall,
      spireMaterial: materials.roof,
      glowWindows: arcaneDeco,
      sigils: arcaneDeco,
    });
  } else {
    // 物見塔(木造の細い塔+尖り屋根)
    const su = sideRoll < 0.5 ? -1 : 1;
    towers.push({
      u: su * (hw - 1.5),
      v: hallBackV + 2.0,
      width: 2.6,
      topY: targetTop,
      taper: 0.9,
      top: arcaneDeco ? "spire-crystal" : "spire",
      bodyMaterial: "rough-wood",
      spireMaterial: materials.roof,
      glowWindows: false,
      sigils: arcaneDeco,
    });
  }
  let towerBackV = hallBackV;
  for (const spec of towers) {
    emitTower(spec);
    towerBackV = Math.max(towerBackV, spec.v + spec.width / 2);
  }

  // --- 正面の大扉+前庭階段 ---
  const doorW = clamp(1.5 + 1.0 * mon, 1.5, 2.5);
  const doorH = Math.min(2.7, FLOOR_HEIGHT - 0.3);
  const doorPos = toWorld(0, v0);
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

  // --- 大型開口(権威装飾: 薔薇窓+整列した尖頭窓)と正面の窓 ---
  const frontFaceAt = (u: number): Vec2 => toWorld(u, v0);
  const archW = 0.95;
  const archH = 2.3;
  if (authorityDeco) {
    // 尖頭窓: 正面 1 階に扉を挟んで対称に整列
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
    // 薔薇窓: 正面の最上階の中央(2 階以上のときのみ)
    if (hallFloors >= 2) {
      const d = Math.min(2.2, hallW * 0.3);
      const y = plinthH + (hallFloors - 1) * FLOOR_HEIGHT + (FLOOR_HEIGHT - d) / 2;
      const p = frontFaceAt(0);
      push("rose-window", [p.x, y, p.z], frontRot, [d, d, 0.18], materials.trim);
    }
  }
  // 魔導装飾: 正面の最上階に発光開口(大魔導塔の光を正面にも通わせる)
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

  // --- 通常の窓(壁面ごとの整列列。乱数は details ストリームのみ) ---
  const winW = 1.15;
  const winH = clamp(1.35 + 0.5 * mon, 1.35, 1.8);
  const emitWindowRow = (
    m: Mass,
    face: "front" | "back" | "left" | "right",
    skipDoor: boolean,
  ): void => {
    const du = m.u1 - m.u0;
    const dv = m.v1 - m.v0;
    const cu = (m.u0 + m.u1) / 2;
    const cv = (m.v0 + m.v1) / 2;
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
          return toWorld(cu + t, m.v0);
        case "back":
          return toWorld(cu + t, m.v1);
        case "left":
          return toWorld(m.u0, cv + t);
        default:
          return toWorld(m.u1, cv + t);
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
    for (let floor = 0; floor < m.floors; floor++) {
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
  const hall = masses[0];
  if (hall) {
    if (!authorityDeco) emitWindowRow(hall, "front", true);
    emitWindowRow(hall, "left", false);
    emitWindowRow(hall, "right", false);
    emitWindowRow(hall, "back", false);
  }
  for (let mi = 1; mi < masses.length; mi++) {
    const m = masses[mi];
    if (!m) continue;
    const s = wingSides[mi - 1] ?? 1;
    emitWindowRow(m, s > 0 ? "right" : "left", false); // 外側の面
    emitWindowRow(m, "back", false);
  }

  // --- 中庭壁と中庭(kind "courtyard" の Plaza) ---
  const cwHalf = hw;
  const courtBackV = Math.min(H - 0.7, wingBackV + Math.max(3, usable * 0.12));
  const wallH = rustic ? 1.5 : clamp(2.2 + 1.2 * mon, 2.2, 3.4);
  const wallT = 0.55;
  if (courtBackV - hallBackV >= 2) {
    const back = toWorld(0, courtBackV);
    push(
      "courtyard-wall",
      [back.x, 0, back.z],
      rotU,
      [cwHalf * 2 + wallT, wallH, wallT],
      plinthMaterial,
    );
    for (const s of [-1, 1]) {
      const startV = wingSides.includes(s) ? wingBackV : hallBackV;
      const len = courtBackV - startV - wallT / 2;
      if (len < 1.5) continue;
      const mid = toWorld(s * cwHalf, startV + len / 2);
      push(
        "courtyard-wall",
        [mid.x, 0, mid.z],
        rotV,
        [len, wallH, wallT],
        plinthMaterial,
      );
    }
    // 中庭(壁・主棟・塔から 0.8 内側の矩形。奥行き 6 以上のときのみ)
    const innerHalf =
      (wingCount > 0 ? Math.min(cwHalf, hw - wingW) : cwHalf) - 0.8;
    const frontV = Math.max(hallBackV, towerBackV) + 0.8;
    const backV = courtBackV - wallT / 2 - 0.8;
    if (backV - frontV >= 6 && innerHalf >= 3) {
      const cv = (frontV + backV) / 2;
      const polygon = ensureClockwise([
        toWorld(-innerHalf, frontV),
        toWorld(innerHalf, frontV),
        toWorld(innerHalf, backV),
        toWorld(-innerHalf, backV),
      ]);
      const position = toWorld(0, cv);
      const plaza: Plaza = {
        id: "plaza/courtyard",
        kind: "courtyard",
        position,
        radius: Math.hypot(innerHalf, (backV - frontV) / 2),
        polygon,
      };
      model.plazas.push(plaza);
    }
  }

  return {
    id: "building/center",
    parcelId: null,
    role: "center",
    footprint,
    facing,
    floors: hallFloors,
    roof: { type: wingCount > 0 ? "compound" : hallRoofType, pitch },
    foundation: {
      kind: overWater ? "stonebase" : "plinth",
      plinthHeight: plinthH,
      overWater,
      bottomY,
    },
    materials,
    parts,
  };
}
