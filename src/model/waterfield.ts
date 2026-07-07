/**
 * 水域・陸地のスカラー場と、グリッド等値線による三角形分割(マーチング三角形)。
 * 水域判定・岸距離・陸地クリップのサンプリングの正
 * (docs/internal/contracts/worldmodel.md Water 節)。
 * pipeline(岸線抽出・面積検証)と mesh(地面・水面・岸スカートの三角形分割)が
 * ここの同じ純関数を共有することで、絵とデータの岸線を一致させる。
 * three 非依存・乱数ストリーム非消費(順序非依存規約)。
 */
import type { Polygon, Spline, Vec2 } from "./worldmodel";

/** マーチンググリッドの張り(ワールド一辺比)。境界(最大半径 0.5×size)より広く取る */
export const GRID_SPAN_RATIO = 1.1;

/** マーチンググリッドの一辺セル数。最小の川幅でも水面が途切れない解像度を保つ */
export function gridCellCount(size: number): number {
  return Math.max(96, Math.min(224, Math.round(size / 2.5)));
}

/** 点 (px, pz) と線分 ab の距離 */
function distToSegment(
  px: number,
  pz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
): number {
  const dx = bx - ax;
  const dz = bz - az;
  const lenSq = dx * dx + dz * dz;
  const t =
    lenSq > 0
      ? Math.min(1, Math.max(0, ((px - ax) * dx + (pz - az) * dz) / lenSq))
      : 0;
  return Math.hypot(px - (ax + dx * t), pz - (az + dz * t));
}

/** 点と折れ線(開いた点列)の距離 */
export function distToPolyline(x: number, z: number, points: Vec2[]): number {
  let best = Infinity;
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (!a || !b) continue;
    best = Math.min(best, distToSegment(x, z, a.x, a.z, b.x, b.z));
  }
  return best;
}

/** 点が閉多角形の内側か(偶奇判定) */
export function pointInPolygon(x: number, z: number, polygon: Polygon): boolean {
  let inside = false;
  const n = polygon.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const p = polygon[i];
    const q = polygon[j];
    if (!p || !q) continue;
    if (
      p.z > z !== q.z > z &&
      x < ((q.x - p.x) * (z - p.z)) / (q.z - p.z) + p.x
    ) {
      inside = !inside;
    }
  }
  return inside;
}

/** 閉多角形の符号付き距離(負=内側。絶対値は縁までの距離) */
export function polygonSignedDistance(
  x: number,
  z: number,
  polygon: Polygon,
): number {
  let best = Infinity;
  const n = polygon.length;
  for (let i = 0; i < n; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % n];
    if (!a || !b) continue;
    best = Math.min(best, distToSegment(x, z, a.x, a.z, b.x, b.z));
  }
  return pointInPolygon(x, z, polygon) ? -best : best;
}

/** 閉多角形の面積(向きに依らず正) */
export function polygonArea(polygon: Polygon): number {
  let sum = 0;
  const n = polygon.length;
  for (let i = 0; i < n; i++) {
    const p = polygon[i];
    const q = polygon[(i + 1) % n];
    if (!p || !q) continue;
    sum += p.x * q.z - q.x * p.z;
  }
  return Math.abs(sum) / 2;
}

/**
 * 星形境界ポリゴン(contracts/worldmodel.md Ground 節)の偏角→半径関数。
 * 頂点を偏角順に並べ、角度の線形補間で半径を返す。
 */
export function createBoundaryRadius(
  boundary: Polygon,
): (theta: number) => number {
  const entries = boundary
    .map((p) => ({ a: Math.atan2(p.z, p.x), r: Math.hypot(p.x, p.z) }))
    .sort((u, v) => u.a - v.a);
  const n = entries.length;
  return (theta: number): number => {
    if (n === 0) return 0;
    if (n === 1) return entries[0]?.r ?? 0;
    let t = theta;
    while (t < -Math.PI) t += Math.PI * 2;
    while (t >= Math.PI) t -= Math.PI * 2;
    // entries[lo].a <= t < entries[lo+1].a となる区間を二分探索
    let lo = 0;
    let hi = n - 1;
    const first = entries[0];
    const last = entries[n - 1];
    if (!first || !last) return 0;
    if (t < first.a || t >= last.a) {
      // 末尾と先頭をまたぐ区間(環)
      const span = first.a + Math.PI * 2 - last.a;
      const off = t >= last.a ? t - last.a : t + Math.PI * 2 - last.a;
      const f = span > 0 ? off / span : 0;
      return last.r + (first.r - last.r) * f;
    }
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if ((entries[mid]?.a ?? 0) <= t) lo = mid;
      else hi = mid;
    }
    const a = entries[lo];
    const b = entries[hi];
    if (!a || !b) return 0;
    const span = b.a - a.a;
    const f = span > 0 ? (t - a.a) / span : 0;
    return a.r + (b.r - a.r) * f;
  };
}

