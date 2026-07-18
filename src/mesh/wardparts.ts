/**
 * 結界構造(結界壁・魔導塔・結界門・聖域)と魔法灯・浮遊要素の Part 展開
 * (contracts/wards.md「結界構造の立体化」
 * 「魔法灯・浮遊要素・橋の立体化」が正)。
 *
 * 設計判断: 展開は Wards 計画+derived から一意に決まる表示写像であり、
 * 新しい計画内容を持たないため、パイプラインではなく**メッシュ層の純関数**
 * として置く。WorldModel には部品を書き戻さない(正規化ハッシュは不変)。
 * 本ファイルは three 非依存とし、接地・門通過・縮退・発光面積・浮遊近傍の
 * テストが three を経由せず機械検証できる(contracts/pipeline.md)。
 *
 * - 乱数ストリームは消費しない。個体差は位置ハッシュ由来、明滅・上下動の
 *   位相は安定 id の文字列ハッシュ由来
 * - 発光面積の正は pipeline/center.ts の glowPartArea を共用し、
 *   結界の取り分 glowAreaCap × 箱庭面積 × (1 − CENTER_GLOW_SHARE) 内で
 *   予算順(塔頂 → 門紋 → 聖域 → 境界標 → 魔法灯 → 浮遊水晶 →
 *   壁紋様 → 水上弧)に採択する
 * - wardLevel の縮退は同一文法: 壁弧の歩行器 1 つが、wardLevel 1 では
 *   境界標(ward-stone)の点列を、2 以上では連続壁(ward-wall)を落とす
 * - 魔法灯 = 柱(lamp-post)+浮く火屋、浮遊要素 = 水晶(発光)/浮石。
 *   火屋・水晶・浮石は InstancedMesh のインスタンス(FloatInstance)。
 *   足元の照り返し(createLampTint / applyLampTint)は地面・舗装の
 *   頂点カラーへメッシュ側で焼き込む(zoneMask には書かない設計判断)
 */
import type { Part, Vec2, WorldModel } from "../model/worldmodel";
import { WATER_SURFACE_Y } from "../model/worldmodel";
import { polygonArea } from "../model/waterfield";
import { CENTER_GLOW_SHARE, glowPartArea } from "../pipeline/center";
import { hashString } from "../rng";

/** 結界壁の壁体厚 */
const WALL_THICKNESS = 0.85;
/** 壁高 = 1.7 + 2.3 × wallClosure(段階内・段階間で連続。1.6節) */
const WALL_HEIGHT_BASE = 1.7;
const WALL_HEIGHT_CLOSURE = 2.3;
/** 壁セグメントの継ぎ目を隠す長さの重なり */
const WALL_OVERLAP = 0.35;
/** 壁の発光紋様ラインの間隔規則(弧長): 5.5 + 6 × (1 − glowIntensity) */
const SIGIL_SPACING_MIN = 5.5;
const SIGIL_SPACING_RANGE = 6;
/** 紋様帯の見付け(縦帯の幅) */
const SIGIL_W = 0.16;
/** 境界標(wardLevel 1)の間隔: 7 − 2 × wallClosure */
const STONE_SPACING_BASE = 7;
const STONE_SPACING_CLOSURE = 2;
/** 水上結界(overwater)の発光弧: 帯の下端 y と高さ */
const WATER_ARC_Y = WATER_SURFACE_Y + 0.15;
const WATER_ARC_H = 0.34;
/** 結界門: 開口幅 = 道路幅 + 1.8、開口天端 = 3.4 + 1.2 × gateScale */
const GATE_OPEN_EXTRA = 1.8;
const GATE_CLEAR_BASE = 3.4;
const GATE_CLEAR_SCALE = 1.2;
/** 結界門の脚幅と頭上の帯(全高 = 開口天端 + GATE_HEAD) */
const GATE_LEG_W = 1.1;
const GATE_HEAD = 1.6;
const GATE_THICKNESS = 1.1;
/** 魔法灯: 柱の寸法と火屋(浮く発光八面体) */
const LAMP_POST_W = 0.16;
const LAMP_POST_H = 2.3;
const LAMP_HEAD_W = 0.34;
const LAMP_HEAD_H = 0.5;
const LAMP_HEAD_GAP = 0.16; // 天板の上に浮く量
/** 柱材が石になる roadGrade の閾値(art-direction 5.4節「木部または石」) */
const LAMP_STONE_GRADE = 1.4;
/** 浮遊要素: 水晶の割合(残りは浮石)と上下動の振幅(ワールド) */
const FLOATER_CRYSTAL_RATE = 0.35;
const FLOATER_AMP_MIN = 0.14;
const FLOATER_AMP_RANGE = 0.16;
/** 魔法灯の足元の照り返し(頂点カラー焼き込み。art-direction 3節) */
const LAMP_TINT_RADIUS = 2.6;
const LAMP_TINT_STRENGTH = 0.22;
/** 照り返しの色(彩度控えめの青緑。#3f7f74) */
const LAMP_TINT_COLOR: readonly [number, number, number] = [
  0x3f / 255,
  0x7f / 255,
  0x74 / 255,
];

