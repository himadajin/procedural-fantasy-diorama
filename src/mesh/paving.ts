/**
 * 舗装・水路のメッシュ: 道路リボン、広場の舗装+縁石、水路の護岸(縁石・
 * 石積み)+杭を WorldModel から生成する(implementation-spec 4章
 * 「大域計画 — 立地・道路網・水路・広場・結界計画」)。
 *
 * - 頂点カラーのみで表現(画像テクスチャ禁止)。色は art-direction 5.2/5.3節
 * - 道路・広場・護岸は単一の MeshStandardMaterial にマージして 1 draw call、
 *   杭は InstancedMesh 1 call に収める(1.8節の draw call 予算)
 * - 水路は地面をクリップしない「重ねる掘り込みチャネル」
 *   (contracts/ground-water.md Water 節)。水面は地面よりわずかに上に置き、
 *   護岸の立ち上がりとの段差で掘り込みを読ませる。水面ジオメトリ自体は
 *   build.ts が湖・池と同じ水面マテリアルへ統合する
 * - 湖・池の渡り区間は岸で止め、橋(mesh/bridgeparts.ts)が同一の
 *   標本化・基準高で受け持つ。魔法灯の足元の
 *   照り返しは頂点カラーへ焼き込む(wardparts の純関数を地面と共用)
 * - 乱数ストリームは消費しない。ムラは位置ハッシュから決定論的に導出する
 */
import * as THREE from "three";
import {
  WATER_SURFACE_Y,
  type Vec2,
  type WorldModel,
} from "../model/worldmodel";
import { pathLength, pointAlong, waterCrossings } from "../model/geometry";
import type { WaterField } from "../model/waterfield";
import {
  CANAL_WATER_SURFACE_Y,
  ROAD_CROWN,
  ROAD_WATER_SAMPLE_STEP,
  canalLiftAt,
  roadBaseY,
} from "./bridgeparts";
import { applyLampTint, createLampTint } from "./wardparts";

/** 道の等級の基準色(art-direction 5.2節): 土 → 砂利 → 石畳 */
const ROAD_DIRT = new THREE.Color("#8a7458");
const ROAD_GRAVEL = new THREE.Color("#9a927f");
const ROAD_COBBLE = new THREE.Color("#7e7c76");
/** 縁石・広場舗装は石畳と共通(5.2節)。護岸の石積み・杭は 5.3節 */
const CURB_COLOR = new THREE.Color("#7e7c76");
const REVETMENT_COLOR = new THREE.Color("#8e8a84");
const PILE_COLOR = new THREE.Color("#5d4a38");
/** 石の目地・下端の焼き込み(5.1節)に合わせた沈み係数 */
const BURN_SHADE = 0.82;

/** 路肩のフェザー(地面へ馴染む張り出し)。基準高・中央の盛り上げ
 * (roadBaseY / ROAD_CROWN)の正は mesh/bridgeparts.ts(橋床と共用) */
const ROAD_FEATHER = 0.55;
/** リボンのサンプリング間隔 */
const ROAD_STEP = 2.6;

/** 広場舗装の高さと縁石の造形 */
const PLAZA_Y = 0.05;
const PLAZA_CURB_HEIGHT = 0.16;
const PLAZA_CURB_WIDTH = 0.34;
const PLAZA_STEP = 2.4;

/** 水路の造形: 水面は地面よりわずかに上、縁石天端は水面 +0.4 前後
 * (contracts/ground-water.md Water 節の設計判断)。水面高そのものは
 * mesh/bridgeparts.ts の CANAL_WATER_SURFACE_Y(橋の桁下端の検証基準と
 * 共用)を使う。 */
const CANAL_WALL_RISE = 0.4;
const CANAL_WALL_DIP = 0.3; // 護岸内面が水面下へ潜る深さ(水際を見せない)
const CANAL_CURB_WIDTH = 0.42;
const CANAL_SKIRT_WIDTH = 0.5; // 縁石の外の土手(地面へ馴染む)
const CANAL_STEP = 2.0;
/** 湖・池へ注ぐ端部で水面高を湖・池へ降ろすランプ幅(waterfield の岸距離) */
const CANAL_MOUTH_RAMP = 7;
/** 杭(towpathSide 側の係留杭)の間隔と寸法 */
const PILE_SPACING = 7.5;
const PILE_SIZE = 0.24;
const PILE_HEIGHT = 0.85;

