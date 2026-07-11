/**
 * 段5「道路網」: グリッドA*で進入点→中心の主道と進入点間の補完路を引き、
 * 道路グラフ(nodes/edges)を確定する。
 * データの正は docs/internal/contracts/network-plaza.md(Network 節)・ground-water.md(Water 節)、
 * 設計は implementation-spec 1.3節(段5)・PHASE 3・9節(リスクと対策)。
 *
 * - コスト = 距離 + 低周波ノイズのコスト場(seed 駆動の格子ノイズ。
 *   乱数ストリームを消費せず、碁盤目化を防いで道を有機的に曲げる)
 *   + 水域横断コスト(湖・池は一律高コストとし、事実上の通行禁止にする。
 *   水域は閉領域であり境界内で迂回できるため。3.2節(5))
 *   − 既存道路割引(先に引いた道を再利用させ、幹線を自己組織化させる)
 * - グリッド解像度は World Scale に応じて上限クリップし、A* は
 *   ヒューリスティック重み付きで近似最短を許容する(spec 9節)
 * - 道路(段5)は湖・池を渡らないため、本段は BridgeSite を抽出しない
 *   (橋は段6「水路」と段8「結界計画」由来のみ。contracts/ground-water.md
 *   「bridges の性質」)
 * - 後PHASE(小道=4b、水路=段6)は nodes / edges への追記のみで
 *   行える構造(id はグリッドセル座標由来で安定)
 * - 本段は乱数ストリームを消費しない(A* もコスト場も決定論的)
 */
import type { RoadClass, Vec2, WorldModel } from "../model/worldmodel";
import { createWaterField, waterBodies, type WaterField } from "../model/waterfield";
import { fbm2D, noiseSeed } from "./noise";
import { chaikin, pathLength, simplifyPath } from "../model/geometry";

/** 経路探索グリッドの一辺セル数の下限・上限(spec 9節: 解像度の上限クリップ) */
const GRID_MIN = 56;
const GRID_MAX = 104;
/** セル寸の目安(worldSize / この値 がセル数) */
const GRID_DIVISOR = 4.5;
/** グリッドの張り(ワールド一辺比)。境界(最大半径 0.5×size)を覆う */
const GRID_SPAN_RATIO = 1.04;
/** ヒューリスティック重み(>1 で近似最短を許容。spec 9節) */
const HEURISTIC_WEIGHT = 1.15;
/** 既存道路の再利用割引(コスト係数への乗算。幹線の自己組織化) */
const ROAD_DISCOUNT = 0.35;
/**
 * 補完路探索時の緩い割引。主道と同じ強い割引では進入点間の経路が常に
 * 「中心経由の既存道の再利用」に収束して補完路が生まれないため、
 * 補完路の探索のみ再利用の魅力を弱める(採用判定は新規率と予算で行う)
 */
const CONNECTOR_ROAD_DISCOUNT = 0.9;
/** 低周波ノイズコストの振幅(距離あたり) */
const NOISE_AMP = 0.9;
/** ノイズコスト場の波長(ワールド一辺比) */
const NOISE_WAVELENGTH_RATIO = 1 / 6;
/**
 * 水域横断の距離あたり追加コスト。湖・池は迂回可能な閉領域のため、
 * 橋適地の区別はせず一律高コストとして事実上の通行禁止にする
 * (3.2節(5)。旧仕様の「幅の狭い水域=橋適地」は川の削除で撤廃)
 */
const WATER_COST_WIDE = 14;
/** 境界外セルの距離あたり追加コスト(道を箱庭の内側に保つ) */
const OUTSIDE_COST = 6;
/** 道路幅(実寸)。contracts/network-plaza.md Network 節 */
const MAIN_WIDTH = 3.6;
const CONNECTOR_WIDTH = 2.6;
/** main の等級格上げ(grade は 0〜2 連続) */
const MAIN_GRADE_BOOST = 0.3;
/** 補完路として採用する最小の新規率(既存道路で足りる対は張らない) */
const CONNECTOR_MIN_NEW_RATIO = 0.25;
/** 経路間引き(Douglas–Peucker)の許容誤差(セル寸比) */
const SIMPLIFY_EPS_RATIO = 0.6;

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/** 経路探索グリッド */
interface Grid {
  cells: number;
  step: number;
  half: number;
}