/** 位置ハッシュ(0〜1)。乱数ストリームを消費しない決定論的な個体差の元 */
function wardHash(x: number, z: number, salt: number): number {
  let h =
    (Math.imul(Math.round(x * 16) | 0, 0x9e3779b1) ^
      Math.imul(Math.round(z * 16) | 0, 0x85ebca77) ^
      Math.imul(salt | 0, 0xc2b2ae3d)) >>>
    0;
  h = Math.imul(h ^ (h >>> 13), 0x27d4eb2f) >>> 0;
  // XOR は符号付き 32bit を返すため必ず符号なしへ戻す(0〜1 の契約)
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967296;
}

/**
 * 発光八面体(魔法灯の火屋・浮遊水晶)/ 浮石のインスタンス。
 * position は底面中心(単位形状 y 0〜1)。
 * phase は安定 id の文字列ハッシュ由来、amp は上下動のワールド振幅
 * (魔法灯は 0 = 静止)。時間はビューワーの uniform(WorldModel 非依存)。
 */
export interface FloatInstance {
  position: [number, number, number];
  rotation: number;
  scale: [number, number, number];
  phase: number;
  amp: number;
}

export interface WardExpansion {
  /** 展開結果(mesh/buildings.ts の既存の束へ合流する) */
  parts: Part[];
  /** 発光の面積合計(部品+火屋・浮遊水晶のインスタンス。glowPartArea 基準) */
  glowArea: number;
  /** 発光面積の予算(glowAreaCap × 箱庭面積 × 結界の取り分) */
  glowBudget: number;
  /** 魔法灯の火屋(amp 0)。ward-glow-crystals へ */
  lampHeads: FloatInstance[];
  /** 浮遊水晶(発光)。ward-glow-crystals へ */
  floatCrystals: FloatInstance[];
  /** 浮石(非発光)。ward-floatstones へ */
  floatStones: FloatInstance[];
}

/** 発光インスタンス(八面体)の発光面積(crystal と同じ換算の正) */
export function glowInstanceArea(inst: FloatInstance): number {
  const [sx, sy, sz] = inst.scale;
  return 1.8 * ((sx + sz) / 2) * sy;
}

/**
 * 魔法灯の足元の照り返し(頂点カラー焼き込み)の重み場を作る
 * (art-direction 3節。半径小・彩度控えめ)。
 * 設計判断: zoneMask は WorldModel(正規化ハッシュの対象)のため、
 * 照り返しは表示写像としてメッシュ側の頂点カラー処理で行う
 * (contracts/wards.md「魔法灯・浮遊要素・橋の立体化」)。
 * 地面(mesh/build.ts)と舗装(mesh/paving.ts)が共有する。
 */
export function createLampTint(model: WorldModel): (x: number, z: number) => number {
  const lamps = model.wards.lamps;
  if (lamps.length === 0) return () => 0;
  return (x, z) => {
    let best = 0;
    for (const l of lamps) {
      const d = Math.hypot(x - l.position.x, z - l.position.z);
      if (d >= LAMP_TINT_RADIUS) continue;
      const t = 1 - d / LAMP_TINT_RADIUS;
      const w = t * t * (3 - 2 * t);
      if (w > best) best = w;
    }
    return best;
  };
}