/** 水域・陸地のスカラー場。すべて「正=陸側」で統一する */
export interface WaterField {
  /** 水域の符号付き距離(正=陸側、負=水中。絶対値≒水際までの距離) */
  waterSdf(x: number, z: number): number;
  /** 境界の内側距離(正=境界内。星形半径による近似) */
  boundarySdf(x: number, z: number): number;
  /** 陸地関数 = min(boundarySdf, waterSdf)。正の領域が地面 */
  landSdf(x: number, z: number): number;
  /** 水面上の点の岸距離(陸までの距離)= max(0, −landSdf) */
  shoreDist(x: number, z: number): number;
}

/** 境界・河川・湖から水域/陸地のスカラー場を作る */
export function createWaterField(
  boundary: Polygon,
  rivers: Spline[],
  lakes: Polygon[],
): WaterField {
  const radius = createBoundaryRadius(boundary);
  let far = 1;
  for (const p of boundary) far = Math.max(far, Math.hypot(p.x, p.z) * 8);

  const waterSdf = (x: number, z: number): number => {
    let d = far;
    for (const river of rivers) {
      d = Math.min(d, distToPolyline(x, z, river.points) - river.width / 2);
    }
    for (const lake of lakes) {
      d = Math.min(d, polygonSignedDistance(x, z, lake));
    }
    return d;
  };
  const boundarySdf = (x: number, z: number): number =>
    radius(Math.atan2(z, x)) - Math.hypot(x, z);
  const landSdf = (x: number, z: number): number =>
    Math.min(boundarySdf(x, z), waterSdf(x, z));

  return {
    waterSdf,
    boundarySdf,
    landSdf,
    shoreDist: (x, z) => Math.max(0, -landSdf(x, z)),
  };
}

/**
 * 境界内の水域面積の見積もり(グリッド標本化)。
 * waterAreaCap のクリップと検証はこの見積もりを正とする(contracts/worldmodel.md)。
 */
export function estimateWaterArea(
  field: WaterField,
  size: number,
  cells = 128,
): number {
  const half = (size * GRID_SPAN_RATIO) / 2;
  const step = (half * 2) / cells;
  let count = 0;
  for (let iz = 0; iz < cells; iz++) {
    for (let ix = 0; ix < cells; ix++) {
      const x = (ix + 0.5) * step - half;
      const z = (iz + 0.5) * step - half;
      if (field.boundarySdf(x, z) > 0 && field.waterSdf(x, z) < 0) count++;
    }
  }
  return count * step * step;
}

/** スカラー場の勾配(中心差分)。正の側(陸側)を向く */
export function fieldGradient(
  fn: (x: number, z: number) => number,
  x: number,
  z: number,
  h = 0.5,
): Vec2 {
  return {
    x: (fn(x + h, z) - fn(x - h, z)) / (2 * h),
    z: (fn(x, z + h) - fn(x, z - h)) / (2 * h),
  };
}

/** グリッド等値線抽出の結果 */
export interface FieldMesh {
  /** 頂点 [x0, z0, x1, z1, ...](重複なし。y は呼び出し側が決める) */
  positions: number[];
  /** 正領域を覆う三角形の頂点インデックス(境界時計回りの地面で法線 +y になる並び) */
  triangles: number[];
  /** 零等値線の点列(正領域の縁)。closed=true は閉環 */
  contours: { points: Vec2[]; closed: boolean }[];
}

/**
 * スカラー場の正領域をグリッドで三角形分割し、零等値線を抽出する。
 * セルを対角で2三角形に割り、符号が変わる三角形は零交点で線形にクリップする
 * (implementation-spec PHASE 2「細分グリッドを水域でクリップする」)。
 * 交点はグリッド辺ごとに一意に共有され、隣接三角形・等値線・呼び出し側の間で
 * 完全に一致する(浮動小数の突き合わせをしない)。
 */