function makeGrid(size: number): Grid {
  const cells = clamp(Math.round(size / GRID_DIVISOR), GRID_MIN, GRID_MAX);
  const half = (size * GRID_SPAN_RATIO) / 2;
  return { cells, step: (half * 2) / cells, half };
}

function cellCenter(g: Grid, cell: number): Vec2 {
  const ix = cell % g.cells;
  const iz = Math.floor(cell / g.cells);
  return {
    x: (ix + 0.5) * g.step - g.half,
    z: (iz + 0.5) * g.step - g.half,
  };
}

function cellOf(g: Grid, p: Vec2): number {
  const ix = clamp(Math.floor((p.x + g.half) / g.step), 0, g.cells - 1);
  const iz = clamp(Math.floor((p.z + g.half) / g.step), 0, g.cells - 1);
  return iz * g.cells + ix;
}

/** 距離あたりコスト場(道路割引は探索時に別途乗算する) */
interface CostField {
  traversable: Uint8Array;
  factor: Float64Array;
  inWater: Uint8Array;
}

/**
 * 水域(waterSdf < 0)のセルを一律高コストにし、事実上の通行禁止にする
 * (3.2節(5)。湖・池は閉領域であり境界内で必ず迂回できるため、旧仕様の
 * 「幅の狭い水域=橋適地」の区別は廃止した)。
 */
function addWaterCrossingCost(factor: Float64Array, inWater: Uint8Array): void {
  const n = factor.length;
  for (let c = 0; c < n; c++) {
    if (!inWater[c]) continue;
    factor[c] = (factor[c] ?? 1) + WATER_COST_WIDE;
  }
}

/** コスト場を組み立てる(ノイズは格子ノイズで乱数非消費・順序非依存) */
function buildCostField(
  g: Grid,
  model: WorldModel,
  field: WaterField,
): CostField {
  const n = g.cells * g.cells;
  const traversable = new Uint8Array(n);
  const factor = new Float64Array(n);
  const inWater = new Uint8Array(n);
  const nSeed = noiseSeed(model.meta.seed, "network/cost");
  const wavelength = model.ground.size * NOISE_WAVELENGTH_RATIO;

  for (let c = 0; c < n; c++) {
    const p = cellCenter(g, c);
    const b = field.boundarySdf(p.x, p.z);
    const w = field.waterSdf(p.x, p.z);
    traversable[c] = b > -g.step ? 1 : 0;
    inWater[c] = w < 0 ? 1 : 0;
    let f = 1 + NOISE_AMP * fbm2D(nSeed, p.x / wavelength, p.z / wavelength, 3);
    if (b < 0) f += OUTSIDE_COST;
    factor[c] = f;
  }
  addWaterCrossingCost(factor, inWater);
  return { traversable, factor, inWater };
}

/**
 * グリッドA*(8近傍・重み付きヒューリスティック)。
 * 移動コスト = 距離 × 両端セルの係数平均(道路セルは ROAD_DISCOUNT 乗算)。
 * タイブレークは f → セル番号 の順で決定論的。
 */