/**
 * 頂点バッファ(positions xyz / colors rgb)へ照り返しを焼き込む。
 * 地表近傍(|y| < 1.2)の頂点のみ対象(壁上部・岸スカート下端には掛けない)。
 */
export function applyLampTint(
  tint: (x: number, z: number) => number,
  positions: readonly number[],
  colors: number[],
): void {
  const count = Math.min(positions.length / 3, colors.length / 3);
  for (let i = 0; i < count; i++) {
    const y = positions[i * 3 + 1] ?? 0;
    if (y > 1.2 || y < -1.2) continue;
    const w =
      tint(positions[i * 3] ?? 0, positions[i * 3 + 2] ?? 0) *
      LAMP_TINT_STRENGTH;
    if (w <= 0) continue;
    for (let k = 0; k < 3; k++) {
      const c = colors[i * 3 + k] ?? 0;
      colors[i * 3 + k] = c + ((LAMP_TINT_COLOR[k] ?? 0) - c) * w;
    }
  }
}

/** リング辺の幾何(中点・長さ・向き・外向き法線) */
interface RingEdge {
  mid: Vec2;
  len: number;
  /** 辺方向の偏角(rotation = −angle で部品ローカル +x が辺方向に載る) */
  angle: number;
  /** 外向き(中心から離れる側)の単位法線 */
  normal: Vec2;
  a: Vec2;
  b: Vec2;
}

function ringEdges(ring: Vec2[], center: Vec2): RingEdge[] {
  const n = ring.length;
  const edges: RingEdge[] = [];
  for (let k = 0; k < n; k++) {
    const a = ring[k];
    const b = ring[(k + 1) % n];
    if (!a || !b) continue;
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len = Math.hypot(dx, dz);
    if (len < 1e-9) {
      edges.push({ mid: a, len: 0, angle: 0, normal: { x: 1, z: 0 }, a, b });
      continue;
    }
    const mid = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
    // 法線候補 (dz, -dx) を中心から離れる向きへ揃える
    let nx = dz / len;
    let nz = -dx / len;
    if (nx * (mid.x - center.x) + nz * (mid.z - center.z) < 0) {
      nx = -nx;
      nz = -nz;
    }
    edges.push({
      mid,
      len,
      angle: Math.atan2(dz, dx),
      normal: { x: nx, z: nz },
      a,
      b,
    });
  }
  return edges;
}