export function marchPositiveRegion(
  field: (x: number, z: number) => number,
  size: number,
  cells: number = gridCellCount(size),
): FieldMesh {
  const half = (size * GRID_SPAN_RATIO) / 2;
  const step = (half * 2) / cells;
  const nv = cells + 1;
  const values = new Float64Array(nv * nv);
  for (let iz = 0; iz < nv; iz++) {
    for (let ix = 0; ix < nv; ix++) {
      values[iz * nv + ix] = field(ix * step - half, iz * step - half);
    }
  }

  const positions: number[] = [];
  const triangles: number[] = [];
  /** 等値線セグメント(positions のインデックス対) */
  const segments: [number, number][] = [];
  /** グリッド頂点 → 出力頂点(遅延割当) */
  const gridIndex = new Int32Array(nv * nv).fill(-1);
  /** 符号が変わるグリッド辺 → 補間交点の出力頂点 */
  const crossIndex = new Map<number, number>();

  const gridX = (gid: number): number => (gid % nv) * step - half;
  const gridZ = (gid: number): number => Math.floor(gid / nv) * step - half;

  const gridVertex = (gid: number): number => {
    let idx = gridIndex[gid] ?? -1;
    if (idx < 0) {
      idx = positions.length / 2;
      gridIndex[gid] = idx;
      positions.push(gridX(gid), gridZ(gid));
    }
    return idx;
  };

  const crossing = (ga: number, gb: number): number => {
    const lo = Math.min(ga, gb);
    const hi = Math.max(ga, gb);
    const key = lo * nv * nv + hi;
    const found = crossIndex.get(key);
    if (found !== undefined) return found;
    const va = values[lo] ?? 0;
    const vb = values[hi] ?? 0;
    const t = va / (va - vb);
    const idx = positions.length / 2;
    positions.push(
      gridX(lo) + (gridX(hi) - gridX(lo)) * t,
      gridZ(lo) + (gridZ(hi) - gridZ(lo)) * t,
    );
    crossIndex.set(key, idx);
    return idx;
  };

  const isIn = (gid: number): boolean => (values[gid] ?? 0) > 0;

  /** 三角形を零等値線でクリップし、正側の三角形と等値線セグメントを出力する */
  const clipTriangle = (ga: number, gb: number, gc: number): void => {
    const inCount = (isIn(ga) ? 1 : 0) + (isIn(gb) ? 1 : 0) + (isIn(gc) ? 1 : 0);
    if (inCount === 0) return;
    if (inCount === 3) {
      triangles.push(gridVertex(ga), gridVertex(gb), gridVertex(gc));
      return;
    }
    // 頂点順(=向き)を保ったまま回転して定型に落とす
    let g: [number, number, number] = [ga, gb, gc];
    if (inCount === 1) {
      while (!isIn(g[0])) g = [g[1], g[2], g[0]];
      const [a, b, c] = g;
      const iab = crossing(a, b);
      const ica = crossing(c, a);
      triangles.push(gridVertex(a), iab, ica);
      segments.push([iab, ica]);
    } else {
      while (isIn(g[2])) g = [g[1], g[2], g[0]];
      const [a, b, c] = g;
      const ibc = crossing(b, c);
      const ica = crossing(c, a);
      triangles.push(gridVertex(a), gridVertex(b), ibc);
      triangles.push(gridVertex(a), ibc, ica);
      segments.push([ibc, ica]);
    }
  };

  for (let iz = 0; iz < cells; iz++) {
    for (let ix = 0; ix < cells; ix++) {
      const a = iz * nv + ix; // (ix, iz)
      const b = a + 1; // (ix+1, iz)
      const c = a + nv + 1; // (ix+1, iz+1)
      const d = a + nv; // (ix, iz+1)
      // xz 平面で shoelace 負(時計回り)の並び → 法線 +y(mesh/build.ts と同規約)
      clipTriangle(a, d, c);
      clipTriangle(a, c, b);
    }
  }

  // 等値線セグメントを点の共有で連結する。交点は多様体上で高々2セグメントに
  // 接続するため、出現順に辿れば決定論的に同じ折れ線になる
  const adjacency = new Map<number, number[]>();
  for (let s = 0; s < segments.length; s++) {
    const seg = segments[s];
    if (!seg) continue;
    for (const endpoint of seg) {
      const list = adjacency.get(endpoint);
      if (list) list.push(s);
      else adjacency.set(endpoint, [s]);
    }
  }
  const used = new Array<boolean>(segments.length).fill(false);
  const contours: FieldMesh["contours"] = [];
  const takeNext = (endpoint: number): number | undefined => {
    const list = adjacency.get(endpoint);
    if (!list) return undefined;
    for (const s of list) if (!used[s]) return s;
    return undefined;
  };
  for (let s = 0; s < segments.length; s++) {
    if (used[s]) continue;
    const seed = segments[s];
    if (!seed) continue;
    used[s] = true;
    const chain: number[] = [seed[0], seed[1]];
    let closed = false;
    for (;;) {
      const e = chain[chain.length - 1] ?? -1;
      const next = takeNext(e);
      if (next === undefined) break;
      used[next] = true;
      const seg = segments[next];
      if (!seg) break;
      const other = seg[0] === e ? seg[1] : seg[0];
      if (other === chain[0]) {
        closed = true;
        break;
      }
      chain.push(other);
    }
    if (!closed) {
      const back: number[] = [];
      for (;;) {
        const e = back.length > 0 ? (back[back.length - 1] ?? -1) : (chain[0] ?? -1);
        const next = takeNext(e);
        if (next === undefined) break;
        used[next] = true;
        const seg = segments[next];
        if (!seg) break;
        back.push(seg[0] === e ? seg[1] : seg[0]);
      }
      back.reverse();
      chain.unshift(...back);
    }
    contours.push({
      points: chain.map((idx) => ({
        x: positions[idx * 2] ?? 0,
        z: positions[idx * 2 + 1] ?? 0,
      })),
      closed,
    });
  }

  return { positions, triangles, contours };
}
