/**
 * 橋(石造アーチ橋・木橋・水路の小橋)の Part 展開(PHASE 5b commit 18。
 * contracts/wards.md「魔法灯・浮遊要素・橋の立体化」が正)。
 *
 * 設計判断: 展開は water.bridges / network / derived から一意に決まる
 * **表示写像**であり、新しい計画内容を持たないため、パイプラインではなく
 * メッシュ層の純関数として置く(commit 17 の wardparts と同じ流儀)。
 * WorldModel には書き戻さない(正規化ハッシュは PHASE 5a から不変)。
 * 本ファイルは three 非依存とし、両岸接続・桁下端・橋脚到達・決定性の
 * テストが three を経由せず機械検証できる(contracts/pipeline.md)。
 *
 * - 乱数ストリームは消費しない。個体差・採択は位置ハッシュ由来
 * - 河川・湖の渡り区間の標本化は道路リボン(mesh/paving.ts)と同一の
 *   waterCrossings(edge.path, field.waterSdf, ROAD_WATER_SAMPLE_STEP) を
 *   共用し、取り付きに隙間を出さない。道路リボンの基準高
 *   (roadBaseY)と水路上の持ち上げ(canalLiftAt)も本ファイルを正とする
 * - Part は mesh/buildings.ts の既存の束(躯体マージ・building-trim・
 *   building-piles)へ合流する(draw call は増えない)
 */
import type { BridgeSite, Part, Vec2, WorldModel } from "../model/worldmodel";
import {
  SHORE_SKIRT_BOTTOM_Y,
  WATER_SURFACE_Y,
} from "../model/worldmodel";
import { pathLength, pointAlong, waterCrossings } from "../model/geometry";
import { createWaterField } from "../model/waterfield";

/** 道路リボンの断面の基準値(mesh/paving.ts が共用する。正は本ファイル) */
export const ROAD_SHOULDER_Y = 0.012;
export const ROAD_CROWN = 0.1;
export const ROAD_Y_JITTER = 0.006;
/** 道路リボン・橋抽出の水域標本間隔(waterCrossings と共用) */
export const ROAD_WATER_SAMPLE_STEP = 2.0;
/** 水路上の道路リボンの持ち上げ量の最大(canalLiftAt) */
export const CANAL_ROAD_LIFT = 0.22;
/** 水路の水面高(mesh/paving.ts CANAL_WATER_Y と同値。桁下端の検証基準) */
export const CANAL_WATER_SURFACE_Y = 0.04;

/** 橋床天端と道路リボン中央の接合オフセット(Z ファイティング回避。契約) */
const DECK_TOP_LIP = 0.02;
/** 橋床の厚みとセグメントの継ぎ目重なり・張り出し */
const DECK_THICKNESS = 0.34;
const DECK_OVERLAP = 0.35;
const DECK_SIDE_EXTRA = 0.5;
const DECK_STEP = 2.4;
/** 取り付き(渡り区間から陸へ延長する長さ) */
const ABUTMENT_REACH = 0.9;
/** 石造アーチの目標支間と連数の上限 */
const ARCH_TARGET_SPAN = 8;
const ARCH_MAX_COUNT = 6;
/** 石の低欄(笠付き)の寸法 */
const PARAPET_H = 0.6;
const PARAPET_T = 0.26;
/** 木橋: 桁の深さ(下端は水面より上に保つ)と杭橋脚の間隔・杭幅 */
const GIRDER_DEPTH = 0.3;
const GIRDER_CLEAR = 0.14; // 桁下端の水面からの最小クリアランス
const PIER_SPACING = 5.5;
const PIER_PILE_SIZE = 0.28;
/** 木の欄干: 柱の間隔・寸法と手すり */
const RAIL_POST_SPACING = 2.2;
const RAIL_POST_W = 0.13;
const RAIL_H = 0.82;
const RAIL_BAR = 0.09;
/** 水路の小橋: 桁の下端・上端(リボンの lift された下縁を受ける) */
const CANAL_GIRDER_BOTTOM = 0.12;
const CANAL_GIRDER_TOP = 0.3;
/** 橋上小建築の採択条件(契約) */
const HUT_MIN_LENGTH = 14;
const HUT_MIN_CANAL_SCORE = 0.45;
/** 石造橋の材の選択(main × roadGrade ≥ 0.9 で石造。契約の対応表) */
const STONE_BRIDGE_GRADE = 0.9;