/** 結界構造一式を Part 列へ展開する(contracts/wards.md が正) */
export function expandWardParts(model: WorldModel): WardExpansion {
  const { derived } = model.meta;
  const wards = model.wards;
  const parts: Part[] = [];
  const lampHeads: FloatInstance[] = [];
  const floatCrystals: FloatInstance[] = [];
  const floatStones: FloatInstance[] = [];
  const glowBudget =
    derived.glowAreaCap *
    Math.abs(polygonArea(model.ground.boundary)) *
    (1 - CENTER_GLOW_SHARE);
  let glowArea = 0;

  if (wards.wardLevel < 1 || wards.ringPath.length < 3) {
    return { parts, glowArea, glowBudget, lampHeads, floatCrystals, floatStones };
  }

  const push = (
    type: string,
    position: [number, number, number],
    rotation: number,
    scale: [number, number, number],
    materialId: string,
    params?: Record<string, number>,
  ): void => {
    const part: Part = { type, transform: { position, rotation, scale }, materialId };
    if (params) part.params = params;
    parts.push(part);
  };

  /** 発光部品(予算内のみ採択)。採択したら true */
  const pushGlow = (
    type: string,
    position: [number, number, number],
    rotation: number,
    scale: [number, number, number],
    params?: Record<string, number>,
  ): boolean => {
    const part: Part = {
      type,
      transform: { position, rotation, scale },
      materialId: "glow",
    };
    if (params) part.params = params;
    const area = glowPartArea(part);
    if (glowArea + area > glowBudget) return false;
    glowArea += area;
    parts.push(part);
    return true;
  };

  /** 発光インスタンス(火屋・浮遊水晶)。予算内なら採択して true */
  const pushGlowInstance = (
    list: FloatInstance[],
    inst: FloatInstance,
  ): boolean => {
    const area = glowInstanceArea(inst);
    if (glowArea + area > glowBudget) return false;
    glowArea += area;
    list.push(inst);
    return true;
  };

  const center = model.centerPlan.position;
  const edges = ringEdges(wards.ringPath, center);
  const n = edges.length;
  const closure = Math.min(1, Math.max(0, derived.wallClosure));
  const glowIntensity = Math.min(1, Math.max(0, derived.glowIntensity));
  const wallH = WALL_HEIGHT_BASE + WALL_HEIGHT_CLOSURE * closure;

  // --- 魔導塔(予算順の先頭: 塔頂の水晶) -------------------------------
  for (const tower of wards.towers) {
    const p = tower.position;
    const width = Math.min(2.9, Math.max(1.8, tower.height * 0.16));
    const plinthH = 0.5;
    push(
      "plinth",
      [p.x, 0, p.z],
      0,
      [width + 0.7, plinthH, width + 0.7],
      "stone",
    );
    // 頂部: 水晶(towerScale 高で採択)or 尖屋根。予算不足時は尖屋根へ
    const wantCrystal =
      wardHash(p.x, p.z, 11) < 0.25 + 0.75 * derived.towerScale;
    const crystalW = Math.min(1.0, width * 0.34);
    const crystalH = Math.min(1.8, Math.max(1.0, width * 0.55));
    const spireH = width * 1.6;
    const topH = wantCrystal ? 0.35 + crystalH : spireH - 0.05;
    const bodyH = Math.max(4, tower.height - topH - plinthH);
    const bodyTop = plinthH + bodyH;
    const rot = wardHash(p.x, p.z, 12) * Math.PI * 0.5;
    push("tower", [p.x, plinthH, p.z], rot, [width, bodyH, width], "stone", {
      taper: 0.8,
    });
    const topW = width * 0.8;
    let crystalPlaced = false;
    if (wantCrystal) {
      crystalPlaced = pushGlow(
        "crystal",
        [p.x, bodyTop + 0.35, p.z],
        rot + Math.PI / 4,
        [crystalW, crystalH, crystalW],
      );
      if (crystalPlaced) {
        // 石のソケット(小さな先細り)
        push(
          "tower",
          [p.x, bodyTop, p.z],
          rot,
          [topW * 0.6, 0.6, topW * 0.6],
          "stone",
          { taper: 0.45 },
        );
      }
    }
    if (!crystalPlaced) {
      push(
        "spire",
        [p.x, bodyTop - 0.05, p.z],
        rot,
        [topW * 1.35, spireH, topW * 1.35],
        "slate",
      );
    }
    // 塔身の結界紋様リング(glowIntensity で段数が変わる)
    const ringYs =
      glowIntensity >= 0.25
        ? [plinthH + bodyH * 0.34, plinthH + bodyH * 0.72]
        : [plinthH + bodyH * 0.5];
    outer: for (const y of ringYs) {
      const half =
        (width / 2) * (1 - 0.2 * Math.min(1, (y - plinthH) / bodyH));
      const len = half * 2 * 0.85;
      const faces = [
        { dx: 0, dz: -1 },
        { dx: 0, dz: 1 },
        { dx: -1, dz: 0 },
        { dx: 1, dz: 0 },
      ];
      for (const f of faces) {
        // 面の外向きオフセット(回転 rot を考慮した局所 ±x / ±z 方向)。
        // 紋様のローカル +z(面法線)を外向きへ揃える
        const cos = Math.cos(rot);
        const sin = Math.sin(rot);
        const ox = f.dx * cos + f.dz * sin;
        const oz = -f.dx * sin + f.dz * cos;
        if (
          !pushGlow(
            "sigil",
            [p.x + ox * (half + 0.04), y, p.z + oz * (half + 0.04)],
            Math.atan2(ox, oz),
            [len, SIGIL_W, 1],
          )
        ) {
          break outer;
        }
      }
    }
  }

  // --- 結界門(アーチ開口+両脇の小塔+発光門紋) -----------------------
  for (const gate of wards.gates) {
    const edge = model.network.edges.find((e) => e.id === gate.roadEdgeId);
    const roadW = edge?.width ?? 3.6;
    const openW = roadW + GATE_OPEN_EXTRA;
    const clearH = GATE_CLEAR_BASE + GATE_CLEAR_SCALE * derived.gateScale;
    const totalH = clearH + GATE_HEAD;
    const span = openW + 2 * GATE_LEG_W;
    // rotation r: ローカル +z(厚み方向)が道路方向 (cos a, sin a) に載る
    const rot = Math.PI / 2 - gate.angle;
    const p = gate.position;
    push("arch", [p.x, 0, p.z], rot, [span, totalH, GATE_THICKNESS], "stone", {
      open: openW / span,
      rise: clearH / totalH,
    });
    // 両脇の小塔(壁高より一段高い柱+石の笠)
    const pierH = clearH * 0.72;
    const pierW = 1.15;
    const perp = { x: Math.sin(gate.angle), z: -Math.cos(gate.angle) };
    for (const side of [1, -1]) {
      const q = {
        x: p.x + perp.x * (span / 2 + 0.75) * side,
        z: p.z + perp.z * (span / 2 + 0.75) * side,
      };
      push("tower", [q.x, 0, q.z], rot, [pierW, pierH, pierW], "stone", {
        taper: 0.85,
      });
      push(
        "tower",
        [q.x, pierH, q.z],
        rot,
        [pierW * 1.05, 0.35, pierW * 1.05],
        "stone",
        { taper: 0.6 },
      );
    }
    // 発光門紋: 頭部の菱形紋(両面)+開口脚の縦帯(両面)
    const roadDir = { x: Math.cos(gate.angle), z: Math.sin(gate.angle) };
    const faceOff = GATE_THICKNESS / 2 + 0.04;
    const diamondY = clearH + GATE_HEAD * 0.5;
    const r = Math.min(0.55, GATE_HEAD * 0.34);
    const dEdges = [
      { ou: r / 2, oy: r / 2, tilt: -Math.PI / 4 },
      { ou: r / 2, oy: -r / 2, tilt: Math.PI / 4 },
      { ou: -r / 2, oy: -r / 2, tilt: -Math.PI / 4 },
      { ou: -r / 2, oy: r / 2, tilt: Math.PI / 4 },
    ];
    const dLen = r * Math.SQRT2;
    gateGlow: for (const side of [1, -1]) {
      const fx = p.x + roadDir.x * faceOff * side;
      const fz = p.z + roadDir.z * faceOff * side;
      const faceRot = side === 1 ? rot : rot + Math.PI;
      for (const e of dEdges) {
        if (
          !pushGlow(
            "sigil",
            [
              fx + perp.x * e.ou,
              diamondY + e.oy - (SIGIL_W * 0.8) / 2,
              fz + perp.z * e.ou,
            ],
            faceRot,
            [dLen, SIGIL_W * 0.8, 1],
            { tilt: e.tilt },
          )
        ) {
          break gateGlow;
        }
      }
      // 開口脚の縦帯(門柱紋)
      for (const leg of [1, -1]) {
        const lx = fx + perp.x * (openW / 2 + GATE_LEG_W / 2) * leg;
        const lz = fz + perp.z * (openW / 2 + GATE_LEG_W / 2) * leg;
        if (
          !pushGlow(
            "sigil",
            [lx, clearH * 0.2, lz],
            faceRot,
            [SIGIL_W, clearH * 0.5, 1],
          )
        ) {
          break gateGlow;
        }
      }
    }
  }

  // --- 聖域・祠(kind に応じた 3 種の造形) ------------------------------
  for (const shrine of wards.shrines) {
    const p = shrine.position;
    // 正面は中心の方角(静かな場所から街を向く)
    const toC = { x: center.x - p.x, z: center.z - p.z };
    const tLen = Math.hypot(toC.x, toC.z) || 1;
    const front = { x: toC.x / tLen, z: toC.z / tLen };
    /** ローカル +z が front を向く回転 */
    const faceRot = Math.atan2(front.x, front.z);
    if (shrine.kind === "shrine") {
      // 小さな祠: 基壇+躯体+石の切妻+扉+門前紋様
      const rotU = faceRot + Math.PI / 2; // 棟(ローカル +x)は正面と直交
      push("plinth", [p.x, 0, p.z], rotU, [2.2, 0.4, 1.9], "stone");
      push("wall", [p.x, 0.4, p.z], rotU, [1.6, 1.7, 1.3], "stone");
      const roofSpan = 1.9;
      const roofH = (Math.tan((54 * Math.PI) / 180) * roofSpan) / 2;
      push("gable", [p.x, 2.1, p.z], rotU, [2.2, roofH, roofSpan], "stone", {
        pitch: 54,
      });
      const door = {
        x: p.x + front.x * 0.65,
        z: p.z + front.z * 0.65,
      };
      push("door", [door.x, 0.45, door.z], faceRot, [0.7, 1.1, 0.18], "wood");
      pushGlow(
        "sigil",
        [p.x + front.x * 0.69, 1.62, p.z + front.z * 0.69],
        faceRot,
        [0.8, SIGIL_W, 1],
      );
    } else if (shrine.kind === "stones") {
      // 立石の環(紋様は内向き=環の中心を向く)
      const count = 6;
      const radius = 2.3;
      const a0 = wardHash(p.x, p.z, 21) * Math.PI * 2;
      for (let i = 0; i < count; i++) {
        const a = a0 + (i / count) * Math.PI * 2;
        const q = {
          x: p.x + Math.cos(a) * radius,
          z: p.z + Math.sin(a) * radius,
        };
        const h = 1.3 + 0.8 * wardHash(q.x, q.z, 22);
        const w = 0.5 + 0.22 * wardHash(q.x, q.z, 23);
        // ローカル +z(平らな面)が環の中心を向く
        const inward = { x: -Math.cos(a), z: -Math.sin(a) };
        const rot = Math.atan2(inward.x, inward.z);
        push("ward-stone", [q.x, 0, q.z], rot, [w, h, w * 0.7], "stone");
        pushGlow(
          "sigil",
          [
            q.x + inward.x * ((w * 0.7) / 2 + 0.04),
            h * 0.3,
            q.z + inward.z * ((w * 0.7) / 2 + 0.04),
          ],
          rot,
          [0.13, h * 0.42, 1],
        );
      }
    } else {
      // 水晶クラスタ: 岩座+中央大水晶+周囲の小水晶
      push("plinth", [p.x, 0, p.z], faceRot, [1.4, 0.35, 1.4], "stone");
      pushGlow(
        "crystal",
        [p.x, 0.3, p.z],
        faceRot + Math.PI / 4,
        [0.85, 1.9, 0.85],
      );
      const count = 3;
      const a0 = wardHash(p.x, p.z, 31) * Math.PI * 2;
      for (let i = 0; i < count; i++) {
        const a = a0 + (i / count) * Math.PI * 2;
        const q = {
          x: p.x + Math.cos(a) * 1.15,
          z: p.z + Math.sin(a) * 1.15,
        };
        const s = 0.4 + 0.25 * wardHash(q.x, q.z, 32);
        push("plinth", [q.x, 0, q.z], a, [s + 0.3, 0.22, s + 0.3], "stone");
        pushGlow("crystal", [q.x, 0.16, q.z], a, [s, s * 2.1, s]);
      }
    }
  }

  // --- 結界壁 / 境界標(同一文法の歩行器)と紋様・水上弧 -----------------
  // 歩行器: wall 弧を辺順に歩き、wardLevel 1 では境界標の点列を、
  // 2 以上では連続壁を落とす(contracts「結界構造の立体化」)
  const stoneSpacing = STONE_SPACING_BASE - STONE_SPACING_CLOSURE * closure;
  const sigilSpacing =
    SIGIL_SPACING_MIN + SIGIL_SPACING_RANGE * (1 - glowIntensity);
  /** 弧長 s の位置(セグメント内の辺リストから) */
  const pointAtArc = (
    ks: number[],
    s: number,
  ): { pos: Vec2; normal: Vec2 } | null => {
    let acc = 0;
    for (const k of ks) {
      const e = edges[k];
      if (!e) continue;
      if (s <= acc + e.len) {
        const t = e.len > 1e-9 ? (s - acc) / e.len : 0;
        return {
          pos: {
            x: e.a.x + (e.b.x - e.a.x) * t,
            z: e.a.z + (e.b.z - e.a.z) * t,
          },
          normal: e.normal,
        };
      }
      acc += e.len;
    }
    return null;
  };

  interface WallSigil {
    pos: Vec2;
    normal: Vec2;
    h: number;
    /** 取り付け面までの外向きオフセット(境界標は個体の奥行き依存) */
    off: number;
  }
  const wallSigils: WallSigil[] = [];
  const stoneSigils: WallSigil[] = [];

  for (const seg of wards.ringSegments) {
    if (seg.kind === "overwater") continue; // 後段(水上弧)
    if (seg.kind !== "wall") continue;
    const ks: number[] = [];
    let arcLen = 0;
    for (let k = seg.start; k < seg.end; k++) {
      const e = edges[k % n];
      if (!e) continue;
      ks.push(k % n);
      arcLen += e.len;
    }
    if (arcLen < 1e-6) continue;

    if (wards.wardLevel === 1) {
      // 縮退形: 境界標の点列(発光紋様を持つ立石)
      for (let s = stoneSpacing / 2; s < arcLen; s += stoneSpacing) {
        const at = pointAtArc(ks, s);
        if (!at) continue;
        const h = 1.5 + 0.9 * wardHash(at.pos.x, at.pos.z, 41);
        const w = 0.52 + 0.26 * wardHash(at.pos.x, at.pos.z, 42);
        const rot = Math.atan2(at.normal.x, at.normal.z);
        push(
          "ward-stone",
          [at.pos.x, 0, at.pos.z],
          rot,
          [w, h, w * 0.7],
          "stone",
        );
        stoneSigils.push({
          pos: at.pos,
          normal: at.normal,
          h,
          off: (w * 0.7) / 2 + 0.04,
        });
      }
    } else {
      // 連続壁: 辺ごとに基部+壁体+頂縁のセグメント
      for (const k of ks) {
        const e = edges[k];
        if (!e || e.len < 1e-6) continue;
        const jitter = 1 + 0.08 * (wardHash(e.mid.x, e.mid.z, 43) - 0.5);
        push(
          "ward-wall",
          [e.mid.x, 0, e.mid.z],
          -e.angle,
          [e.len + WALL_OVERLAP, wallH * jitter, WALL_THICKNESS],
          "stone",
        );
      }
      // 壁面の発光紋様ライン(間隔規則。外面+内面)
      for (let s = sigilSpacing / 2; s < arcLen; s += sigilSpacing) {
        const at = pointAtArc(ks, s);
        if (!at) continue;
        wallSigils.push({
          pos: at.pos,
          normal: at.normal,
          h: wallH,
          off: WALL_THICKNESS / 2 + 0.04,
        });
      }
    }
  }

  // 境界標の紋様(予算順: 壁紋様より先)
  for (const sg of stoneSigils) {
    if (
      !pushGlow(
        "sigil",
        [
          sg.pos.x + sg.normal.x * sg.off,
          sg.h * 0.3,
          sg.pos.z + sg.normal.z * sg.off,
        ],
        Math.atan2(sg.normal.x, sg.normal.z),
        [0.13, sg.h * 0.42, 1],
      )
    ) {
      break;
    }
  }

  // --- 魔法灯(柱+火屋。予算順: 境界標の次・壁紋様より先) ---
  // 火屋は柱天板の少し上に浮く発光八面体(ward-glow-crystals の
  // インスタンス。上下動なし)。予算不足で火屋を置けない灯は柱ごと置かない
  const lampMaterial = derived.roadGrade >= LAMP_STONE_GRADE ? "stone" : "wood";
  for (const lamp of wards.lamps) {
    const p = lamp.position;
    const jitter = 1 + 0.1 * (wardHash(p.x, p.z, 51) - 0.5);
    const postH = LAMP_POST_H * jitter;
    const phase = (hashString(lamp.id) / 4294967296) * Math.PI * 2;
    const placed = pushGlowInstance(lampHeads, {
      position: [p.x, postH + LAMP_HEAD_GAP, p.z],
      rotation: wardHash(p.x, p.z, 52) * Math.PI * 0.5 + Math.PI / 4,
      scale: [LAMP_HEAD_W, LAMP_HEAD_H, LAMP_HEAD_W],
      phase,
      amp: 0,
    });
    if (!placed) continue;
    push(
      "lamp-post",
      [p.x, 0, p.z],
      wardHash(p.x, p.z, 53) * Math.PI * 2,
      [LAMP_POST_W, postH, LAMP_POST_W],
      lampMaterial,
    );
  }

  // --- 浮遊要素(水晶=発光 / 浮石=非発光) --------------------------------
  // basePosition は浮遊の中心(立体の底 = y − 高さ/2)。上下動は
  // ビューワーの時間 uniform、位相は floater.id のハッシュ由来。
  // 水晶が予算に収まらない場合は浮石へフォールバック(個数は保つ)
  for (const f of wards.floaters) {
    const b = f.basePosition;
    const phase = (hashString(f.id) / 4294967296) * Math.PI * 2;
    const amp =
      FLOATER_AMP_MIN + FLOATER_AMP_RANGE * wardHash(b.x, b.z, 62);
    const wantCrystal = wardHash(b.x, b.z, 61) < FLOATER_CRYSTAL_RATE;
    let placed = false;
    if (wantCrystal) {
      const sy = f.size;
      const sxz = f.size * 0.62;
      placed = pushGlowInstance(floatCrystals, {
        position: [b.x, b.y - sy / 2, b.z],
        rotation: wardHash(b.x, b.z, 63) * Math.PI * 2,
        scale: [sxz, sy, sxz],
        phase,
        amp,
      });
    }
    if (!placed) {
      const sy = f.size * 0.7;
      const sxz = f.size * 0.85;
      floatStones.push({
        position: [b.x, b.y - sy / 2, b.z],
        rotation: wardHash(b.x, b.z, 64) * Math.PI * 2,
        scale: [sxz, sy, sxz],
        phase,
        amp,
      });
    }
  }

  // 壁の紋様ライン(外面・内面)
  wallGlow: for (const sg of wallSigils) {
    const bandH = Math.min(1.35, sg.h * 0.42);
    const y = sg.h * 0.3;
    for (const side of [1, -1]) {
      const off = sg.off * side;
      if (
        !pushGlow(
          "sigil",
          [sg.pos.x + sg.normal.x * off, y, sg.pos.z + sg.normal.z * off],
          Math.atan2(sg.normal.x * side, sg.normal.z * side),
          [SIGIL_W, bandH, 1],
        )
      ) {
        break wallGlow;
      }
    }
  }

  // 水上結界: 壁体を持たない発光ラインの弧(外面+内面)
  waterGlow: for (const seg of wards.ringSegments) {
    if (seg.kind !== "overwater") continue;
    for (let k = seg.start; k < seg.end; k++) {
      const e = edges[k % n];
      if (!e || e.len < 1e-6) continue;
      for (const side of [1, -1]) {
        if (
          !pushGlow(
            "sigil",
            [e.mid.x, WATER_ARC_Y, e.mid.z],
            Math.atan2(e.normal.x * side, e.normal.z * side),
            [e.len + 0.1, WATER_ARC_H, 1],
          )
        ) {
          break waterGlow;
        }
      }
    }
  }

  return { parts, glowArea, glowBudget, lampHeads, floatCrystals, floatStones };
}