function astar(
  g: Grid,
  cost: CostField,
  road: Uint8Array,
  start: number,
  goal: number,
  roadDiscount: number,
): number[] | null {
  const n = g.cells * g.cells;
  const gScore = new Float64Array(n).fill(Infinity);
  const cameFrom = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);

  const goalP = cellCenter(g, goal);
  // 距離あたり最小コスト(=道路割引後の 1×roadDiscount)を掛けたうえで
  // HEURISTIC_WEIGHT 倍に膨らませ、近似最短を許容する(spec 9節)
  const h = (c: number): number => {
    const p = cellCenter(g, c);
    return (
      HEURISTIC_WEIGHT * roadDiscount * Math.hypot(p.x - goalP.x, p.z - goalP.z)
    );
  };
  const unit = (c: number): number =>
    (cost.factor[c] ?? 1) * (road[c] ? roadDiscount : 1);

  // 二分ヒープ(f 同点はセル番号の小さい方を先に)
  const heapF: number[] = [];
  const heapC: number[] = [];
  const less = (i: number, j: number): boolean => {
    const fi = heapF[i] ?? Infinity;
    const fj = heapF[j] ?? Infinity;
    if (fi !== fj) return fi < fj;
    return (heapC[i] ?? 0) < (heapC[j] ?? 0);
  };
  const swap = (i: number, j: number): void => {
    const f = heapF[i] ?? 0;
    heapF[i] = heapF[j] ?? 0;
    heapF[j] = f;
    const c = heapC[i] ?? 0;
    heapC[i] = heapC[j] ?? 0;
    heapC[j] = c;
  };
  const push = (f: number, c: number): void => {
    heapF.push(f);
    heapC.push(c);
    let i = heapF.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!less(i, parent)) break;
      swap(i, parent);
      i = parent;
    }
  };
  const pop = (): number => {
    const top = heapC[0] ?? -1;
    const lastF = heapF.pop() ?? 0;
    const lastC = heapC.pop() ?? 0;
    if (heapF.length > 0) {
      heapF[0] = lastF;
      heapC[0] = lastC;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < heapF.length && less(l, m)) m = l;
        if (r < heapF.length && less(r, m)) m = r;
        if (m === i) break;
        swap(i, m);
        i = m;
      }
    }
    return top;
  };

  const dirs: [number, number, number][] = [
    [1, 0, 1],
    [-1, 0, 1],
    [0, 1, 1],
    [0, -1, 1],
    [1, 1, Math.SQRT2],
    [1, -1, Math.SQRT2],
    [-1, 1, Math.SQRT2],
    [-1, -1, Math.SQRT2],
  ];

  gScore[start] = 0;
  push(h(start), start);
  while (heapF.length > 0) {
    const current = pop();
    if (current < 0) break;
    if (closed[current]) continue;
    closed[current] = 1;
    if (current === goal) {
      const path: number[] = [];
      for (let c = goal; c >= 0; c = cameFrom[c] ?? -1) path.push(c);
      path.reverse();
      return path;
    }
    const cx = current % g.cells;
    const cz = Math.floor(current / g.cells);
    for (const [dx, dz, dl] of dirs) {
      const nx = cx + dx;
      const nz = cz + dz;
      if (nx < 0 || nx >= g.cells || nz < 0 || nz >= g.cells) continue;
      const nb = nz * g.cells + nx;
      if (closed[nb]) continue;
      if (!cost.traversable[nb] && nb !== goal && nb !== start) continue;
      const moveCost = dl * g.step * ((unit(current) + unit(nb)) / 2);
      const tentative = (gScore[current] ?? Infinity) + moveCost;
      if (tentative < (gScore[nb] ?? Infinity)) {
        gScore[nb] = tentative;
        cameFrom[nb] = current;
        push(tentative + h(nb), nb);
      }
    }
  }
  return null;
}

/** 抽出済み道路グラフの edge(WorldModel と同形) */
interface RoadEdge {
  id: string;
  from: string;
  to: string;
  class: RoadClass;
  width: number;
  path: Vec2[];
  grade: number;
}

