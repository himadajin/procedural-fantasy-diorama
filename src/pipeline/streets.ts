/**
 * 段5「道路網」後半処理: 幹線(main / connector)から発芽し、局所規則で
 * 伸びる二次街路(class: "street")を成長させ、network.nodes / edges へ
 * 追記する(`runNetwork` の末尾、アサーションの前から呼ぶ)。
 * データの正は docs/internal/contracts/network-plaza.md
 * 「二次街路(street)の有機成長」節。
 *
 * - 発芽点: 幹線 edge の弧長 24 間隔の点 + 中心前広場予定方向の1点
 *   (段9 が未確定のため、中心に隣接する main edge のうち中心に最も近い
 *   他端ノードへの方向で代用する)
 * - 乱数: 発芽点ごとに `makeRng(seed, "streets/sprout/<edgeId>/<k>")` から
 *   固定数(MAX_SLOTS × 4)を必ず引き切る(成長が早期に打ち切られても
 *   消費数・消費順は変わらない)。全体の消費順は発芽点の列挙順
 *   (edge の配列順 × k 昇順。中心前広場予定方向の発芽点は末尾)に固定する
 * - 成長: 優先度キュー(優先度=proto-density、同値は sproutId 昇順→
 *   生成順昇順でタイブレーク)。乱数の消費順は列挙時に発芽点ごと事前に
 *   引き切ったテーブルから読むため、キューの処理順(データ依存)には
 *   一切依存しない
 * - 停止・接続: 既存道路(全class)の 6 以内はスナップ接続。水域・境界・
 *   中心予約・形状健全性違反は成長停止。予算超過で全体終了
 * - 性能: 既存道路・street への近接判定は空間ハッシュ(セル寸 10)で
 *   O(セグメント数)に保つ(A* は使わない)
 */
import { makeRng } from "../rng";
import type { Vec2, WorldModel } from "../model/worldmodel";
import {
  createBoundaryRadius,
  createWaterField,
  polygonSignedDistance,
  waterBodies,
} from "../model/waterfield";
import { pathLength, pointAlong, segmentIntersection } from "../model/geometry";
import { createDensityDecay, protoDensityAt } from "./density";

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/** 発芽点の弧長間隔(契約の提案値) */
const SPROUT_INTERVAL = 24;
/** セグメント長の範囲(契約の提案値) */
const SEGMENT_MIN = 12;
const SEGMENT_MAX = 20;
/** 方向の揺らぎ(親方向 ± 25°) */
const ANGLE_WOBBLE = (25 * Math.PI) / 180;
/** 発芽初期方向・分岐方向の「ほぼ直角」キック(70°〜110°。契約の提案値。
 *  contracts/network-plaza.md「二次街路(street)の有機成長」) */
const KICK_MIN = (70 * Math.PI) / 180;
const KICK_SPAN = (40 * Math.PI) / 180;
/** 既存道路への接続スナップ距離(契約の提案値) */
const SNAP_DIST = 6;
/**
 * 形状健全性 4 項(契約の値と同一。network.ts のパイプライン内アサーション・
 * test/network.test.ts・contracts/network-plaza.md「二次街路(street)の
 * 有機成長」の三者が同じ値を共有する)
 */
/** 1) 新しい交差の最小交差角 */
export const MIN_CROSS_ANGLE = (30 * Math.PI) / 180;
/** 2) 並走とみなす距離・並走可能な最大弧長 */
export const PARALLEL_DIST = 10;
export const PARALLEL_RUN_MAX = 16;
/** 3) 袋小路率の上限 */
export const DEAD_END_RATIO_MAX = 0.35;
/**
 * 市街限定の proto-density 閾値(契約の提案値)。段5(本ファイル)は段7
 * (density.ts の model.zoning)より前に走るため roadBoost を持たず、
 * urbanity(0〜1 正規化後。閾値 0.45)ではなく protoDensity の生値のみで
 * 市街限定を判定する。0.22(protoDensity)と 0.45(urbanity)は
 * スケールが異なる 2 つの数値だが同一の意図(市街限定)の 2 つの表現であり、
 * 両者は同時に調整する(contracts/network-plaza.md「Density 節
 * zoning」の対応関係の注記)
 */
export const PROTO_THRESHOLD = 0.22;
/** 境界マージン(実装上の選択。lanes.ts 等の桁感に合わせた提案値) */
const BOUNDARY_CLEAR = 4;
/** centerPlan.footprint への予約クリアランス(lanes.ts の CENTER_CLEAR と同値) */
const CENTER_FOOTPRINT_CLEAR = 1;
/** 空間ハッシュのセル寸(契約: 性能節) */
const SPATIAL_CELL = 10;
/** street の幅・等級補正(契約の提案値) */
export const STREET_WIDTH = 2.2;
export const STREET_GRADE_DROP = 0.2;
/**
 * 発芽点1つあたりの最大セグメント数(安全上限。固定の定数であり
 * derived.streetBudget には依存しない — worldSize/settle/scale の既知の
 * 値域(240〜560 / 0〜1 / 0〜1)から逆算した理論最大(約183)に安全マージンを
 * 載せた値。通常は水域・境界・proto-density閾値・並走則で遥かに手前で
 * 打ち切られる
 */
const MAX_SLOTS_PER_SPROUT = 320;
/** 分岐確率の係数と上限(実装上の選択の提案値) */
const BRANCH_COEFF = 0.6;
const BRANCH_MAX = 0.45;

/** 折り返した鋭角差(0〜π/2)。180°ずれ(同一直線)は 0 とみなす */
function angleDiff(a: number, b: number): number {
  let d = Math.abs(a - b) % (Math.PI * 2);
  if (d > Math.PI) d = Math.PI * 2 - d;
  if (d > Math.PI / 2) d = Math.PI - d;
  return d;
}

/** roll∈[0,1) → ほぼ直角のキック角(符号込み。70°〜110°の左右いずれか) */
function kickAngle(roll: number): number {
  const side = roll < 0.5 ? 1 : -1;
  const frac = side === 1 ? roll * 2 : (roll - 0.5) * 2;
  return side * (KICK_MIN + frac * KICK_SPAN);
}

// ---------------------------------------------------------------------------
// 空間ハッシュ(セグメント検索・ノード検索。セル寸 10。性能節)
// ---------------------------------------------------------------------------