/** 位置ハッシュ(0〜1)。乱数ストリームを消費しない決定論的なムラの元 */
export function hash2(x: number, z: number): number {
  let h =
    (Math.imul(Math.round(x * 8) | 0, 0x9e3779b1) ^
      Math.imul(Math.round(z * 8) | 0, 0x85ebca77)) >>>
    0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  // XOR は符号付き 32bit を返すため必ず符号なしへ戻す(0〜1 の契約)
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967296;
}

function smoothstep01(t: number): number {
  const k = Math.min(1, Math.max(0, t));
  return k * k * (3 - 2 * k);
}

/**
 * 等級 0〜2 → 土/砂利/石畳の補間色(5.2節)。
 * zoneMask の paved チャネル(derived.roadGrade)と道路リボン(edge.grade)が
 * 同じ写像を共有する(contracts/ground-water.md ZoneMask 節)。
 */
export function gradeColor(grade: number): THREE.Color {
  const g = Math.min(2, Math.max(0, grade));
  const out = new THREE.Color();
  if (g <= 1) out.lerpColors(ROAD_DIRT, ROAD_GRAVEL, g);
  else out.lerpColors(ROAD_GRAVEL, ROAD_COBBLE, g - 1);
  return out;
}

/** マージ用のジオメトリバッファ */
interface GeoBuffer {
  positions: number[];
  colors: number[];
  normals: number[];
  indices: number[];
}

function pushVertex(
  buf: GeoBuffer,
  x: number,
  y: number,
  z: number,
  n: [number, number, number],
  c: THREE.Color,
  shade: number,
): number {
  const idx = buf.positions.length / 3;
  buf.positions.push(x, y, z);
  buf.normals.push(n[0], n[1], n[2]);
  buf.colors.push(c.r * shade, c.g * shade, c.b * shade);
  return idx;
}

/**
 * 四角形 a-b-c-d(a→b が進行方向、b→c が横断方向)を2三角形で張る。
 * xz 平面で shoelace 負(時計回り)の並びが法線 +y(waterfield.ts と同規約)。
 * 呼び出し側が正しい向きで渡す。
 */
function pushQuad(buf: GeoBuffer, a: number, b: number, c: number, d: number): void {
  buf.indices.push(a, b, c, a, c, d);
}

/** 折れ線の各点の進行方向と左法線(+90度)を返す */
function pathFrames(points: Vec2[]): { dir: Vec2; left: Vec2 }[] {
  const frames: { dir: Vec2; left: Vec2 }[] = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[Math.max(0, i - 1)];
    const b = points[Math.min(points.length - 1, i + 1)];
    if (!a || !b) {
      frames.push({ dir: { x: 1, z: 0 }, left: { x: 0, z: 1 } });
      continue;
    }
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len = Math.hypot(dx, dz) || 1;
    const dir = { x: dx / len, z: dz / len };
    frames.push({ dir, left: { x: -dir.z, z: dir.x } });
  }
  return frames;
}

/** 弧長 step ごとの等間隔リサンプル(端点保持) */
function resample(points: Vec2[], step: number): Vec2[] {
  const total = pathLength(points);
  if (total <= 0 || points.length < 2) return points.slice();
  const count = Math.max(1, Math.round(total / step));
  const out: Vec2[] = [];
  for (let i = 0; i <= count; i++) {
    out.push(pointAlong(points, (i / count) * total).p);
  }
  return out;
}

/** 頂点カラーの明度ムラ(位置ハッシュ)。tidiness が高いほど整う */
function shadeAt(x: number, z: number, tidiness: number): number {
  const amp = 0.07 * (1 - 0.55 * tidiness);
  return 1 + amp * (hash2(x, z) * 2 - 1);
}

