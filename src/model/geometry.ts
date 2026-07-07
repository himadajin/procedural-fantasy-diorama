/**
 * 折れ線・交差の幾何ユーティリティ。
 * pipeline の各段(段5「道路網」・段6「水路」・段8「結界計画」・段9「広場」・
 * 段10「舗装」・段11「区画」・段12「建物」)とメッシュビルダー
 * (道路リボンの水域クリップ)が共有する
 * (waterfield.ts と同じく、絵とデータを同じ純関数から導くための共有実装)。
 * three 非依存・乱数ストリーム非消費の純関数のみ(順序非依存規約)。
 */
import type { Polygon, Vec2 } from "./worldmodel";
import { pointInPolygon, polygonSignedDistance } from "./waterfield";

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/** 折れ線の総弧長 */
export function pathLength(points: Vec2[]): number {
  let len = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (!a || !b) continue;
    len += Math.hypot(b.x - a.x, b.z - a.z);
  }
  return len;
}

/** 折れ線上の弧長 s の位置と方向を返す */
export function pointAlong(points: Vec2[], s: number): { p: Vec2; angle: number } {
  let acc = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (!a || !b) continue;
    const seg = Math.hypot(b.x - a.x, b.z - a.z);
    if (acc + seg >= s || i + 2 === points.length) {
      const t = seg > 1e-9 ? clamp((s - acc) / seg, 0, 1) : 0;
      return {
        p: { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t },
        angle: Math.atan2(b.z - a.z, b.x - a.x),
      };
    }
    acc += seg;
  }
  const lastPoint = points[points.length - 1] ?? { x: 0, z: 0 };
  return { p: lastPoint, angle: 0 };
}