interface SegEntry {
  id: number;
  a: Vec2;
  b: Vec2;
  /** 所属 edge の id(事後の形状健全性間引きで、間引き済み edge の残留
   *  エントリを除外するために使う) */
  edgeId: string;
}

interface NodeEntry {
  id: string;
  p: Vec2;
}

interface SpatialHash<T> {
  cellSize: number;
  cells: Map<string, T[]>;
}

function createHash<T>(cellSize: number): SpatialHash<T> {
  return { cellSize, cells: new Map() };
}

function cellsForBox(
  hash: SpatialHash<unknown>,
  minX: number,
  maxX: number,
  minZ: number,
  maxZ: number,
): string[] {
  const ix0 = Math.floor(minX / hash.cellSize);
  const ix1 = Math.floor(maxX / hash.cellSize);
  const iz0 = Math.floor(minZ / hash.cellSize);
  const iz1 = Math.floor(maxZ / hash.cellSize);
  const keys: string[] = [];
  for (let iz = iz0; iz <= iz1; iz++) {
    for (let ix = ix0; ix <= ix1; ix++) keys.push(`${ix},${iz}`);
  }
  return keys;
}

function insertPoint<T>(hash: SpatialHash<T>, p: Vec2, entry: T): void {
  for (const key of cellsForBox(hash, p.x, p.x, p.z, p.z)) {
    const list = hash.cells.get(key);
    if (list) list.push(entry);
    else hash.cells.set(key, [entry]);
  }
}

function insertSegment<T>(hash: SpatialHash<T>, a: Vec2, b: Vec2, entry: T): void {
  for (const key of cellsForBox(hash, Math.min(a.x, b.x), Math.max(a.x, b.x), Math.min(a.z, b.z), Math.max(a.z, b.z))) {
    const list = hash.cells.get(key);
    if (list) list.push(entry);
    else hash.cells.set(key, [entry]);
  }
}

function queryBox<T>(
  hash: SpatialHash<T>,
  minX: number,
  maxX: number,
  minZ: number,
  maxZ: number,
): T[] {
  const seen = new Set<T>();
  const out: T[] = [];
  for (const key of cellsForBox(hash, minX, maxX, minZ, maxZ)) {
    const list = hash.cells.get(key);
    if (!list) continue;
    for (const e of list) {
      if (seen.has(e)) continue;
      seen.add(e);
      out.push(e);
    }
  }
  return out;
}

/** 点 p と線分 ab の距離・最近点 */
function projectToSegment(p: Vec2, a: Vec2, b: Vec2): { d: number; q: Vec2 } {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const lenSq = dx * dx + dz * dz;
  const t = lenSq > 1e-12 ? clamp(((p.x - a.x) * dx + (p.z - a.z) * dz) / lenSq, 0, 1) : 0;
  const q = { x: a.x + dx * t, z: a.z + dz * t };
  return { d: Math.hypot(p.x - q.x, p.z - q.z), q };
}

// ---------------------------------------------------------------------------
// 発芽点の列挙
// ---------------------------------------------------------------------------

interface SproutSeed {
  /** sproutId = "<edgeId>#<k>" */
  id: string;
  edgeId: string;
  k: number;
  position: Vec2;
  /** 親方向(edge の接線、または中心前広場予定方向の代用角) */
  parentAngle: number;
  /**
   * 中心前広場予定方向の特別な発芽点か。この発芽点の起点は
   * `center + reserveR×方向` に置かれ、幹線 edge の path 上には乗らない
   * (通常の発芽点と違い、起点は幾何的に既存道路へ接していない)ため、
   * 起点ノードの touchesEdgeId を立ててはならない(親道路 id を持たせない)
   */
  isCenterFront: boolean;
}

function enumerateSprouts(model: WorldModel): SproutSeed[] {
  const sprouts: SproutSeed[] = [];
  const nextK = new Map<string, number>();
  for (const edge of model.network.edges) {
    if (edge.class !== "main" && edge.class !== "connector") continue;
    const total = pathLength(edge.path);
    let k = 0;
    for (let s = SPROUT_INTERVAL / 2; s < total; s += SPROUT_INTERVAL, k++) {
      const { p, angle } = pointAlong(edge.path, s);
      sprouts.push({
        id: `${edge.id}#${k}`,
        edgeId: edge.id,
        k,
        position: p,
        parentAngle: angle,
        isCenterFront: false,
      });
    }
    nextK.set(edge.id, k);
  }

  // 中心前広場予定方向の1点(段9 未確定のため、中心に直結する main edge のうち
  // 中心に最も近い他端ノードへの方向で代用する。plans 3.2節(2)の指示による判断)
  const center = model.centerPlan.position;
  const centerNode = model.network.nodes.find(
    (n) => n.position.x === center.x && n.position.z === center.z,
  );
  if (centerNode) {
    const nodePos = new Map(model.network.nodes.map((n) => [n.id, n.position]));
    let refEdge: WorldModel["network"]["edges"][number] | null = null;
    let refOther: Vec2 | null = null;
    let bestD = Infinity;
    for (const edge of model.network.edges) {
      if (edge.class !== "main") continue;
      let other: Vec2 | undefined;
      if (edge.from === centerNode.id) other = nodePos.get(edge.to);
      else if (edge.to === centerNode.id) other = nodePos.get(edge.from);
      if (!other) continue;
      const d = Math.hypot(other.x - center.x, other.z - center.z);
      if (d < bestD) {
        bestD = d;
        refEdge = edge;
        refOther = other;
      }
    }
    if (refEdge && refOther) {
      const theta = Math.atan2(refOther.z - center.z, refOther.x - center.x);
      const k = nextK.get(refEdge.id) ?? 0;
      const reserveR = (model.meta.derived.parcelReserve * model.meta.derived.centerFootprint) / 2;
      const position = {
        x: center.x + Math.cos(theta) * reserveR,
        z: center.z + Math.sin(theta) * reserveR,
      };
      sprouts.push({
        id: `${refEdge.id}#${k}`,
        edgeId: refEdge.id,
        k,
        position,
        parentAngle: theta,
        isCenterFront: true,
      });
    }
  }

  return sprouts;
}

// ---------------------------------------------------------------------------
// 発芽点ごとの乱数事前引き切り(消費順は列挙順に固定)
// ---------------------------------------------------------------------------

interface SlotDraw {
  len: number;
  angle: number;
  branch: number;
  kick: number;
}