/**
 * 道路リボン: edge.path 沿いの幅 edge.width のリボン。
 * - 断面は5点(フェザー/路肩/中央/路肩/フェザー)で、中央を数cm盛り上げる
 * - 等級 grade で土→砂利→石畳の頂点カラー補間
 * - 湖・池を渡る区間は描かず岸で止める(橋の立体は mesh/bridgeparts.ts)。
 *   水路(canal)上は通し、水路橋位置では路面をわずかに持ち上げて
 *   水面(y=+0.04)との交差を避ける
 */
function buildRoads(model: WorldModel, field: WaterField, buf: GeoBuffer): void {
  const tidiness = model.meta.derived.tidiness;
  const canalBridges = model.water.bridges.filter((b) => b.over === "canal");

  for (const edge of model.network.edges) {
    const total = pathLength(edge.path);
    if (total <= 0) continue;
    const half = edge.width / 2;
    const yBase = roadBaseY(edge.id);
    const color = gradeColor(edge.grade);

    // 湖・池を渡る区間(canal は含まない waterSdf)を除いた陸区間。
    // 渡り区間は橋(mesh/bridgeparts.ts)が同一の標本化で受け持つ
    const crossings = waterCrossings(
      edge.path,
      field.waterSdf,
      ROAD_WATER_SAMPLE_STEP,
    );
    const spans: [number, number][] = [];
    let cursor = 0;
    for (const c of crossings) {
      if (c.sStart - cursor > 1.2) spans.push([cursor, c.sStart]);
      cursor = c.sEnd;
    }
    if (total - cursor > 1.2) spans.push([cursor, total]);

    for (const [s0, s1] of spans) {
      const count = Math.max(1, Math.round((s1 - s0) / ROAD_STEP));
      const pts: Vec2[] = [];
      for (let i = 0; i <= count; i++) {
        pts.push(pointAlong(edge.path, s0 + ((s1 - s0) * i) / count).p);
      }
      const frames = pathFrames(pts);
      // 断面: フェザー(-)、路肩(-)、中央、路肩(+)、フェザー(+)
      const offsets = [
        -(half + ROAD_FEATHER),
        -half * 0.72,
        0,
        half * 0.72,
        half + ROAD_FEATHER,
      ];
      const rows: number[][] = [];
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        const f = frames[i];
        if (!p || !f) continue;
        // 水路橋位置では路面を持ち上げる(水路の水面 +0.04 との交差回避。
        // 形状の正は bridgeparts.canalLiftAt。小橋の桁・欄干と共用)
        const lift = canalLiftAt(canalBridges, p.x, p.z);
        const heights = [
          0.004 + lift,
          yBase + ROAD_CROWN * 0.8 + lift,
          yBase + ROAD_CROWN + lift,
          yBase + ROAD_CROWN * 0.8 + lift,
          0.004 + lift,
        ];
        const row: number[] = [];
        for (let k = 0; k < offsets.length; k++) {
          const off = offsets[k] ?? 0;
          const x = p.x + f.left.x * off;
          const z = p.z + f.left.z * off;
          row.push(
            pushVertex(
              buf,
              x,
              heights[k] ?? 0,
              z,
              [0, 1, 0],
              color,
              shadeAt(x, z, tidiness),
            ),
          );
        }
        rows.push(row);
      }
      for (let i = 0; i + 1 < rows.length; i++) {
        const a = rows[i];
        const b = rows[i + 1];
        if (!a || !b) continue;
        for (let k = 0; k + 1 < a.length; k++) {
          // 左(+left)から右へ向かう断面。時計回り(法線 +y)の並びで張る
          pushQuad(
            buf,
            a[k + 1] ?? 0,
            b[k + 1] ?? 0,
            b[k] ?? 0,
            a[k] ?? 0,
          );
        }
      }
    }
  }
}

/**
 * 広場: 舗装ポリゴン(石畳系。Prosperity=tidiness で整う)+縁の低い縁石。
 * 縁石は道路が出入りする区間を欠いて道を通す。
 */