/** 文字列ハッシュ(FNV-1a 縮小版)。edge 毎の道路基準高に使う */
function hashStringFnv(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * 道路リボンの基準高(路肩基準+edge 毎の微小オフセット)。
 * mesh/paving.ts の道路リボンと橋床が同じ関数を共用する(正は本ファイル)。
 */
export function roadBaseY(edgeId: string): number {
  return ROAD_SHOULDER_Y + (hashStringFnv(edgeId) % 5) * ROAD_Y_JITTER;
}

function smoothstep01(t: number): number {
  const k = Math.min(1, Math.max(0, t));
  return k * k * (3 - 2 * k);
}

/**
 * 水路上の道路リボンの持ち上げ量(水路の水面 +0.04 との交差回避)。
 * mesh/paving.ts のリボンと小橋の桁・欄干が同じ形状を共用する。
 */
export function canalLiftAt(
  canalBridges: readonly BridgeSite[],
  x: number,
  z: number,
): number {
  let lift = 0;
  for (const b of canalBridges) {
    const d = Math.hypot(x - b.position.x, z - b.position.z);
    const reach = b.length / 2 + 2.5;
    lift = Math.max(
      lift,
      CANAL_ROAD_LIFT * (1 - smoothstep01((d - reach * 0.4) / reach)),
    );
  }
  return lift;
}

/** 位置ハッシュ(0〜1)。乱数ストリームを消費しない決定論的な採択・個体差 */
function bridgeHash(x: number, z: number, salt: number): number {
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

export type BridgeKind = "stone-arch" | "wood" | "canal-stone" | "canal-wood";

/** 橋 1 基の検証用サマリー(テストが機械検証する契約値) */
export interface BridgeBuildInfo {
  id: string;
  kind: BridgeKind;
  edgeId: string | null;
  /** 橋床天端(= roadBaseY + ROAD_CROWN + 0.02。水路の小橋はリボンが床) */
  deckTopY: number | null;
  /** 取り付き端点(陸上。道路リボンの続き) */
  deckEnds: [Vec2, Vec2];
  /** 水面上の部材(桁・橋床)の最下端 */
  girderBottomY: number;
  /** 橋脚(arch 脚・杭)の下端。無橋脚(水路の小橋)は null */
  pierBottomY: number | null;
}

export interface BridgeExpansion {
  parts: Part[];
  bridges: BridgeBuildInfo[];
}

/** Part 生成のショートハンド */
function makePart(
  type: string,
  position: [number, number, number],
  rotation: number,
  scale: [number, number, number],
  materialId: string,
  params?: Record<string, number>,
): Part {
  const part: Part = { type, transform: { position, rotation, scale }, materialId };
  if (params) part.params = params;
  return part;
}

/** 折れ線上の弧長 s の左法線付きフレーム */
function frameAt(
  path: Vec2[],
  s: number,
): { p: Vec2; angle: number; left: Vec2 } {
  const { p, angle } = pointAlong(path, s);
  return { p, angle, left: { x: -Math.sin(angle), z: Math.cos(angle) } };
}

/** 欄干(木): 柱+手すりを両縁に張る(木橋・水路の小橋で共用) */
function woodRailing(
  parts: Part[],
  path: Vec2[],
  s0: number,
  s1: number,
  halfWidth: number,
  topAt: (s: number) => number,
): void {
  const len = s1 - s0;
  if (len <= 0.5) return;
  const postCount = Math.max(2, Math.round(len / RAIL_POST_SPACING) + 1);
  for (const side of [1, -1]) {
    for (let i = 0; i < postCount; i++) {
      const s = s0 + (len * i) / (postCount - 1);
      const f = frameAt(path, s);
      const base = topAt(s);
      parts.push(
        makePart(
          "beam",
          [
            f.p.x + f.left.x * halfWidth * side,
            base,
            f.p.z + f.left.z * halfWidth * side,
          ],
          -f.angle,
          [RAIL_POST_W, RAIL_H, RAIL_POST_W],
          "wood",
        ),
      );
    }
    // 手すり: 柱間ごとの直線セグメント(経路の曲がりに追従)
    for (let i = 0; i + 1 < postCount; i++) {
      const sa = s0 + (len * i) / (postCount - 1);
      const sb = s0 + (len * (i + 1)) / (postCount - 1);
      const fa = frameAt(path, sa);
      const fb = frameAt(path, sb);
      const ax = fa.p.x + fa.left.x * halfWidth * side;
      const az = fa.p.z + fa.left.z * halfWidth * side;
      const bx = fb.p.x + fb.left.x * halfWidth * side;
      const bz = fb.p.z + fb.left.z * halfWidth * side;
      const segLen = Math.hypot(bx - ax, bz - az);
      if (segLen < 1e-6) continue;
      const yTop = Math.max(topAt(sa), topAt(sb)) + RAIL_H - RAIL_BAR;
      parts.push(
        makePart(
          "beam",
          [(ax + bx) / 2, yTop, (az + bz) / 2],
          -Math.atan2(bz - az, bx - ax),
          [segLen + RAIL_POST_W, RAIL_BAR, RAIL_BAR],
          "wood",
        ),
      );
    }
  }
}

/** 石の低欄(笠付き低い胸壁ではない欄): fence セグメントを両縁に張る */
function stoneParapet(
  parts: Part[],
  path: Vec2[],
  s0: number,
  s1: number,
  halfWidth: number,
  deckTopY: number,
): void {
  const len = s1 - s0;
  if (len <= 0.5) return;
  const count = Math.max(1, Math.round(len / DECK_STEP));
  for (const side of [1, -1]) {
    for (let i = 0; i < count; i++) {
      const sa = s0 + (len * i) / count;
      const sb = s0 + (len * (i + 1)) / count;
      const fa = frameAt(path, sa);
      const fb = frameAt(path, sb);
      const ax = fa.p.x + fa.left.x * halfWidth * side;
      const az = fa.p.z + fa.left.z * halfWidth * side;
      const bx = fb.p.x + fb.left.x * halfWidth * side;
      const bz = fb.p.z + fb.left.z * halfWidth * side;
      const segLen = Math.hypot(bx - ax, bz - az);
      if (segLen < 1e-6) continue;
      parts.push(
        makePart(
          "fence",
          [(ax + bx) / 2, deckTopY, (az + bz) / 2],
          -Math.atan2(bz - az, bx - ax),
          [segLen + 0.2, PARAPET_H, PARAPET_T],
          "stone",
        ),
      );
    }
  }
}

/** 橋床: 経路に沿った箱セグメント列(plinth 再利用) */
function deckSegments(
  parts: Part[],
  path: Vec2[],
  s0: number,
  s1: number,
  width: number,
  deckTopY: number,
  materialId: string,
): void {
  const len = s1 - s0;
  const count = Math.max(1, Math.round(len / DECK_STEP));
  for (let i = 0; i < count; i++) {
    const sa = s0 + (len * i) / count;
    const sb = s0 + (len * (i + 1)) / count;
    const a = pointAlong(path, sa).p;
    const b = pointAlong(path, sb).p;
    const segLen = Math.hypot(b.x - a.x, b.z - a.z);
    if (segLen < 1e-6) continue;
    parts.push(
      makePart(
        "plinth",
        [(a.x + b.x) / 2, deckTopY - DECK_THICKNESS, (a.z + b.z) / 2],
        -Math.atan2(b.z - a.z, b.x - a.x),
        [segLen + DECK_OVERLAP, DECK_THICKNESS, width],
        materialId,
      ),
    );
  }
}

/** 橋上小建築: 橋央・片側張り出しの小屋(運河都市の気配。確率的) */
function bridgeHut(
  parts: Part[],
  path: Vec2[],
  sMid: number,
  halfWidth: number,
  deckTopY: number,
): void {
  const f = frameAt(path, sMid);
  const side = bridgeHash(f.p.x, f.p.z, 73) < 0.5 ? 1 : -1;
  const off = halfWidth - 0.4;
  const cx = f.p.x + f.left.x * off * side;
  const cz = f.p.z + f.left.z * off * side;
  const rot = -f.angle;
  const w = 2.4; // 棟方向(道路方向)
  const d = 2.0;
  const wallH = 2.3;
  parts.push(
    makePart("plinth", [cx, deckTopY, cz], rot, [w + 0.3, 0.18, d + 0.3], "stone"),
    makePart("wall", [cx, deckTopY + 0.18, cz], rot, [w, wallH, d], "plaster"),
  );
  const roofSpan = d + 0.8;
  const roofH = (Math.tan((52 * Math.PI) / 180) * roofSpan) / 2;
  parts.push(
    makePart(
      "gable",
      [cx, deckTopY + 0.18 + wallH, cz],
      rot,
      [w + 0.7, roofH, roofSpan],
      "shingle",
    ),
  );
  // 道路側を向く小窓 1 つ(開口部品の変換規約: ローカル +z = 外向き法線)
  const inX = f.left.x * -side;
  const inZ = f.left.z * -side;
  parts.push(
    makePart(
      "window",
      [
        cx + inX * (d / 2),
        deckTopY + 0.18 + 1.05,
        cz + inZ * (d / 2),
      ],
      Math.atan2(inX, inZ),
      [0.7, 0.9, 0.16],
      "wood",
    ),
  );
}

/** 河川・湖の橋 1 基(渡り区間 1 つ)を展開する */
function expandRiverBridge(
  parts: Part[],
  model: WorldModel,
  edge: WorldModel["network"]["edges"][number],
  sStart: number,
  sEnd: number,
  total: number,
): BridgeBuildInfo {
  const { derived } = model.meta;
  const path = edge.path;
  const stone = edge.class === "main" && derived.roadGrade >= STONE_BRIDGE_GRADE;
  const kind: BridgeKind = stone ? "stone-arch" : "wood";
  const width = edge.width + DECK_SIDE_EXTRA;
  const deckTopY = roadBaseY(edge.id) + ROAD_CROWN + DECK_TOP_LIP;
  const deckBottomY = deckTopY - DECK_THICKNESS;
  const s0 = Math.max(0, sStart - ABUTMENT_REACH);
  const s1 = Math.min(total, sEnd + ABUTMENT_REACH);
  const midPoint = pointAlong(path, (sStart + sEnd) / 2).p;

  // 橋床(材: 石造は石、木橋は木部)
  deckSegments(parts, path, s0, s1, width, deckTopY, stone ? "stone" : "wood");

  // 取り付き座(両袂の陸側。橋床下端を受ける)
  for (const s of [s0, s1]) {
    const f = frameAt(path, s);
    parts.push(
      makePart(
        "plinth",
        [f.p.x, -0.4, f.p.z],
        -f.angle,
        [1.5, deckBottomY + 0.4 + 0.05, width + 0.7],
        "stone",
      ),
    );
  }

  let girderBottomY = deckBottomY;
  let pierBottomY: number | null = null;

  if (stone) {
    // 石造アーチ橋: 渡り区間を等分した arch 列。脚が橋脚(水底 -1.6 到達)
    const wetLen = sEnd - sStart;
    const archCount = Math.max(
      1,
      Math.min(ARCH_MAX_COUNT, Math.round(wetLen / ARCH_TARGET_SPAN)),
    );
    const archH = deckBottomY + 0.06 - SHORE_SKIRT_BOTTOM_Y;
    for (let i = 0; i < archCount; i++) {
      const sa = sStart + (wetLen * i) / archCount;
      const sb = sStart + (wetLen * (i + 1)) / archCount;
      const a = pointAlong(path, sa).p;
      const b = pointAlong(path, sb).p;
      const segLen = Math.hypot(b.x - a.x, b.z - a.z);
      if (segLen < 1e-6) continue;
      const open = Math.min(0.88, Math.max(0.45, (segLen - 2.2) / segLen));
      parts.push(
        makePart(
          "arch",
          [(a.x + b.x) / 2, SHORE_SKIRT_BOTTOM_Y, (a.z + b.z) / 2],
          -Math.atan2(b.z - a.z, b.x - a.x),
          [segLen + 0.15, archH, width + 0.3],
          "stone",
          { open, rise: 0.95 },
        ),
      );
    }
    pierBottomY = SHORE_SKIRT_BOTTOM_Y;
    stoneParapet(parts, path, s0, s1, width / 2 + 0.05, deckTopY);

    // 橋上小建築(canalScore 高 × 大きめの橋。確率的)
    if (
      wetLen >= HUT_MIN_LENGTH &&
      derived.canalScore >= HUT_MIN_CANAL_SCORE &&
      bridgeHash(midPoint.x, midPoint.z, 71) <
        Math.min(0.8, Math.max(0, (derived.canalScore - 0.3) * 1.2))
    ) {
      bridgeHut(parts, path, (sStart + sEnd) / 2, width / 2 + 0.5, deckTopY);
    }
  } else {
    // 木橋: 両縁の桁(下端は水面より上)+杭橋脚+木の欄干
    girderBottomY = Math.max(
      WATER_SURFACE_Y + GIRDER_CLEAR,
      deckBottomY - GIRDER_DEPTH,
    );
    const girderH = deckBottomY + 0.06 - girderBottomY;
    const len = s1 - s0;
    const count = Math.max(1, Math.round(len / DECK_STEP));
    for (const side of [1, -1]) {
      for (let i = 0; i < count; i++) {
        const sa = s0 + (len * i) / count;
        const sb = s0 + (len * (i + 1)) / count;
        const fa = frameAt(path, sa);
        const fb = frameAt(path, sb);
        const off = width / 2 - 0.2;
        const ax = fa.p.x + fa.left.x * off * side;
        const az = fa.p.z + fa.left.z * off * side;
        const bx = fb.p.x + fb.left.x * off * side;
        const bz = fb.p.z + fb.left.z * off * side;
        const segLen = Math.hypot(bx - ax, bz - az);
        if (segLen < 1e-6) continue;
        parts.push(
          makePart(
            "plinth",
            [(ax + bx) / 2, girderBottomY, (az + bz) / 2],
            -Math.atan2(bz - az, bx - ax),
            [segLen + DECK_OVERLAP, girderH, 0.3],
            "wood",
          ),
        );
      }
    }
    // 杭橋脚(支間ごとに 2 本組。水底 -1.6 から橋床下端へ)
    const wetLen = sEnd - sStart;
    const pierCount = Math.max(0, Math.round(wetLen / PIER_SPACING));
    for (let i = 1; i <= pierCount; i++) {
      const s = sStart + (wetLen * i) / (pierCount + 1);
      const f = frameAt(path, s);
      for (const side of [1, -1]) {
        const off = width / 2 - 0.45;
        parts.push(
          makePart(
            "pile",
            [
              f.p.x + f.left.x * off * side,
              SHORE_SKIRT_BOTTOM_Y,
              f.p.z + f.left.z * off * side,
            ],
            -f.angle,
            [
              PIER_PILE_SIZE,
              deckBottomY + 0.1 - SHORE_SKIRT_BOTTOM_Y,
              PIER_PILE_SIZE,
            ],
            "wood",
          ),
        );
      }
    }
    if (pierCount > 0) pierBottomY = SHORE_SKIRT_BOTTOM_Y;
    woodRailing(parts, path, s0, s1, width / 2 + 0.02, () => deckTopY);
  }

  return {
    id: `bridge-mesh/${edge.id}/${sStart.toFixed(1)}`,
    kind,
    edgeId: edge.id,
    deckTopY,
    deckEnds: [pointAlong(path, s0).p, pointAlong(path, s1).p],
    girderBottomY,
    pierBottomY,
  };
}

/** 水路の小橋: リボンの下縁を受ける桁+欄干+両袂の取り付き座 */
function expandCanalBridge(
  parts: Part[],
  model: WorldModel,
  site: BridgeSite,
  canalBridges: readonly BridgeSite[],
): BridgeBuildInfo {
  const { derived } = model.meta;
  const stone = derived.roadGrade >= STONE_BRIDGE_GRADE;
  const kind: BridgeKind = stone ? "canal-stone" : "canal-wood";
  const dir = { x: Math.cos(site.angle), z: Math.sin(site.angle) };
  const left = { x: -dir.z, z: dir.x };
  const halfLen = site.length / 2 + 0.8;
  const halfW = site.width / 2 + 0.05;
  const girderMat = stone ? "stone" : "wood";
  const p = site.position;

  // 疑似パス(直線): 欄干・桁の配置に使う(渡りは短く直線的)
  const path: Vec2[] = [
    { x: p.x - dir.x * halfLen, z: p.z - dir.z * halfLen },
    { x: p.x + dir.x * halfLen, z: p.z + dir.z * halfLen },
  ];

  // 桁(両縁): リボンの lift された下縁を受ける。下端は水路水面より上
  for (const side of [1, -1]) {
    parts.push(
      makePart(
        "plinth",
        [
          p.x + left.x * halfW * side,
          CANAL_GIRDER_BOTTOM,
          p.z + left.z * halfW * side,
        ],
        -site.angle,
        [halfLen * 2, CANAL_GIRDER_TOP - CANAL_GIRDER_BOTTOM, 0.3],
        girderMat,
      ),
    );
  }

  // 両袂の取り付き座(陸側。桁の端を受ける)
  for (const sign of [1, -1]) {
    parts.push(
      makePart(
        "plinth",
        [p.x + dir.x * halfLen * sign, 0, p.z + dir.z * halfLen * sign],
        -site.angle,
        [1.1, CANAL_GIRDER_TOP + 0.04, site.width + 0.8],
        "stone",
      ),
    );
  }

  // 欄干: リボン表面(路肩基準+lift)から立てる。石は桁天端の低欄
  const surfaceAt = (s: number): number => {
    const q = pointAlong(path, s).p;
    return (
      ROAD_SHOULDER_Y + ROAD_CROWN * 0.8 + canalLiftAt(canalBridges, q.x, q.z)
    );
  };
  if (stone) {
    stoneParapet(
      parts,
      path,
      0,
      halfLen * 2,
      halfW + PARAPET_T / 2,
      CANAL_GIRDER_TOP,
    );
  } else {
    woodRailing(parts, path, 0, halfLen * 2, halfW + RAIL_POST_W / 2, surfaceAt);
  }

  return {
    id: site.id,
    kind,
    edgeId: null,
    deckTopY: null,
    deckEnds: [path[0] as Vec2, path[1] as Vec2],
    girderBottomY: CANAL_GIRDER_BOTTOM,
    pierBottomY: null,
  };
}

/** 橋一式を Part 列へ展開する(contracts/wards.md が正) */
export function expandBridgeParts(model: WorldModel): BridgeExpansion {
  const parts: Part[] = [];
  const bridges: BridgeBuildInfo[] = [];

  // 河川・湖の橋: 道路リボンと同一の標本化で渡り区間を検出する
  const field = createWaterField(
    model.ground.boundary,
    model.water.rivers,
    model.water.lakes,
  );
  for (const edge of model.network.edges) {
    const total = pathLength(edge.path);
    if (total <= 0) continue;
    const crossings = waterCrossings(
      edge.path,
      field.waterSdf,
      ROAD_WATER_SAMPLE_STEP,
    );
    for (const c of crossings) {
      if (c.length < 1.0) continue; // 標本化の際(きわ)のごく短い区間は橋にしない
      bridges.push(
        expandRiverBridge(parts, model, edge, c.sStart, c.sEnd, total),
      );
    }
  }

  // 水路の小橋: BridgeSite(over "canal")から(リボンの lift と同じ正)
  const canalSites = model.water.bridges.filter((b) => b.over === "canal");
  for (const site of canalSites) {
    bridges.push(expandCanalBridge(parts, model, site, canalSites));
  }

  return { parts, bridges };
}