function predrawSlots(seed: string, sprout: SproutSeed): SlotDraw[] {
  const rng = makeRng(seed, `streets/sprout/${sprout.edgeId}/${sprout.k}`);
  const slots: SlotDraw[] = [];
  for (let i = 0; i < MAX_SLOTS_PER_SPROUT; i++) {
    slots.push({ len: rng.next(), angle: rng.next(), branch: rng.next(), kick: rng.next() });
  }
  return slots;
}

// ---------------------------------------------------------------------------
// 成長本体
// ---------------------------------------------------------------------------

interface SproutState {
  seed: SproutSeed;
  slots: SlotDraw[];
  cursor: number;
  acceptedCount: number;
  originNodeId: string | null;
}

interface Tip {
  seq: number;
  sprout: SproutState;
  position: Vec2;
  /** root: 親道路の接線(初手のキック計算に使う)。非 root: 直前セグメントの方向 */
  direction: number;
  isRoot: boolean;
  nodeId: string | null;
  excludeSegId: number | null;
  parallelRun: number;
  priority: number;
  /**
   * このtipが「直前セグメントの単純な延長(継続)」である場合、その親 edge の
   * id。分岐(branch)・発芽直後の tip では null(継続ではなく新規の分岐/
   * 起点なので、次に作る edge は親との交差角チェックの対象に含める)。
   * 継続ペアは「1本の街路が緩く曲がっているだけ」であり交差(2本の道が
   * 出会う)ではないため、形状健全性 1(交差角)の対象から除く
   * (verifyStreetShapeHealth の continuationPairs)
   */
  parentEdgeId: string | null;
  /**
   * この tip が発したノード(nodeId)に到着した edge の id(継続・分岐の
   * 両方で共通に設定。root では null)。新しい出発セグメントを受理する前に、
   * 同じノードへ既に接続している「この到着 edge 以外」の edge との交差角を
   * 検査するために使う(形状健全性 1 は「新しい交差」全般が対象であり、
   * スナップ接続だけでなく分岐・継続の出発方向も、既に他の道が集まる
   * ノードでは 30° 以上を保つ必要があるため)
   */
  arrivalEdgeId: string | null;
}

interface NodeMeta {
  /**
   * 発芽起点、または既存道路の中間点へのスナップで作った新規ノードが
   * 「視覚的に接している」相手 edge の id(グラフ上は非連結でも接続と
   * みなす)。発芽起点は親道路(main/connector。恒久的に生存)の id を持つ。
   * 中間点スナップの場合はスナップ先 edge の id を持つが、そのスナップ先が
   * street で後に間引かれると「接している」根拠を失うため、isConnected は
   * この id が生存 edge(isLiveEdge)かどうかを都度確認する
   * (事後の形状健全性間引きが接続関係を変えうるため、固定の真偽値では
   * なく参照先を都度検証する設計)。通常の(スナップでない)新規ノードは null
   */
  touchesEdgeId: string | null;
}

interface StreetEdgeDraft {
  id: string;
  from: string;
  to: string;
  class: "street";
  width: number;
  path: Vec2[];
  grade: number;
}

/**
 * 診断情報の出力先(任意)。`continuationPairs` は「単純な延長(継続)」の
 * edge id ペア(正準キー化して格納)で、verifyStreetShapeHealth が
 * 交差角チェックから除外するために使う(1本の街路の緩い曲がりは
 * 交差ではないため)。
 */