function buildPlazas(model: WorldModel, buf: GeoBuffer): void {
  const tidiness = model.meta.derived.tidiness;
  for (const plaza of model.plazas) {
    if (plaza.polygon.length < 3) continue;
    const center = plaza.position;
    // 舗装: 中心→中間リング→外周の2重リングで頂点カラームラを出す
    const ringPts = resample([...plaza.polygon, plaza.polygon[0] as Vec2], PLAZA_STEP);
    ringPts.pop(); // 閉路の重複端点を除く
    const n = ringPts.length;
    if (n < 3) continue;
    const centerIdx = pushVertex(
      buf,
      center.x,
      PLAZA_Y,
      center.z,
      [0, 1, 0],
      CURB_COLOR,
      shadeAt(center.x, center.z, tidiness),
    );
    const midIdx: number[] = [];
    const outIdx: number[] = [];
    for (const p of ringPts) {
      const mx = center.x + (p.x - center.x) * 0.55;
      const mz = center.z + (p.z - center.z) * 0.55;
      midIdx.push(
        pushVertex(buf, mx, PLAZA_Y, mz, [0, 1, 0], CURB_COLOR, shadeAt(mx, mz, tidiness)),
      );
      outIdx.push(
        pushVertex(
          buf,
          p.x,
          PLAZA_Y * 0.6,
          p.z,
          [0, 1, 0],
          CURB_COLOR,
          shadeAt(p.x, p.z, tidiness) * 0.97,
        ),
      );
    }
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      // ポリゴンは時計回り(contracts)なので、この並びで法線 +y
      buf.indices.push(centerIdx, midIdx[i] ?? 0, midIdx[j] ?? 0);
      pushQuad(buf, midIdx[i] ?? 0, outIdx[i] ?? 0, outIdx[j] ?? 0, midIdx[j] ?? 0);
    }

    // 縁石: 外周に低い段。道路の出入り口は欠く
    const nearEdges = model.network.edges.filter((e) =>
      e.path.some(
        (p) =>
          Math.hypot(p.x - center.x, p.z - center.z) < plaza.radius + e.width + 6,
      ),
    );
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const a = ringPts[i];
      const b = ringPts[j];
      if (!a || !b) continue;
      const mid = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
      let onRoad = false;
      for (const e of nearEdges) {
        let best = Infinity;
        for (let k = 0; k + 1 < e.path.length; k++) {
          const p = e.path[k];
          const q = e.path[k + 1];
          if (!p || !q) continue;
          const dx = q.x - p.x;
          const dz = q.z - p.z;
          const lenSq = dx * dx + dz * dz;
          const t =
            lenSq > 0
              ? Math.min(
                  1,
                  Math.max(0, ((mid.x - p.x) * dx + (mid.z - p.z) * dz) / lenSq),
                )
              : 0;
          best = Math.min(
            best,
            Math.hypot(mid.x - (p.x + dx * t), mid.z - (p.z + dz * t)),
          );
        }
        if (best < e.width / 2 + 1.0) {
          onRoad = true;
          break;
        }
      }
      if (onRoad) continue;
      // 内向き(中心方向)へ PLAZA_CURB_WIDTH の天端を持つ低い縁石
      const inwardA = norm2({ x: center.x - a.x, z: center.z - a.z });
      const inwardB = norm2({ x: center.x - b.x, z: center.z - b.z });
      const shade = shadeAt(mid.x, mid.z, tidiness);
      const topOutA = pushVertex(buf, a.x, PLAZA_CURB_HEIGHT, a.z, [0, 1, 0], CURB_COLOR, shade);
      const topOutB = pushVertex(buf, b.x, PLAZA_CURB_HEIGHT, b.z, [0, 1, 0], CURB_COLOR, shade);
      const topInA = pushVertex(
        buf,
        a.x + inwardA.x * PLAZA_CURB_WIDTH,
        PLAZA_CURB_HEIGHT,
        a.z + inwardA.z * PLAZA_CURB_WIDTH,
        [0, 1, 0],
        CURB_COLOR,
        shade,
      );
      const topInB = pushVertex(
        buf,
        b.x + inwardB.x * PLAZA_CURB_WIDTH,
        PLAZA_CURB_HEIGHT,
        b.z + inwardB.z * PLAZA_CURB_WIDTH,
        [0, 1, 0],
        CURB_COLOR,
        shade,
      );
      // 天端(外→内)。外周は時計回りなので (outA, outB, inB, inA) が法線 +y
      pushQuad(buf, topOutA, topOutB, topInB, topInA);
      // 外面(地面まで)。法線は外向き
      const outwardN: [number, number, number] = [-inwardA.x, 0, -inwardA.z];
      const botOutA = pushVertex(buf, a.x, 0, a.z, outwardN, CURB_COLOR, shade * BURN_SHADE);
      const botOutB = pushVertex(buf, b.x, 0, b.z, outwardN, CURB_COLOR, shade * BURN_SHADE);
      const wallTopA = pushVertex(buf, a.x, PLAZA_CURB_HEIGHT, a.z, outwardN, CURB_COLOR, shade);
      const wallTopB = pushVertex(buf, b.x, PLAZA_CURB_HEIGHT, b.z, outwardN, CURB_COLOR, shade);
      buf.indices.push(wallTopA, botOutA, botOutB, wallTopA, botOutB, wallTopB);
      // 内面(舗装面まで)。法線は内向き
      const inwardN: [number, number, number] = [inwardA.x, 0, inwardA.z];
      const inBotA = pushVertex(
        buf,
        a.x + inwardA.x * PLAZA_CURB_WIDTH,
        PLAZA_Y * 0.6,
        a.z + inwardA.z * PLAZA_CURB_WIDTH,
        inwardN,
        CURB_COLOR,
        shade * BURN_SHADE,
      );
      const inBotB = pushVertex(
        buf,
        b.x + inwardB.x * PLAZA_CURB_WIDTH,
        PLAZA_Y * 0.6,
        b.z + inwardB.z * PLAZA_CURB_WIDTH,
        inwardN,
        CURB_COLOR,
        shade * BURN_SHADE,
      );
      buf.indices.push(topInA, inBotB, inBotA, topInA, topInB, inBotB);
    }
  }
}