/** パイプライン段の実体: network.nodes/edges を埋める(道路(段5)は湖・池を渡らないため water.bridges は触らない) */
export function runNetwork(model: WorldModel): void {
  const { derived } = model.meta;
  const field = createWaterField(model.ground.boundary, waterBodies(model.water));
  const g = makeGrid(model.ground.size);
  const cost = buildCostField(g, model, field);
  const n = g.cells * g.cells;

  const road = new Uint8Array(n);
  const mainFlag = new Uint8Array(n);
  const links = new Set<number>();
  const adjacency = new Map<number, number[]>();
  const linkKey = (a: number, b: number): number =>
    a < b ? a * n + b : b * n + a;
  const addLink = (a: number, b: number): boolean => {
    if (a === b) return false;
    const key = linkKey(a, b);
    if (links.has(key)) return false;
    links.add(key);
    const la = adjacency.get(a);
    if (la) la.push(b);
    else adjacency.set(a, [b]);
    const lb = adjacency.get(b);
    if (lb) lb.push(a);
    else adjacency.set(b, [a]);
    return true;
  };

  const entries = model.network.entryPoints;
  const centerCell = cellOf(g, model.centerPlan.position);
  const entryCells = entries.map((e) => cellOf(g, e.position));

  let assertionViolations = 0;

  // 主道: 各進入点→中心。先に引いた道は割引で再利用され、幹線が自己組織化する
  let totalRouteLen = 0;
  for (const entryCell of entryCells) {
    const path = astar(g, cost, road, entryCell, centerCell, ROAD_DISCOUNT);
    if (!path) {
      assertionViolations++;
      continue;
    }
    for (const c of path) {
      road[c] = 1;
      mainFlag[c] = 1;
    }
    for (let i = 0; i + 1 < path.length; i++) {
      const a = path[i];
      const b = path[i + 1];
      if (a === undefined || b === undefined) continue;
      if (addLink(a, b)) {
        const pa = cellCenter(g, a);
        const pb = cellCenter(g, b);
        totalRouteLen += Math.hypot(pb.x - pa.x, pb.z - pa.z);
      }
    }
  }

  // 補完路: 外縁の隣接する進入点対。既存道路で足りる対は張らず、
  // 新規延長が roadBudget を超える対も張らない
  const order = entries
    .map((e, i) => ({ i, theta: Math.atan2(e.position.z, e.position.x) }))
    .sort((a, b) => a.theta - b.theta || a.i - b.i)
    .map((e) => e.i);
  const pairs: [number, number][] = [];
  if (order.length === 2) {
    pairs.push([order[0] ?? 0, order[1] ?? 0]);
  } else if (order.length > 2) {
    for (let k = 0; k < order.length; k++) {
      pairs.push([order[k] ?? 0, order[(k + 1) % order.length] ?? 0]);
    }
  }
  for (const [i, j] of pairs) {
    const from = entryCells[i];
    const to = entryCells[j];
    if (from === undefined || to === undefined) continue;
    const path = astar(g, cost, road, from, to, CONNECTOR_ROAD_DISCOUNT);
    if (!path) continue;
    let pathLen = 0;
    let newLen = 0;
    for (let k = 0; k + 1 < path.length; k++) {
      const a = path[k];
      const b = path[k + 1];
      if (a === undefined || b === undefined) continue;
      const pa = cellCenter(g, a);
      const pb = cellCenter(g, b);
      const d = Math.hypot(pb.x - pa.x, pb.z - pa.z);
      pathLen += d;
      if (!links.has(linkKey(a, b))) newLen += d;
    }
    if (newLen < CONNECTOR_MIN_NEW_RATIO * pathLen) continue;
    if (totalRouteLen + newLen > derived.roadBudget) continue;
    for (const c of path) road[c] = 1;
    for (let k = 0; k + 1 < path.length; k++) {
      const a = path[k];
      const b = path[k + 1];
      if (a === undefined || b === undefined) continue;
      addLink(a, b);
    }
    totalRouteLen += newLen;
  }

  // グラフ抽出: 次数≠2 のセルと特別セル(中心・進入点)をノードにし、
  // その間の次数2の鎖を edge にする(走査順は昇順で決定論的)
  const exactPos = new Map<number, Vec2>();
  exactPos.set(centerCell, model.centerPlan.position);
  entryCells.forEach((c, i) => {
    const e = entries[i];
    if (e) exactPos.set(c, e.position);
  });
  const special = new Set<number>([centerCell, ...entryCells]);
  const isNode = (c: number): boolean =>
    special.has(c) || (adjacency.get(c)?.length ?? 0) !== 2;
  const nodeCells = [...adjacency.keys()].filter(isNode).sort((a, b) => a - b);
  const posOf = (c: number): Vec2 => exactPos.get(c) ?? cellCenter(g, c);
  const cellIx = (c: number): number => c % g.cells;
  const cellIz = (c: number): number => Math.floor(c / g.cells);
  const nodeId = (c: number): string => `node/${cellIx(c)}_${cellIz(c)}`;

  const usedLinks = new Set<number>();
  const chains: number[][] = [];
  for (const nc of nodeCells) {
    const neighbors = (adjacency.get(nc) ?? []).slice().sort((a, b) => a - b);
    for (const nb of neighbors) {
      const k = linkKey(nc, nb);
      if (usedLinks.has(k)) continue;
      usedLinks.add(k);
      const chain = [nc, nb];
      let prev = nc;
      let cur = nb;
      let guard = links.size + 2;
      while (!isNode(cur) && guard-- > 0) {
        const ns = adjacency.get(cur) ?? [];
        const next = ns[0] === prev ? ns[1] : ns[0];
        if (next === undefined) break;
        usedLinks.add(linkKey(cur, next));
        chain.push(next);
        prev = cur;
        cur = next;
      }
      chains.push(chain);
    }
  }

  const usedNodeCells = new Set<number>();
  const edges: RoadEdge[] = [];
  const edgeIdCounts = new Map<string, number>();
  for (const chain of chains) {
    const head = chain[0];
    const tail = chain[chain.length - 1];
    if (head === undefined || tail === undefined) continue;
    usedNodeCells.add(head);
    usedNodeCells.add(tail);
    let mainCells = 0;
    for (const c of chain) if (mainFlag[c]) mainCells++;
    const cls: RoadClass = mainCells >= chain.length * 0.5 ? "main" : "connector";
    const raw = chain.map(posOf);
    const path = chaikin(simplifyPath(raw, g.step * SIMPLIFY_EPS_RATIO));
    const baseId = `road/${cellIx(head)}_${cellIz(head)}-${cellIx(tail)}_${cellIz(tail)}`;
    const occurrence = edgeIdCounts.get(baseId) ?? 0;
    edgeIdCounts.set(baseId, occurrence + 1);
    edges.push({
      id: occurrence === 0 ? baseId : `${baseId}/${occurrence + 1}`,
      from: nodeId(head),
      to: nodeId(tail),
      class: cls,
      width: cls === "main" ? MAIN_WIDTH : CONNECTOR_WIDTH,
      path,
      grade:
        cls === "main"
          ? clamp(derived.roadGrade + MAIN_GRADE_BOOST, 0, 2)
          : derived.roadGrade,
    });
  }

  const nodes = [...usedNodeCells]
    .sort((a, b) => a - b)
    .map((c) => ({ id: nodeId(c), position: posOf(c) }));

  model.network.nodes = nodes;
  model.network.edges = edges;
  // water.bridges は本段では触らない(道路は湖・池を渡らないため段5 は
  // BridgeSite を抽出しない。橋は段6「水路」と段8「結界計画」由来のみ)

  // サマリー(段13 の担当だが、中間PHASEでは部分的に埋める)
  let roadLength = 0;
  for (const edge of edges) roadLength += pathLength(edge.path);
  model.summary.scale.roadLength = roadLength;

  // パイプライン内アサーション: 違反は throw せず件数を console に出す
  // (implementation-spec 1.10節)
  // 1) 全進入点から中心への到達性(edges のグラフを BFS)
  const graph = new Map<string, string[]>();
  for (const edge of edges) {
    const fromList = graph.get(edge.from);
    if (fromList) fromList.push(edge.to);
    else graph.set(edge.from, [edge.to]);
    const toList = graph.get(edge.to);
    if (toList) toList.push(edge.from);
    else graph.set(edge.to, [edge.from]);
  }
  const centerId = nodeId(centerCell);
  const reached = new Set<string>([centerId]);
  const queue = [centerId];
  while (queue.length > 0) {
    const cur = queue.shift();
    if (cur === undefined) break;
    for (const nb of graph.get(cur) ?? []) {
      if (!reached.has(nb)) {
        reached.add(nb);
        queue.push(nb);
      }
    }
  }
  for (const c of entryCells) {
    if (!reached.has(nodeId(c))) assertionViolations++;
  }
  // 2) 道路は湖・池を渡らない(全 edge の path 標本で waterSdf ≥ -1.5 を確認。
  //    経路探索グリッドの量子化と平滑化による岸際のかすりは横断と見なさず
  //    許容する。閾値は contracts/network-plaza.md「道路(段5)は湖・池を
  //    渡らない」・test/network.test.ts と揃える)
  for (const edge of edges) {
    for (const p of edge.path) {
      if (field.waterSdf(p.x, p.z) < -1.5) assertionViolations++;
    }
  }
  if (assertionViolations > 0) {
    console.warn(
      `network: パイプライン内アサーション違反 ${assertionViolations} 件`,
    );
  }
}