/** Douglas–Peucker による折れ線の間引き(端点は保持) */
export function simplifyPath(points: Vec2[], eps: number): Vec2[] {
  if (points.length <= 2) return points.slice();
  const keep = new Array<boolean>(points.length).fill(false);
  keep[0] = true;
  keep[points.length - 1] = true;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length > 0) {
    const top = stack.pop();
    if (!top) break;
    const [lo, hi] = top;
    const a = points[lo];
    const b = points[hi];
    if (!a || !b || hi - lo < 2) continue;
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len = Math.hypot(dx, dz);
    let worst = -1;
    let worstDist = eps;
    for (let i = lo + 1; i < hi; i++) {
      const p = points[i];
      if (!p) continue;
      const dist =
        len > 1e-9
          ? Math.abs(dx * (p.z - a.z) - dz * (p.x - a.x)) / len
          : Math.hypot(p.x - a.x, p.z - a.z);
      if (dist > worstDist) {
        worstDist = dist;
        worst = i;
      }
    }
    if (worst >= 0) {
      keep[worst] = true;
      stack.push([lo, worst], [worst, hi]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/** Chaikin 平滑化 1回(端点は保持) */
export function chaikin(points: Vec2[]): Vec2[] {
  if (points.length <= 2) return points.slice();
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) return points.slice();
  const out: Vec2[] = [first];
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (!a || !b) continue;
    out.push(
      { x: a.x * 0.75 + b.x * 0.25, z: a.z * 0.75 + b.z * 0.25 },
      { x: a.x * 0.25 + b.x * 0.75, z: a.z * 0.25 + b.z * 0.75 },
    );
  }
  out.push(last);
  return out;
}

/** 折れ線を弧長 step ごとの等間隔点列にリサンプルする(端点は保持) */
export function resamplePath(points: Vec2[], step: number): Vec2[] {
  const total = pathLength(points);
  if (total <= 0 || points.length < 2) return points.slice();
  const count = Math.max(2, Math.ceil(total / step));
  const out: Vec2[] = [];
  for (let i = 0; i <= count; i++) {
    out.push(pointAlong(points, (i / count) * total).p);
  }
  return out;
}

/** 水域(sdf < 0)を渡る区間 */
export interface CrossingInterval {
  /** 渡り区間の中点 */
  position: Vec2;
  /** 中点の進行方向(xz 平面の偏角) */
  angle: number;
  /** 渡り長(水際から水際までの経路長) */
  length: number;
  /** 渡り区間の始端・終端の弧長 */
  sStart: number;
  sEnd: number;
}

/**
 * 折れ線に沿って sdf を標本化し、負(水中)の区間ごとに渡り区間を返す。
 * 水際は隣接標本間の線形補間で確定する。BridgeSite 抽出
 * (contracts/worldmodel.md Water 節)と水路の道路交差カウントの共通実装。
 */
export function waterCrossings(
  path: Vec2[],
  sdf: (x: number, z: number) => number,
  sampleStep: number,
): CrossingInterval[] {
  const total = pathLength(path);
  if (total <= 0) return [];
  const count = Math.max(2, Math.ceil(total / sampleStep));
  const stepS = total / count;
  const samples: { s: number; sdf: number }[] = [];
  for (let i = 0; i <= count; i++) {
    const s = i * stepS;
    const { p } = pointAlong(path, s);
    samples.push({ s, sdf: sdf(p.x, p.z) });
  }

  const crossAt = (i: number): number => {
    // samples[i] と samples[i+1] の間の水際(線形補間)
    const a = samples[i];
    const b = samples[i + 1];
    if (!a || !b) return a?.s ?? 0;
    const d = a.sdf - b.sdf;
    const t = Math.abs(d) > 1e-9 ? a.sdf / d : 0.5;
    return a.s + (b.s - a.s) * clamp(t, 0, 1);
  };

  const crossings: CrossingInterval[] = [];
  let i = 0;
  while (i <= count) {
    if ((samples[i]?.sdf ?? 1) >= 0) {
      i++;
      continue;
    }
    // 渡り区間の開始(直前の標本との間の水際。経路端で始まる場合は 0)
    const sStart = i > 0 ? crossAt(i - 1) : 0;
    while (i <= count && (samples[i]?.sdf ?? 1) < 0) i++;
    const sEnd = i <= count ? crossAt(i - 1) : total;
    const sMid = (sStart + sEnd) / 2;
    const { p, angle } = pointAlong(path, sMid);
    crossings.push({ position: p, angle, length: sEnd - sStart, sStart, sEnd });
  }
  return crossings;
}

/**
 * 線分 ab × cd の交差。交差時は交点と両線分上のパラメータ
 * t(ab 上)・u(cd 上)を返す。平行・区間外は null。
 */
export function segmentIntersection(
  a: Vec2,
  b: Vec2,
  c: Vec2,
  d: Vec2,
): { point: Vec2; t: number; u: number } | null {
  const rx = b.x - a.x;
  const rz = b.z - a.z;
  const sx = d.x - c.x;
  const sz = d.z - c.z;
  const denom = rx * sz - rz * sx;
  if (Math.abs(denom) < 1e-12) return null;
  const qpx = c.x - a.x;
  const qpz = c.z - a.z;
  const t = (qpx * sz - qpz * sx) / denom;
  const u = (qpx * rz - qpz * rx) / denom;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { point: { x: a.x + rx * t, z: a.z + rz * t }, t, u };
}

/** 点 (px, pz) と線分 ab の距離 */
function distPointToSegment(px: number, pz: number, a: Vec2, b: Vec2): number {
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
 * 閉多角形どうしの重なり判定(辺交差+相互の頂点包含)。
 * 凸・凹どちらでも使える。接触(距離 0 ちょうど)は数値誤差の範囲で不定。
 * 段11「区画」の既存区画棄却と段12「建物」の重なりアサーションが共有する。
 */
export function polygonsOverlap(a: Polygon, b: Polygon): boolean {
  if (a.length < 3 || b.length < 3) return false;
  for (let i = 0; i < a.length; i++) {
    const p = a[i];
    const q = a[(i + 1) % a.length];
    if (!p || !q) continue;
    for (let j = 0; j < b.length; j++) {
      const r = b[j];
      const s = b[(j + 1) % b.length];
      if (!r || !s) continue;
      if (segmentIntersection(p, q, r, s)) return true;
    }
  }
  const a0 = a[0];
  const b0 = b[0];
  if (a0 && pointInPolygon(a0.x, a0.z, b)) return true;
  if (b0 && pointInPolygon(b0.x, b0.z, a)) return true;
  return false;
}

/**
 * 線分 ab が閉多角形の clearance 以内にあるか(交差・包含・近接)。
 * 段11「区画」の道路棄却と段12「建物」の道路重なりアサーションが共有する。
 * 2線分間の最短距離はどちらかの端点で達するため、
 * 「辺交差 + 端点↔相手の距離」で網羅できる。
 */
export function segmentNearPolygon(
  a: Vec2,
  b: Vec2,
  polygon: Polygon,
  clearance: number,
): boolean {
  if (polygon.length < 3) return false;
  for (let i = 0; i < polygon.length; i++) {
    const p = polygon[i];
    const q = polygon[(i + 1) % polygon.length];
    if (!p || !q) continue;
    if (segmentIntersection(a, b, p, q)) return true;
    if (distPointToSegment(p.x, p.z, a, b) < clearance) return true;
  }
  if (polygonSignedDistance(a.x, a.z, polygon) < clearance) return true;
  if (polygonSignedDistance(b.x, b.z, polygon) < clearance) return true;
  return false;
}

/** 閉多角形のバウンディングボックス */
export function polygonBounds(polygon: Polygon): {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
} {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const p of polygon) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z;
    if (p.z > maxZ) maxZ = p.z;
  }
  return { minX, maxX, minZ, maxZ };
}

/** 頂点列の shoelace 符号を検査し、時計回り(符号負。Polygon 規約)に揃える */
export function ensureClockwise(polygon: Polygon): Polygon {
  let sum = 0;
  for (let i = 0; i < polygon.length; i++) {
    const p = polygon[i];
    const q = polygon[(i + 1) % polygon.length];
    if (!p || !q) continue;
    sum += p.x * q.z - q.x * p.z;
  }
  return sum < 0 ? polygon : polygon.slice().reverse();
}

/**
 * BridgeSite の安定 id の基部(中点座標由来。小数1桁へ丸め)。
 * contracts/worldmodel.md Water 節。
 */
export function bridgeBaseId(p: Vec2): string {
  const fmt = (v: number): string => (Math.abs(v) < 0.05 ? 0 : v).toFixed(1);
  return `bridge/${fmt(p.x)}_${fmt(p.z)}`;
}

/** 同一キーの衝突時に抽出順の連番を後置して一意な id を割り当てる */
export function claimId(counts: Map<string, number>, base: string): string {
  const occurrence = counts.get(base) ?? 0;
  counts.set(base, occurrence + 1);
  return occurrence === 0 ? base : `${base}/${occurrence + 1}`;
}