function norm2(v: Vec2): Vec2 {
  const len = Math.hypot(v.x, v.z) || 1;
  return { x: v.x / len, z: v.z / len };
}

/** 水路1本ぶんの断面フレーム(水面高・護岸の活性)を求める */
interface CanalFrame {
  p: Vec2;
  left: Vec2;
  dir: Vec2;
  waterY: number;
  /** 護岸・縁石を建てるか(湖・池の中・橋のたもとでは欠く) */
  wall: boolean;
}

function canalFrames(
  model: WorldModel,
  field: WaterField,
  points: Vec2[],
): CanalFrame[] {
  const canalBridges = model.water.bridges.filter((b) => b.over === "canal");
  const pts = resample(points, CANAL_STEP);
  const frames = pathFrames(pts);
  const out: CanalFrame[] = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const f = frames[i];
    if (!p || !f) continue;
    const sdf = field.waterSdf(p.x, p.z);
    // 湖・池へ注ぐ端部では水面高を湖・池の水面へ連続に降ろす(contracts Water 節)
    const t = smoothstep01((sdf - 0.5) / CANAL_MOUTH_RAMP);
    const waterY =
      WATER_SURFACE_Y + 0.05 + (CANAL_WATER_SURFACE_Y - (WATER_SURFACE_Y + 0.05)) * t;
    let wall = sdf > 0.8;
    if (wall) {
      for (const b of canalBridges) {
        if (
          Math.hypot(p.x - b.position.x, p.z - b.position.z) <
          b.width / 2 + 1.4
        ) {
          wall = false;
          break;
        }
      }
    }
    out.push({ p, left: f.left, dir: f.dir, waterY, wall });
  }
  return out;
}

/**
 * 水路の護岸: 縁石(#7e7c76)天端+石積み(#8e8a84)の内面+外の土手。
 * towpathSide 側は土手を広めに取り、岸沿い道(段13「小道」)の余地を残す。
 * 橋位置(over="canal")では護岸を欠き、道路リボンが上を通る。
 */