export interface StreetGrowthDiagnostics {
  continuationPairs: Set<string>;
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/** パイプライン段の実体: network.nodes/edges へ street を追記する */
export function growStreets(model: WorldModel, diagnostics?: StreetGrowthDiagnostics): void {
  const { seed, derived } = model.meta;
  const budget = derived.streetBudget;
  if (!(budget > 0)) return;

  // 継続ペアは常に内部で追跡する(呼び出し側が diagnostics を渡さない場合も、
  // 事後の形状健全性間引きが交差角チェックから継続ペアを除外するために使う)
  const continuationPairs = diagnostics?.continuationPairs ?? new Set<string>();

  const decay = createDensityDecay(model);
  const proto = (x: number, z: number): number => protoDensityAt(decay, x, z);

  const waterField = createWaterField(model.ground.boundary, waterBodies(model.water));
  const boundaryRadius = createBoundaryRadius(model.ground.boundary);
  const boundaryInside = (p: Vec2): number =>
    boundaryRadius(Math.atan2(p.z, p.x)) - Math.hypot(p.x, p.z);

  const center = model.centerPlan.position;
  const reserveR = (derived.parcelReserve * derived.centerFootprint) / 2;
  const footprint = model.centerPlan.footprint;
  const inCenterReserve = (p: Vec2): boolean => {
    if (Math.hypot(p.x - center.x, p.z - center.z) < reserveR) return true;
    if (footprint.length < 3) return false;
    return polygonSignedDistance(p.x, p.z, footprint) < CENTER_FOOTPRINT_CLEAR;
  };

  // --- 既存インフラ(main / connector)の空間ハッシュ・隣接方向 ---
  const segHash = createHash<SegEntry>(SPATIAL_CELL);
  const nodeHash = createHash<NodeEntry>(SPATIAL_CELL);
  const nodePos = new Map<string, Vec2>();
  const existingDegree = new Map<string, number>();
  const adjacency = new Map<string, { dir: number; edgeId: string }[]>();
  let segSeq = 0;

  const addAdjacency = (nodeId: string, dir: number, edgeId: string): void => {
    const list = adjacency.get(nodeId);
    if (list) list.push({ dir, edgeId });
    else adjacency.set(nodeId, [{ dir, edgeId }]);
  };
  const insertSeg = (a: Vec2, b: Vec2, edgeId: string): number => {
    const id = segSeq++;
    insertSegment(segHash, a, b, { id, a, b, edgeId });
    return id;
  };
  const registerNode = (id: string, p: Vec2): void => {
    nodePos.set(id, p);
    insertPoint(nodeHash, p, { id, p });
  };

  for (const n of model.network.nodes) registerNode(n.id, n.position);
  for (const edge of model.network.edges) {
    existingDegree.set(edge.from, (existingDegree.get(edge.from) ?? 0) + 1);
    existingDegree.set(edge.to, (existingDegree.get(edge.to) ?? 0) + 1);
    const path = edge.path;
    for (let i = 0; i + 1 < path.length; i++) {
      const a = path[i];
      const b = path[i + 1];
      if (!a || !b) continue;
      insertSeg(a, b, edge.id);
    }
    const p0 = path[0];
    const p1 = path[1];
    const pl0 = path[path.length - 1];
    const pl1 = path[path.length - 2];
    if (p0 && p1) addAdjacency(edge.from, Math.atan2(p1.z - p0.z, p1.x - p0.x), edge.id);
    if (pl0 && pl1) addAdjacency(edge.to, Math.atan2(pl1.z - pl0.z, pl1.x - pl0.x), edge.id);
  }
  const isPreExisting = (id: string): boolean => existingDegree.has(id);

  // --- 発芽点の列挙・乱数の事前引き切り(消費順固定) ---
  const sprouts = enumerateSprouts(model);
  const sproutStates: SproutState[] = sprouts.map((s) => ({
    seed: s,
    slots: predrawSlots(seed, s),
    cursor: 0,
    acceptedCount: 0,
    originNodeId: null,
  }));

  // --- 成長(優先度キュー。O(アクティブ先端数) の線形探索で十分な規模) ---
  const newNodes: { id: string; position: Vec2 }[] = [];
  const newEdges: StreetEdgeDraft[] = [];
  const nodeMeta = new Map<string, NodeMeta>();
  const degree = new Map<string, number>();
  const bumpDegree = (id: string, delta: number): void => {
    degree.set(id, (degree.get(id) ?? 0) + delta);
  };

  const edgeIdCounts = new Map<string, number>();
  const claimEdgeId = (base: string): string => {
    const occurrence = edgeIdCounts.get(base) ?? 0;
    edgeIdCounts.set(base, occurrence + 1);
    return occurrence === 0 ? base : `${base}/${occurrence + 1}`;
  };

  let totalLength = 0;
  let tipSeq = 0;
  const queue: Tip[] = [];
  for (const state of sproutStates) {
    queue.push({
      seq: tipSeq++,
      sprout: state,
      position: state.seed.position,
      direction: state.seed.parentAngle,
      isRoot: true,
      nodeId: null,
      excludeSegId: null,
      parentEdgeId: null,
      arrivalEdgeId: null,
      parallelRun: 0,
      priority: proto(state.seed.position.x, state.seed.position.z),
    });
  }

  const pickBest = (): Tip | undefined => {
    let bestIdx = -1;
    for (let i = 0; i < queue.length; i++) {
      const t = queue[i];
      if (!t) continue;
      if (bestIdx < 0) {
        bestIdx = i;
        continue;
      }
      const best = queue[bestIdx];
      if (!best) {
        bestIdx = i;
        continue;
      }
      if (t.priority !== best.priority) {
        if (t.priority > best.priority) bestIdx = i;
        continue;
      }
      if (t.sprout.seed.id !== best.sprout.seed.id) {
        if (t.sprout.seed.id < best.sprout.seed.id) bestIdx = i;
        continue;
      }
      if (t.seq < best.seq) bestIdx = i;
    }
    if (bestIdx < 0) return undefined;
    const [t] = queue.splice(bestIdx, 1);
    return t;
  };

  interface Junction {
    point: Vec2;
    kind: "node" | "edge" | "cross";
    nodeId?: string;
    /** kind "edge" / "cross" の場合、スナップ先(交差先)の edge id */
    targetEdgeId?: string;
    angle: number;
  }

  const findJunction = (from: Vec2, to: Vec2, excludeSegId: number | null): Junction | null => {
    const minX = Math.min(from.x, to.x) - 0.5;
    const maxX = Math.max(from.x, to.x) + 0.5;
    const minZ = Math.min(from.z, to.z) - 0.5;
    const maxZ = Math.max(from.z, to.z) + 0.5;
    const heading = Math.atan2(to.z - from.z, to.x - from.x);

    // 1) 交差(既存道路・確定済み street との幾何交差。最も手前の交点を採用)
    let bestCross: Junction | null = null;
    let bestCrossT = Infinity;
    for (const s of queryBox(segHash, minX, maxX, minZ, maxZ)) {
      if (s.id === excludeSegId) continue;
      const hit = segmentIntersection(from, to, s.a, s.b);
      if (!hit) continue;
      // 始点 from がちょうど既存道路の線上(発芽点や辺中間スナップの直後)の
      // 場合、t≈0 の自明な「交差」を誤検出するため除外する
      if (hit.t < 1e-6) continue;
      if (hit.t < bestCrossT) {
        bestCrossT = hit.t;
        const dir = Math.atan2(s.b.z - s.a.z, s.b.x - s.a.x);
        bestCross = {
          point: hit.point,
          kind: "cross",
          targetEdgeId: s.edgeId,
          angle: angleDiff(heading, dir),
        };
      }
    }
    if (bestCross) return bestCross;

    // 2) 既存ノードへの近接(先端が 6 以内)
    let bestNode: { id: string; d: number } | null = null;
    for (const n of queryBox(nodeHash, to.x - SNAP_DIST, to.x + SNAP_DIST, to.z - SNAP_DIST, to.z + SNAP_DIST)) {
      const d = Math.hypot(n.p.x - to.x, n.p.z - to.z);
      if (d <= SNAP_DIST && (!bestNode || d < bestNode.d)) bestNode = { id: n.id, d };
    }
    if (bestNode) {
      const snapPoint = nodePos.get(bestNode.id) ?? to;
      // 角度はスナップ後の実際の方向(from→snapPoint)で測る。候補 to への
      // 方向(heading)のままだと、スナップによる位置ずれ(最大 SNAP_DIST)ぶん
      // 実際の交差角と食い違いうる
      const actualHeading = Math.atan2(snapPoint.z - from.z, snapPoint.x - from.x);
      const attached = adjacency.get(bestNode.id) ?? [];
      let minAngle = Math.PI / 2;
      if (attached.length > 0) {
        minAngle = Infinity;
        for (const at of attached) minAngle = Math.min(minAngle, angleDiff(actualHeading + Math.PI, at.dir));
      }
      return { point: snapPoint, kind: "node", nodeId: bestNode.id, angle: minAngle };
    }

    // 3) 既存 edge 中間点への近接(6 以内。既存 edge は分割しない)
    let bestEdge: { d: number; q: Vec2; dir: number; edgeId: string } | null = null;
    for (const s of queryBox(segHash, to.x - SNAP_DIST, to.x + SNAP_DIST, to.z - SNAP_DIST, to.z + SNAP_DIST)) {
      if (s.id === excludeSegId) continue;
      const { d, q } = projectToSegment(to, s.a, s.b);
      if (d <= SNAP_DIST && (!bestEdge || d < bestEdge.d)) {
        bestEdge = { d, q, dir: Math.atan2(s.b.z - s.a.z, s.b.x - s.a.x), edgeId: s.edgeId };
      }
    }
    if (bestEdge) {
      // 同様にスナップ後の実際の方向で角度を測る
      const actualHeading = Math.atan2(bestEdge.q.z - from.z, bestEdge.q.x - from.x);
      return {
        point: bestEdge.q,
        kind: "edge",
        targetEdgeId: bestEdge.edgeId,
        angle: angleDiff(actualHeading, bestEdge.dir),
      };
    }
    return null;
  };

  while (totalLength < budget) {
    const tip = pickBest();
    if (!tip) break;
    const state = tip.sprout;
    if (state.cursor >= state.slots.length) continue; // 安全上限到達(固定の消費数は predraw 済み)
    const slot = state.slots[state.cursor];
    state.cursor++;
    if (!slot) continue;

    const wobble = (slot.angle * 2 - 1) * ANGLE_WOBBLE;
    const heading = tip.isRoot
      ? tip.direction + kickAngle(slot.kick) + wobble
      : tip.direction + wobble;
    const length = SEGMENT_MIN + slot.len * (SEGMENT_MAX - SEGMENT_MIN);
    const from = tip.position;
    const to = { x: from.x + Math.cos(heading) * length, z: from.z + Math.sin(heading) * length };

    const junction = findJunction(from, to, tip.excludeSegId);

    let endPoint: Vec2;
    let terminated: boolean;
    let toNodeId: string;
    let toIsNew: boolean;
    let toTouchesEdgeId: string | null = null;

    if (junction) {
      if (junction.angle < MIN_CROSS_ANGLE) continue; // 交差角不足: この候補を棄却(先端は現在地で終端)
      endPoint = junction.point;
      terminated = true;
      if (junction.kind === "node" && junction.nodeId) {
        toNodeId = junction.nodeId;
        toIsNew = false;
      } else {
        toIsNew = true;
        toTouchesEdgeId = junction.targetEdgeId ?? null;
        toNodeId = ""; // 後で採番
      }
    } else {
      // proto-density 閾値(市街限定)
      if (proto(to.x, to.z) < PROTO_THRESHOLD) continue;
      // 水域
      if (waterField.waterSdf(to.x, to.z) < STREET_WIDTH / 2 + 1) continue;
      // 境界マージン
      if (boundaryInside(to) < BOUNDARY_CLEAR) continue;
      // centerPlan 予約領域
      if (inCenterReserve(to)) continue;
      // 並走(距離 10 未満で 16 以上続く走行を禁止)
      let allNear = true;
      for (const frac of [0.25, 0.5, 0.75, 1]) {
        const px = from.x + (to.x - from.x) * frac;
        const pz = from.z + (to.z - from.z) * frac;
        let nearest = Infinity;
        for (const s of queryBox(segHash, px - PARALLEL_DIST, px + PARALLEL_DIST, pz - PARALLEL_DIST, pz + PARALLEL_DIST)) {
          if (s.id === tip.excludeSegId) continue;
          nearest = Math.min(nearest, projectToSegment({ x: px, z: pz }, s.a, s.b).d);
        }
        if (nearest >= PARALLEL_DIST) {
          allNear = false;
          break;
        }
      }
      const newRun = allNear ? tip.parallelRun + length : 0;
      if (allNear && newRun >= PARALLEL_RUN_MAX) continue; // 並走停止

      endPoint = to;
      terminated = false;
      toIsNew = true;
      toNodeId = "";
      tip.parallelRun = newRun;
    }

    // 出発点(tip.nodeId)に既に他 edge が集まっている場合、その出発方向との
    // 交差角も 30° 以上を保つ(形状健全性 1 はスナップ接続に限らず「新しい
    // 交差」全般が対象のため、分岐・継続の出発方向がノード上の別の道と
    // 鋭角で重ならないようにする)。
    // 到着した edge(tip.arrivalEdgeId)は「単純な延長(継続)」の場合のみ
    // 除外する(parentEdgeId が非 null。緩い ±25° の曲がりは交差ではない)。
    // 分岐(parentEdgeId === null)は到着 edge とも 30° 以上を保つ必要がある
    // (分岐のキックが小さくなる/スナップで補正された結果、到着 edge と
    // 鋭角に重なる事態を防ぐ)。
    // 角度は実際に確定した endPoint(スナップで補正済みの場合を含む)への
    // 方向で測る(候補 to への方向のままだとスナップぶんの食い違いが生じる)
    if (tip.nodeId !== null) {
      const actualDeparture = Math.atan2(endPoint.z - from.z, endPoint.x - from.x);
      const existingHere = adjacency.get(tip.nodeId) ?? [];
      let departureConflict = false;
      for (const at of existingHere) {
        if (at.edgeId === tip.arrivalEdgeId && tip.parentEdgeId !== null) continue;
        if (angleDiff(actualDeparture, at.dir) < MIN_CROSS_ANGLE) {
          departureConflict = true;
          break;
        }
      }
      if (departureConflict) continue; // 先端はこの候補を棄却して終端する
    }

    // --- 受理: ノード・edge を確定する ---
    let fromNodeId = tip.nodeId;
    if (fromNodeId === null) {
      // ルート発芽点の初回セグメント: 起点ノードを遅延生成する。
      // 通常の発芽点は親 edge(必ず main/connector。恒久的に生存)の path 上の
      // 点(視覚的に接続)だが、中心前広場予定方向の特別な発芽点は center
      // からの相対位置であり既存道路には接していないため、touchesEdgeId は
      // 立てない(袋小路判定は通常の degree ベースに委ねる)
      fromNodeId = `node/street/${state.seed.id}/origin`;
      registerNode(fromNodeId, from);
      newNodes.push({ id: fromNodeId, position: from });
      nodeMeta.set(fromNodeId, {
        touchesEdgeId: state.seed.isCenterFront ? null : state.seed.edgeId,
      });
      state.originNodeId = fromNodeId;
    }

    const segIndex = state.acceptedCount;
    state.acceptedCount++;
    if (toIsNew) {
      toNodeId = `node/street/${state.seed.id}/${segIndex}`;
      registerNode(toNodeId, endPoint);
      newNodes.push({ id: toNodeId, position: endPoint });
      nodeMeta.set(toNodeId, { touchesEdgeId: toTouchesEdgeId });
    }

    const edgeId = claimEdgeId(`street/${state.seed.id}/${segIndex}`);
    const edgeDir = Math.atan2(endPoint.z - from.z, endPoint.x - from.x);
    newEdges.push({
      id: edgeId,
      from: fromNodeId,
      to: toNodeId,
      class: "street",
      width: STREET_WIDTH,
      path: [from, endPoint],
      grade: clamp(derived.roadGrade - STREET_GRADE_DROP, 0, 2),
    });
    insertSeg(from, endPoint, edgeId);
    addAdjacency(fromNodeId, edgeDir, edgeId);
    addAdjacency(toNodeId, edgeDir + Math.PI, edgeId);
    bumpDegree(fromNodeId, 1);
    bumpDegree(toNodeId, 1);
    totalLength += length;

    // このセグメントが「直前セグメントの単純な延長」であれば診断用に記録する
    // (verifyStreetShapeHealth が交差角チェックから除外するために使う。
    // 発芽直後・分岐直後のセグメントは対象外= parentEdgeId が null)
    if (tip.parentEdgeId !== null) {
      continuationPairs.add(pairKey(tip.parentEdgeId, edgeId));
    }

    if (!terminated) {
      queue.push({
        seq: tipSeq++,
        sprout: state,
        position: endPoint,
        direction: heading,
        isRoot: false,
        nodeId: toNodeId,
        excludeSegId: segSeq - 1,
        parentEdgeId: edgeId,
        arrivalEdgeId: edgeId,
        parallelRun: tip.parallelRun,
        priority: proto(endPoint.x, endPoint.z),
      });

      const branchProb = clamp(BRANCH_COEFF * proto(endPoint.x, endPoint.z), 0, BRANCH_MAX);
      if (slot.branch < branchProb) {
        queue.push({
          seq: tipSeq++,
          sprout: state,
          position: endPoint,
          direction: heading + kickAngle(slot.kick),
          isRoot: false,
          nodeId: toNodeId,
          excludeSegId: segSeq - 1,
          parentEdgeId: null,
          arrivalEdgeId: edgeId,
          parallelRun: 0,
          priority: proto(endPoint.x, endPoint.z),
        });
      }
    }
  }

  // --- 形状健全性 3: 袋小路率の上限(超過時は短い袋小路から間引く) ---
  // 事後の形状健全性間引き全体(並走・交差角・立体交差・袋小路率)が共有する
  // 補助データ: 生存 edge の判定(間引き済み edge の空間ハッシュ・touchesEdgeId
  // 残留参照を除外するため)と、edge id → from/to ノードの対応表
  // (端点共有の判定用)。isConnected が isLiveEdge を使うため、
  // pruneDeadEnds より先に定義する
  const edgesById = new Map(newEdges.map((e) => [e.id, e]));
  const existingEdgeIds = new Set(model.network.edges.map((e) => e.id));
  const isLiveEdge = (edgeId: string): boolean =>
    edgesById.has(edgeId) || existingEdgeIds.has(edgeId);
  const edgeFromTo = new Map<string, { from: string; to: string }>();
  for (const e of model.network.edges) edgeFromTo.set(e.id, { from: e.from, to: e.to });
  for (const e of newEdges) edgeFromTo.set(e.id, { from: e.from, to: e.to });

  const isConnected = (nodeId: string): boolean => {
    if (isPreExisting(nodeId)) return true;
    // touchesEdgeId は「スナップ先 edge が今も生存しているか」を都度確認する
    // (事後の間引きでスナップ先自体が消えると、視覚的な接続の根拠を失うため)
    const touchesEdgeId = nodeMeta.get(nodeId)?.touchesEdgeId;
    if (touchesEdgeId && isLiveEdge(touchesEdgeId)) return true;
    return (degree.get(nodeId) ?? 0) >= 2;
  };
  const ratioOf = (): number => {
    let total = 0;
    let dead = 0;
    for (const e of edgesById.values()) {
      for (const nodeId of [e.from, e.to]) {
        total++;
        if (!isConnected(nodeId)) dead++;
      }
    }
    return total > 0 ? dead / total : 0;
  };
  const pruneDeadEnds = (): void => {
    for (let guard = edgesById.size; guard >= 0 && ratioOf() > DEAD_END_RATIO_MAX; guard--) {
      let victim: StreetEdgeDraft | null = null;
      let victimLen = Infinity;
      for (const e of edgesById.values()) {
        if (isConnected(e.from) && isConnected(e.to)) continue;
        const len = pathLength(e.path);
        if (len < victimLen || (len === victimLen && (!victim || e.id < victim.id))) {
          victim = e;
          victimLen = len;
        }
      }
      if (!victim) break;
      edgesById.delete(victim.id);
      bumpDegree(victim.from, -1);
      bumpDegree(victim.to, -1);
    }
  };
  pruneDeadEnds();

  // --- 形状健全性 2: 並走の事後除去(成長時の停止判定は「その時点までに
  //     確定した道」のみを見るため、後から生えた別の発芽点の街路との
  //     並走は成長時には検出できない場合がある。全街路が出揃った状態で
  //     再検査し、該当する street を間引く。verifyStreetShapeHealth と
  //     同じ判定式を用いる) ---
  const sproutIdOfStreet = (edgeId: string): string | null => {
    const m = /^street\/(.+)\/\d+(?:\/\d+)?$/.exec(edgeId);
    return m ? (m[1] ?? null) : null;
  };
  const isStreetEdgeId = (edgeId: string): boolean => edgeId.startsWith("street/");
  const hasParallelViolation = (e: StreetEdgeDraft): boolean => {
    const a = e.path[0];
    const b = e.path[e.path.length - 1];
    if (!a || !b) return false;
    if (pathLength(e.path) < PARALLEL_RUN_MAX) return false;
    const sSproutId = sproutIdOfStreet(e.id);
    for (const frac of [0.2, 0.4, 0.6, 0.8]) {
      const px = a.x + (b.x - a.x) * frac;
      const pz = a.z + (b.z - a.z) * frac;
      // 空間ハッシュのバウンディングボックス検索で近傍セグメントのみに絞る
      // (性能節: 全 edge を毎回舐める O(edges) を避ける)
      let nearest = Infinity;
      for (const s of queryBox(
        segHash,
        px - PARALLEL_DIST,
        px + PARALLEL_DIST,
        pz - PARALLEL_DIST,
        pz + PARALLEL_DIST,
      )) {
        if (s.edgeId === e.id) continue;
        if (!isLiveEdge(s.edgeId)) continue;
        if (isStreetEdgeId(s.edgeId) && sSproutId !== null && sproutIdOfStreet(s.edgeId) === sSproutId) {
          continue;
        }
        const ft = edgeFromTo.get(s.edgeId);
        if (
          ft &&
          (ft.from === e.from || ft.from === e.to || ft.to === e.from || ft.to === e.to)
        ) {
          continue;
        }
        nearest = Math.min(nearest, projectToSegment({ x: px, z: pz }, s.a, s.b).d);
      }
      if (nearest >= PARALLEL_DIST) return false;
    }
    return true;
  };
  for (let guard = edgesById.size; guard >= 0; guard--) {
    let victim: StreetEdgeDraft | null = null;
    let victimLen = Infinity;
    for (const e of edgesById.values()) {
      if (!hasParallelViolation(e)) continue;
      const len = pathLength(e.path);
      if (len < victimLen || (len === victimLen && (!victim || e.id < victim.id))) {
        victim = e;
        victimLen = len;
      }
    }
    if (!victim) break;
    edgesById.delete(victim.id);
    bumpDegree(victim.from, -1);
    bumpDegree(victim.to, -1);
  }
  // 並走除去で新たに袋小路が生じうるため再度間引く
  pruneDeadEnds();

  // --- 形状健全性 1・4 の事後除去(交差角・立体交差): 成長時の受理判定は
  //     「その時点までに確定した道」のみを見るため、後から別の発芽点の
  //     街路が同じノード付近を通ることで生じる違反(時系列上の死角)は
  //     成長時には検出できない場合がある。全街路が出揃った状態で
  //     verifyStreetShapeHealth と同じ判定式により再検査し、該当する
  //     street を間引く ---
  const hasCrossAngleViolation = (e: StreetEdgeDraft): boolean => {
    for (const nodeId of [e.from, e.to]) {
      const at = adjacency.get(nodeId);
      if (!at) continue;
      const mine = at.find((a) => a.edgeId === e.id);
      if (!mine) continue;
      for (const other of at) {
        if (other.edgeId === e.id) continue;
        if (!isLiveEdge(other.edgeId)) continue; // 間引き済み edge の残留エントリ
        if (continuationPairs.has(pairKey(e.id, other.edgeId))) continue;
        if (angleDiff(mine.dir, other.dir) < MIN_CROSS_ANGLE) return true;
      }
    }
    return false;
  };
  const hasUnnodedCrossing = (e: StreetEdgeDraft): boolean => {
    const sa = e.path[0];
    const sb = e.path[e.path.length - 1];
    if (!sa || !sb) return false;
    // 空間ハッシュのバウンディングボックス検索で近傍セグメントのみに絞る
    // (性能節: 全 edge を毎回舐める O(edges) を避ける)
    const minX = Math.min(sa.x, sb.x);
    const maxX = Math.max(sa.x, sb.x);
    const minZ = Math.min(sa.z, sb.z);
    const maxZ = Math.max(sa.z, sb.z);
    const EPS = 1e-6;
    for (const s of queryBox(segHash, minX, maxX, minZ, maxZ)) {
      if (s.edgeId === e.id) continue;
      if (!isLiveEdge(s.edgeId)) continue; // 間引き済み edge の残留セグメント
      const ft = edgeFromTo.get(s.edgeId);
      if (
        ft &&
        (ft.from === e.from || ft.from === e.to || ft.to === e.from || ft.to === e.to)
      ) {
        continue; // ノードを共有する接続は交差ではない
      }
      const hit = segmentIntersection(sa, sb, s.a, s.b);
      if (!hit) continue;
      if (hit.t > EPS && hit.t < 1 - EPS && hit.u > EPS && hit.u < 1 - EPS) return true;
    }
    return false;
  };
  for (let guard = edgesById.size; guard >= 0; guard--) {
    let victim: StreetEdgeDraft | null = null;
    let victimLen = Infinity;
    for (const e of edgesById.values()) {
      if (!hasCrossAngleViolation(e) && !hasUnnodedCrossing(e)) continue;
      const len = pathLength(e.path);
      if (len < victimLen || (len === victimLen && (!victim || e.id < victim.id))) {
        victim = e;
        victimLen = len;
      }
    }
    if (!victim) break;
    edgesById.delete(victim.id);
    bumpDegree(victim.from, -1);
    bumpDegree(victim.to, -1);
  }
  // 交差・角度の除去で新たに袋小路が生じうるため再度間引く
  pruneDeadEnds();

  const survivorEdges = [...edgesById.values()];
  const usedNodeIds = new Set<string>();
  for (const e of survivorEdges) {
    usedNodeIds.add(e.from);
    usedNodeIds.add(e.to);
  }
  const survivorNodes = newNodes.filter((n) => usedNodeIds.has(n.id));

  model.network.nodes = [...model.network.nodes, ...survivorNodes];
  model.network.edges = [...model.network.edges, ...survivorEdges];
}

/**
 * 形状健全性 4 項の独立検証(`runNetwork` の末尾アサーションから呼ぶ)。
 * 成長時の受理条件と同じ規則を、確定済みの network.edges から再計算する
 * (生成器自身の内部状態を信頼せず、出力から独立に検証する設計判断)。
 * 違反はここでは throw せず件数のみ返す(呼び出し側が console に出す)。
 *
 * `continuationPairs`(growStreets の診断出力。任意)を渡すと、交差角の
 * 検証から「1本の街路が緩く曲がっているだけ」のペアを除外できる
 * (交差角の規則は独立な道どうしが出会う箇所のためのものであり、単一の
 * 街路の湾曲には適用しない。省略時は全ペアを検証するため、継続の緩い
 * 曲がりも交差として誤検出しうる点に注意)。
 */
export interface StreetShapeHealth {
  crossAngleViolations: number;
  parallelViolations: number;
  deadEndRatio: number;
  unnodedCrossings: number;
}

export function verifyStreetShapeHealth(
  model: WorldModel,
  continuationPairs?: Set<string>,
): StreetShapeHealth {
  const edges = model.network.edges;
  const streets = edges.filter((e) => e.class === "street");

  // 1) 交差角: street が絡む各ノードで、集まる edge どうしの最小交差角
  //    (同一街路の単純な延長ペアは除外する。上記関数コメント参照)
  const edgesAtNode = new Map<string, { edgeId: string; dir: number; cls: string }[]>();
  const push = (nodeId: string, edgeId: string, dir: number, cls: string): void => {
    const list = edgesAtNode.get(nodeId);
    if (list) list.push({ edgeId, dir, cls });
    else edgesAtNode.set(nodeId, [{ edgeId, dir, cls }]);
  };
  for (const e of edges) {
    const path = e.path;
    if (path.length < 2) continue;
    const a = path[0];
    const b = path[1];
    const y = path[path.length - 1];
    const x = path[path.length - 2];
    if (a && b) push(e.from, e.id, Math.atan2(b.z - a.z, b.x - a.x), e.class);
    if (x && y) push(e.to, e.id, Math.atan2(x.z - y.z, x.x - y.x), e.class);
  }
  let crossAngleViolations = 0;
  for (const list of edgesAtNode.values()) {
    if (list.length < 2) continue;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        if (!a || !b || a.edgeId === b.edgeId) continue;
        if (a.cls !== "street" && b.cls !== "street") continue;
        if (continuationPairs?.has(pairKey(a.edgeId, b.edgeId))) continue;
        if (angleDiff(a.dir, b.dir) < MIN_CROSS_ANGLE) crossAngleViolations++;
      }
    }
  }

  // 2) 並走: 各 street edge(単一セグメント)が全長にわたって「他の街路・
  //    道路」の PARALLEL_DIST 以内に収まり、かつ長さが PARALLEL_RUN_MAX 以上。
  //    同一発芽点の street(自分自身の続き)、および端点を共有する edge
  //    (発芽起点・スナップ接続で正当に接する隣接道路)は「並走」の対象外
  //    とする(並走は独立した道どうしが横並びに走る状態を指し、1本の
  //    街路が自身の起点・スナップ端で他道路に触れているのは並走ではない。
  //    サンプル点も両端を除いた内側のみを見る)
  const sproutIdOf = (edgeId: string): string | null => {
    const m = /^street\/(.+)\/\d+(?:\/\d+)?$/.exec(edgeId);
    return m ? (m[1] ?? null) : null;
  };
  let parallelViolations = 0;
  for (const s of streets) {
    const a = s.path[0];
    const b = s.path[s.path.length - 1];
    if (!a || !b) continue;
    const len = pathLength(s.path);
    if (len < PARALLEL_RUN_MAX) continue;
    const sSproutId = sproutIdOf(s.id);
    let allNear = true;
    for (const frac of [0.2, 0.4, 0.6, 0.8]) {
      const px = a.x + (b.x - a.x) * frac;
      const pz = a.z + (b.z - a.z) * frac;
      let nearest = Infinity;
      for (const other of edges) {
        if (other.id === s.id) continue;
        if (other.class === "street" && sSproutId !== null && sproutIdOf(other.id) === sSproutId) {
          continue;
        }
        if (
          other.from === s.from ||
          other.from === s.to ||
          other.to === s.from ||
          other.to === s.to
        ) {
          continue; // 端点を共有する隣接道路(起点・スナップ)は並走の対象外
        }
        for (let i = 0; i + 1 < other.path.length; i++) {
          const oa = other.path[i];
          const ob = other.path[i + 1];
          if (!oa || !ob) continue;
          nearest = Math.min(nearest, projectToSegment({ x: px, z: pz }, oa, ob).d);
        }
      }
      if (nearest >= PARALLEL_DIST) {
        allNear = false;
        break;
      }
    }
    if (allNear) parallelViolations++;
  }

  // 3) 袋小路率: street の端点のうち他道路に接続しない割合
  const degree = new Map<string, number>();
  for (const e of edges) {
    degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
    degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
  }
  const nodePos = new Map(model.network.nodes.map((n) => [n.id, n.position]));
  const touchesOtherRoad = (nodeId: string): boolean => {
    const p = nodePos.get(nodeId);
    if (!p) return false;
    for (const e of edges) {
      if (e.from === nodeId || e.to === nodeId) continue;
      for (let i = 0; i + 1 < e.path.length; i++) {
        const oa = e.path[i];
        const ob = e.path[i + 1];
        if (!oa || !ob) continue;
        if (projectToSegment(p, oa, ob).d <= SNAP_DIST) return true;
      }
    }
    return false;
  };
  let total = 0;
  let dead = 0;
  for (const s of streets) {
    for (const nodeId of [s.from, s.to]) {
      total++;
      const connected = (degree.get(nodeId) ?? 0) >= 2 || touchesOtherRoad(nodeId);
      if (!connected) dead++;
    }
  }
  const deadEndRatio = total > 0 ? dead / total : 0;

  // 4) 立体交差なし: 端点を共有しない edge どうしが「途中で」幾何交差して
  //    いない(street が絡む交差のみを対象とする)。
  //    交差点が s 自身の端点(t≈0 or 1)に一致する場合は「先端が既存道路の
  //    途中にスナップして止まった(既存 edge は分割しない設計)」という
  //    正常系であり、両端が内部(0<t<1 かつ 0<u<1)で交わる真の立体交差
  //    (ノード無しの X 字交差)のみを違反として数える
  let unnodedCrossings = 0;
  const INTERIOR_EPS = 1e-6;
  for (let i = 0; i < streets.length; i++) {
    const s = streets[i];
    if (!s) continue;
    const sa = s.path[0];
    const sb = s.path[s.path.length - 1];
    if (!sa || !sb) continue;
    for (const other of edges) {
      if (other.id === s.id) continue;
      // street 同士は各ペアを1回だけ数える(id の小さい方からのみ検査)
      if (other.class === "street" && other.id < s.id) continue;
      if (
        other.from === s.from ||
        other.from === s.to ||
        other.to === s.from ||
        other.to === s.to
      ) {
        continue; // ノードを共有する接続は交差ではない
      }
      for (let k = 0; k + 1 < other.path.length; k++) {
        const oa = other.path[k];
        const ob = other.path[k + 1];
        if (!oa || !ob) continue;
        const hit = segmentIntersection(sa, sb, oa, ob);
        if (!hit) continue;
        if (
          hit.t > INTERIOR_EPS &&
          hit.t < 1 - INTERIOR_EPS &&
          hit.u > INTERIOR_EPS &&
          hit.u < 1 - INTERIOR_EPS
        ) {
          unnodedCrossings++;
        }
      }
    }
  }

  return { crossAngleViolations, parallelViolations, deadEndRatio, unnodedCrossings };
}