function buildCanalWalls(
  model: WorldModel,
  field: WaterField,
  buf: GeoBuffer,
): void {
  const tidiness = model.meta.derived.tidiness;
  for (const canal of model.water.canals) {
    const frames = canalFrames(model, field, canal.points);
    const half = canal.width / 2;
    for (const side of [1, -1] as const) {
      // towpathSide 側は外の土手を広めに(岸沿い道の余地)
      const skirt =
        CANAL_SKIRT_WIDTH + (side === canal.towpathSide ? 0.7 : 0);
      let prev: { inB: number; inT: number; curbOut: number; ground: number } | null =
        null;
      for (const fr of frames) {
        if (!fr.wall) {
          prev = null;
          continue;
        }
        const topY = fr.waterY + CANAL_WALL_RISE;
        const off = (d: number): Vec2 => ({
          x: fr.p.x + fr.left.x * side * d,
          z: fr.p.z + fr.left.z * side * d,
        });
        const pIn = off(half);
        const pCurbIn = off(half + 0.12);
        const pCurbOut = off(half + 0.12 + CANAL_CURB_WIDTH);
        const pGround = off(half + 0.12 + CANAL_CURB_WIDTH + skirt);
        const shade = shadeAt(fr.p.x, fr.p.z, tidiness);
        const inwardN: [number, number, number] = [
          -fr.left.x * side,
          0.25,
          -fr.left.z * side,
        ];
        const outwardN: [number, number, number] = [
          fr.left.x * side,
          0.6,
          fr.left.z * side,
        ];
        const inB = pushVertex(
          buf,
          pIn.x,
          fr.waterY - CANAL_WALL_DIP,
          pIn.z,
          inwardN,
          REVETMENT_COLOR,
          shade * BURN_SHADE,
        );
        const inT = pushVertex(buf, pCurbIn.x, topY, pCurbIn.z, inwardN, REVETMENT_COLOR, shade);
        const curbOut = pushVertex(buf, pCurbOut.x, topY, pCurbOut.z, [0, 1, 0], CURB_COLOR, shade);
        const ground = pushVertex(
          buf,
          pGround.x,
          0.004,
          pGround.z,
          outwardN,
          REVETMENT_COLOR,
          shade * 0.92,
        );
        if (prev) {
          // 進行方向 × side で面の向きが決まる。side=+1(左岸)では
          // 内面は右手側を向く。三角形の巻きは side で反転する
          const quad = (
            a0: number,
            a1: number,
            b1: number,
            b0: number,
          ): void => {
            if (side === 1) buf.indices.push(a0, a1, b1, a0, b1, b0);
            else buf.indices.push(a0, b1, a1, a0, b0, b1);
          };
          quad(prev.inB, prev.inT, inT, inB); // 石積みの内面
          quad(prev.inT, prev.curbOut, curbOut, inT); // 縁石の天端
          quad(prev.curbOut, prev.ground, ground, curbOut); // 外の土手
        }
        prev = { inB, inT, curbOut, ground };
      }
    }
  }
}

/**
 * 水路の水面ストリップ(湖・池と同じ水面マテリアルへ統合するための生バッファ)。
 * 色は build.ts 側で湖・池と同じ浅瀬/深みから決めるため、ここでは
 * 位置・縁からの距離(0=縁、1=中央)を返す。
 */
export interface CanalSurface {
  positions: number[]; // x, y, z
  edgeT: number[]; // 0(縁)〜1(中央)
  indices: number[];
  width: number;
}

export function buildCanalSurfaces(
  model: WorldModel,
  field: WaterField,
): CanalSurface[] {
  const out: CanalSurface[] = [];
  for (const canal of model.water.canals) {
    const frames = canalFrames(model, field, canal.points);
    if (frames.length < 2) continue;
    const surf: CanalSurface = { positions: [], edgeT: [], indices: [], width: canal.width };
    const half = canal.width / 2 + 0.06; // 護岸内面の陰へわずかに差し込む
    const rows: number[] = [];
    for (const fr of frames) {
      const base = surf.positions.length / 3;
      // 断面3点: 縁・中央・縁(edgeT は縁 0 → 中央 1)
      for (const [off, t] of [
        [half, 0],
        [0, 1],
        [-half, 0],
      ] as const) {
        surf.positions.push(
          fr.p.x + fr.left.x * off,
          fr.waterY,
          fr.p.z + fr.left.z * off,
        );
        surf.edgeT.push(t);
      }
      rows.push(base);
    }
    for (let i = 0; i + 1 < rows.length; i++) {
      const a = rows[i] ?? 0;
      const b = rows[i + 1] ?? 0;
      // 時計回り(shoelace 負)の並びで法線 +y(waterfield.ts と同規約)
      for (const k of [0, 1]) {
        surf.indices.push(a + k, b + k, b + k + 1, a + k, b + k + 1, a + k + 1);
      }
    }
    out.push(surf);
  }
  return out;
}

/** 杭: towpathSide 側の縁石ぎわに並ぶ係留杭(InstancedMesh 1 call) */
function buildPiles(
  model: WorldModel,
  field: WaterField,
): THREE.InstancedMesh | null {
  const spots: { p: Vec2; angle: number; h: number }[] = [];
  const canalBridges = model.water.bridges.filter((b) => b.over === "canal");
  for (const canal of model.water.canals) {
    const total = pathLength(canal.points);
    const off = canal.width / 2 + 0.12 + CANAL_CURB_WIDTH + 0.28;
    for (let s = PILE_SPACING / 2; s < total; s += PILE_SPACING) {
      const { p, angle } = pointAlong(canal.points, s);
      const left = { x: -Math.sin(angle), z: Math.cos(angle) };
      const q = {
        x: p.x + left.x * canal.towpathSide * off,
        z: p.z + left.z * canal.towpathSide * off,
      };
      if (field.waterSdf(q.x, q.z) < 1.2) continue;
      let nearBridge = false;
      for (const b of canalBridges) {
        if (Math.hypot(q.x - b.position.x, q.z - b.position.z) < b.width / 2 + 1.6) {
          nearBridge = true;
          break;
        }
      }
      if (nearBridge) continue;
      spots.push({
        p: q,
        angle,
        h: PILE_HEIGHT * (0.85 + 0.3 * hash2(q.x, q.z)),
      });
    }
  }
  if (spots.length === 0) return null;

  const geometry = new THREE.BoxGeometry(PILE_SIZE, 1, PILE_SIZE);
  geometry.translate(0, 0.5, 0); // 原点=足元
  const material = new THREE.MeshStandardMaterial({
    color: PILE_COLOR,
    roughness: 0.95,
  });
  const mesh = new THREE.InstancedMesh(geometry, material, spots.length);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  for (let i = 0; i < spots.length; i++) {
    const s = spots[i];
    if (!s) continue;
    q.setFromAxisAngle(up, -s.angle);
    m.compose(
      new THREE.Vector3(s.p.x, 0, s.p.z),
      q,
      new THREE.Vector3(1, s.h, 1),
    );
    mesh.setMatrixAt(i, m);
  }
  mesh.instanceMatrix.needsUpdate = true;
  mesh.name = "canal-piles";
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  return mesh;
}

/**
 * 舗装一式のメッシュを構築する。
 * 戻り値: paving = 道路+広場+護岸のマージ済み 1 メッシュ、
 * piles = 杭の InstancedMesh(なければ null)。
 * 水路の水面は buildCanalSurfaces を build.ts が水面メッシュへ統合する。
 */
export function buildPaving(
  model: WorldModel,
  field: WaterField,
): { paving: THREE.Mesh | null; piles: THREE.InstancedMesh | null } {
  const buf: GeoBuffer = { positions: [], colors: [], normals: [], indices: [] };
  buildRoads(model, field, buf);
  buildPlazas(model, buf);
  buildCanalWalls(model, field, buf);

  // 魔法灯の足元の照り返し(頂点カラー焼き込み。
  // 地面 mesh/build.ts と同じ純関数を共用する)
  applyLampTint(createLampTint(model), buf.positions, buf.colors);

  let paving: THREE.Mesh | null = null;
  if (buf.indices.length > 0) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array(buf.positions), 3),
    );
    geometry.setAttribute(
      "color",
      new THREE.BufferAttribute(new Float32Array(buf.colors), 3),
    );
    geometry.setAttribute(
      "normal",
      new THREE.BufferAttribute(new Float32Array(buf.normals), 3),
    );
    geometry.setIndex(buf.indices);
    paving = new THREE.Mesh(
      geometry,
      new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 }),
    );
    paving.name = "paving";
    paving.receiveShadow = true;
  }

  return { paving, piles: buildPiles(model, field) };
}
