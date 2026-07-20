/**
 * 中心建築の敷地計画層(contracts/buildings.md「中心建築」節の
 * 「敷地計画(precinct plan)」)。
 *
 * 使用領域のローカル座標(u = 間口方向、v = 正面 → 背面。原点 = 中心、
 * 範囲 [−H, +H]。H = usable / 2)で、帯分割・中庭・囲い・量塊・
 * アプローチを**純データ**として決める。ワールド座標への変換・部品への
 * 展開は展開層(pipeline/center)の担当。three 非依存。
 *
 * 乱数は呼び出し元から渡されたストリームのみ消費する(消費数の固定は
 * 要求しない。契約「乱数」)。段12 内部の中間データであり WorldModel には
 * 持たせない(契約「敷地計画(precinct plan)」)。
 */
import type { Rng } from "../rng";

/** 中庭の種類(契約「敷地計画」の中庭 kind) */
export type CourtKind = "forecourt" | "main-court" | "cloister" | "work-yard";

/** 量塊の役割(契約「敷地計画」の量塊 role) */
export type MassRole = "main-hall" | "accent-tower" | "gatehouse" | "annex";

/** 囲いの硬さ(軸で決まる。契約 4軸表) */
export type EnclosureKind = "wall" | "low-wall" | "fence";

/** 支配軸(rankCenterAxes の dominant と同じ語彙) */
export type CenterAxis = "arcane" | "authority" | "waterside" | "rustic";

/** 開放辺(waterside の「水面側は開放」。null = 全周を囲う) */
export type OpenSide = "back" | "left" | "right" | null;

/** ローカル座標の軸平行矩形(u0 < u1、v0 < v1) */
export interface PrecinctRect {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

/** 中庭(矩形。契約: 中庭どうし・中庭と量塊は重ならない) */
export interface PrecinctCourt {
  kind: CourtKind;
  rect: PrecinctRect;
}

/** 量塊(矩形+階数+屋根型。accent-tower の高さは展開層が
 *  スカイライン契約から決めるため持たない) */
export interface PrecinctMass {
  role: MassRole;
  rect: PrecinctRect;
  /** main-hall / annex / gatehouse の階数(accent-tower は 0 = 未使用) */
  floors: number;
  roofType: "gable" | "hip";
  /** 棟方向が u 軸に沿うか(gable のみ意味を持つ) */
  ridgeAlongU: boolean;
}

/** 囲いの 1 セグメント(両端のローカル座標。厚み・高さは展開層) */
export interface EnclosureSegment {
  a: { u: number; v: number };
  b: { u: number; v: number };
}

/** 門(囲い上の開口。main = 正面の主門) */
export interface PrecinctGate {
  u: number;
  v: number;
  width: number;
  main: boolean;
}

/** 隅塔・門楼塔の基部(高さ上限 = accent-tower の 0.6 倍以下。契約) */
export interface PrecinctTurret {
  u: number;
  v: number;
  width: number;
}

/** 接続壁・回廊(契約: connector は接続対象と辺で接する) */
export interface PrecinctConnector {
  a: { u: number; v: number };
  b: { u: number; v: number };
}

/** 敷地計画の全体(planPrecinct の出力) */
export interface PrecinctPlan {
  axis: CenterAxis;
  /** 使用領域の一辺(下限 10 でクランプ済み。契約「縮退規則」) */
  usable: number;
  /** 帯分割(前庭帯 / 主庭帯 / 主館帯 の奥行き。合計 = usable) */
  bands: { forecourt: number; court: number; hall: number };
  courts: PrecinctCourt[];
  enclosure: {
    kind: EnclosureKind;
    openSide: OpenSide;
    segments: EnclosureSegment[];
  };
  gates: PrecinctGate[];
  turrets: PrecinctTurret[];
  masses: PrecinctMass[];
  connectors: PrecinctConnector[];
  /** アクセント塔の基部(masses にも role "accent-tower" で入る) */
  accentTower: { u: number; v: number; width: number };
}

/** planPrecinct の入力 */
export interface PrecinctInput {
  /** 支配軸(rankCenterAxes の dominant) */
  axis: CenterAxis;
  /** Monumentality(0〜1)。量塊数・囲いの立派さ・中庭の段数を駆動 */
  monument: number;
  /** 使用領域の一辺(クランプ前) */
  usable: number;
  /** 開放辺(waterside のみ非 null を渡す) */
  openSide: OpenSide;
  /**
   * アクセント塔の頂部高の目安(スカイライン契約の目標。
   * max(heightHint, 周辺最高点 × skylineRatio × 1.03))。
   * 高い塔ほど基部を太くし、細長い棒にならない比率を保つ(art-direction
   * 6節「素の角柱を目標高へ引き伸ばさない」)
   */
  towerTopHint: number;
  /** 骨格ストリーム("building/center") */
  rng: Rng;
}

/** 使用領域の一辺の下限(契約「縮退規則」) */
export const USABLE_MIN = 10;

// --- 縮退のしきい値(契約「縮退規則」の優先順を実装する提案値。
//     E5 の目視検収で調整しうる) ---
/** annex を置ける最小の usable(これ未満は annex 0) */
const ANNEX_MIN_USABLE = 19;
/** annex を 2 棟以上置ける最小の usable */
const ANNEX2_MIN_USABLE = 24;
/** gatehouse を置ける最小の usable */
const GATEHOUSE_MIN_USABLE = 16;
/** 全周の囲いを置ける最小の usable(これ未満は前面+側面の部分囲い) */
const FULL_ENCLOSURE_MIN_USABLE = 14;
/** 中庭を 2 段(前庭+主庭)にできる最小の usable */
const TWO_COURTS_MIN_USABLE = 13;

/** 囲いのオフセット(使用領域の縁から内側へ) */
const ENCLOSURE_INSET = 0.0;
/** 中庭と囲い・量塊の間の余白 */
const COURT_MARGIN = 0.6;
/** 主門の幅 */
const MAIN_GATE_W = 3.2;
/** 副門の幅 */
const SUB_GATE_W = 2.2;

const clamp = (x: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, x));

/**
 * 敷地計画を決める(契約「敷地計画(precinct plan)」)。
 * 縮退規則(契約): usable が狭いときは
 * (1) annex 数 → (2) gatehouse → (3) 囲いの部分化 → (4) 中庭の縮小
 * の順で落とす。main-hall と accent-tower は常に生成する。
 */
export function planPrecinct(input: PrecinctInput): PrecinctPlan {
  const { axis, monument, rng } = input;
  const usable = Math.max(USABLE_MIN, input.usable);
  const H = usable / 2;
  const openSide = axis === "waterside" ? input.openSide : null;

  // --- 帯分割(前庭 / 主庭 / 主館。比率は軸と乱数で連続変化) ---
  // rustic は前庭を持たず作業庭 1 つ(契約 4軸表)のため前庭帯を薄くする
  const forecourtRatio =
    axis === "rustic"
      ? 0.10 + 0.04 * rng.next()
      : 0.18 + 0.08 * rng.next();
  const hallRatio =
    axis === "rustic" ? 0.30 + 0.06 * rng.next() : 0.32 + 0.08 * rng.next();
  const forecourt = usable * forecourtRatio;
  const hall = usable * hallRatio;
  const court = usable - forecourt - hall;
  const bands = { forecourt, court, hall };
  // 帯境界の v 座標
  const vForecourtEnd = -H + forecourt;
  const vCourtEnd = vForecourtEnd + court;

  // --- 縮退判定(契約の優先順) ---
  const annexBudget =
    usable >= ANNEX2_MIN_USABLE
      ? clamp(Math.round(1 + 2.4 * monument), 1, 3)
      : usable >= ANNEX_MIN_USABLE
        ? 1
        : 0;
  const wantGatehouse =
    (axis === "authority" || axis === "arcane") &&
    usable >= GATEHOUSE_MIN_USABLE;
  const fullEnclosure = usable >= FULL_ENCLOSURE_MIN_USABLE;
  const twoCourts = usable >= TWO_COURTS_MIN_USABLE && axis !== "rustic";

  // --- 主館(main-hall。主館帯の中央) ---
  const hallW = usable * (0.55 + 0.2 * rng.next());
  const hw = hallW / 2;
  const hallDepth = hall * (0.78 + 0.12 * rng.next());
  const hallRect: PrecinctRect = {
    u0: -hw,
    u1: hw,
    v0: vCourtEnd,
    v1: vCourtEnd + hallDepth,
  };
  const hallFloors =
    axis === "authority"
      ? clamp(Math.round(2.2 + 1.8 * monument), 2, 4)
      : axis === "arcane"
        ? clamp(Math.round(2.0 + 1.6 * monument), 2, 4)
        : axis === "waterside"
          ? clamp(Math.round(2.0 + 1.2 * monument), 2, 3)
          : 2;
  const hallRoof: PrecinctMass["roofType"] =
    axis === "authority" || axis === "waterside" ? "hip" : "gable";

  const masses: PrecinctMass[] = [
    {
      role: "main-hall",
      rect: hallRect,
      floors: hallFloors,
      roofType: hallRoof,
      ridgeAlongU: true,
    },
  ];

  // --- アクセント塔(軸別の位置。契約 4軸表) ---
  // 幅は敷地比と目標高比の大きい方(高い塔ほど太く。頂部高の約 1/7)。
  // 上限は敷地比(狭い敷地で塔が主館を食わない)
  const towerW = clamp(
    Math.max(usable * 0.16, input.towerTopHint * 0.15),
    3.6,
    Math.max(4.2, usable * 0.26),
  );
  let towerU: number;
  let towerV: number;
  if (axis === "authority") {
    // 主館背後の天守型
    towerU = (rng.next() < 0.5 ? -1 : 1) * hallW * 0.18;
    towerV = Math.min(H - towerW / 2, hallRect.v1 - towerW * 0.2);
  } else if (axis === "arcane") {
    // 鐘楼型(聖堂型主館の脇)
    const s = rng.next() < 0.5 ? -1 : 1;
    towerU = s * (hw + towerW * 0.45);
    towerV = vCourtEnd + hallDepth * 0.35;
  } else if (axis === "waterside") {
    // 水際の隅(開放辺の側の背面隅。openSide が無ければ背面右)
    const s = openSide === "left" ? -1 : 1;
    towerU = s * (H - towerW / 2 - 0.4);
    towerV = H - towerW / 2 - 0.4;
  } else {
    // rustic: 鳩舎風の物見塔(主屋の脇。非対称)
    const s = rng.next() < 0.5 ? -1 : 1;
    towerU = s * (hw + towerW * 0.6 + 0.5);
    towerV = vCourtEnd + hallDepth * 0.5;
  }
  // 使用領域内へクランプ
  towerU = clamp(towerU, -H + towerW / 2, H - towerW / 2);
  towerV = clamp(towerV, -H + towerW / 2, H - towerW / 2);
  const accentTower = { u: towerU, v: towerV, width: towerW };
  masses.push({
    role: "accent-tower",
    rect: {
      u0: towerU - towerW / 2,
      u1: towerU + towerW / 2,
      v0: towerV - towerW / 2,
      v1: towerV + towerW / 2,
    },
    floors: 0,
    roofType: "hip",
    ridgeAlongU: true,
  });

  // --- 門楼(gatehouse。主門の位置に載る) ---
  if (wantGatehouse) {
    const gw = MAIN_GATE_W + 2.4;
    masses.push({
      role: "gatehouse",
      rect: { u0: -gw / 2, u1: gw / 2, v0: -H - 0.4, v1: -H + 2.6 },
      floors: 1,
      roofType: "hip",
      ridgeAlongU: true,
    });
  }

  // --- 離れ(annex。主庭帯の側縁に沿って置き、囲いに接する) ---
  const annexes: PrecinctRect[] = [];
  const annexSides: number[] =
    annexBudget >= 2 ? [-1, 1] : annexBudget === 1
      ? [rng.next() < 0.5 ? -1 : 1]
      : [];
  for (const s of annexSides) {
    // 開放辺(waterside)の側には置かない
    if ((openSide === "left" && s < 0) || (openSide === "right" && s > 0)) {
      continue;
    }
    const aw = usable * (0.16 + 0.05 * rng.next());
    const ad = clamp(court * (0.5 + 0.25 * rng.next()), 3.2, court);
    const v0 = vForecourtEnd + (court - ad) * rng.next();
    annexes.push({
      u0: s > 0 ? H - aw : -H,
      u1: s > 0 ? H : -H + aw,
      v0,
      v1: v0 + ad,
    });
  }
  // 3 棟目(高 Monumentality): 前庭帯の側縁
  if (annexBudget >= 3) {
    const s = annexSides.includes(-1) ? 1 : -1;
    const aw = usable * 0.16;
    annexes.push({
      u0: s > 0 ? H - aw : -H,
      u1: s > 0 ? H : -H + aw,
      v0: -H + 0.8,
      v1: -H + 0.8 + Math.max(3.0, forecourt - 1.2),
    });
  }
  for (const rect of annexes) {
    masses.push({
      role: "annex",
      rect,
      floors: 1 + (monument > 0.55 && rng.next() < 0.5 ? 1 : 0),
      roofType: "gable",
      ridgeAlongU: rect.u1 - rect.u0 > rect.v1 - rect.v0,
    });
  }

  // --- 中庭(量塊を避けた矩形。契約: 中庭と量塊は重ならない) ---
  const courts: PrecinctCourt[] = [];
  const sideInsetL = annexes.some((a) => a.u0 <= -H + 0.01)
    ? Math.max(...annexes.filter((a) => a.u0 <= -H + 0.01).map((a) => a.u1)) +
      COURT_MARGIN
    : -H + COURT_MARGIN;
  const sideInsetR = annexes.some((a) => a.u1 >= H - 0.01)
    ? Math.min(...annexes.filter((a) => a.u1 >= H - 0.01).map((a) => a.u0)) -
      COURT_MARGIN
    : H - COURT_MARGIN;
  const courtKind: CourtKind =
    axis === "arcane" ? "cloister" : axis === "rustic" ? "work-yard" : "main-court";
  if (twoCourts) {
    courts.push({
      kind: "forecourt",
      rect: {
        u0: -H + COURT_MARGIN,
        u1: H - COURT_MARGIN,
        v0: -H + COURT_MARGIN,
        v1: vForecourtEnd - COURT_MARGIN,
      },
    });
    courts.push({
      kind: courtKind,
      rect: {
        u0: sideInsetL,
        u1: sideInsetR,
        v0: vForecourtEnd + COURT_MARGIN,
        v1: vCourtEnd - COURT_MARGIN,
      },
    });
  } else {
    // 縮退(4): 中庭を 1 つに(rustic は常にこちら = work-yard 1 つ)
    courts.push({
      kind: axis === "rustic" ? "work-yard" : "forecourt",
      rect: {
        u0: sideInsetL,
        u1: sideInsetR,
        v0: -H + COURT_MARGIN,
        v1: vCourtEnd - COURT_MARGIN,
      },
    });
  }

  // --- 囲い(周回セグメント+門。開放辺・部分囲いを除く) ---
  const enclosureKind: EnclosureKind =
    axis === "authority" ? "wall" : axis === "rustic" ? "fence" : "low-wall";
  const E = H - ENCLOSURE_INSET;
  const gates: PrecinctGate[] = [{ u: 0, v: -E, width: MAIN_GATE_W, main: true }];
  const subGateCount =
    fullEnclosure && usable >= 20 ? (rng.next() < 0.5 ? 1 : 0) + (monument > 0.6 ? 1 : 0) : 0;
  const subGateSides = [-1, 1].slice(0, clamp(subGateCount, 0, 2));
  for (const s of subGateSides) {
    if ((openSide === "left" && s < 0) || (openSide === "right" && s > 0)) continue;
    gates.push({ u: s * E, v: vForecourtEnd + court * 0.4, width: SUB_GATE_W, main: false });
  }

  const segments: EnclosureSegment[] = [];
  /** 辺上の門を避けてセグメントを刻む(門幅ぶんの開口を空ける) */
  const addEdge = (
    ax: number, av: number, bx: number, bv: number,
    edgeGates: PrecinctGate[],
  ): void => {
    // u 方向の辺か v 方向の辺か
    const horizontal = av === bv;
    const from = horizontal ? Math.min(ax, bx) : Math.min(av, bv);
    const to = horizontal ? Math.max(ax, bx) : Math.max(av, bv);
    const cuts = edgeGates
      .map((g) => ({ at: horizontal ? g.u : g.v, w: g.width }))
      .sort((p, q) => p.at - q.at);
    let cursor = from;
    for (const c of cuts) {
      const lo = c.at - c.w / 2;
      const hi = c.at + c.w / 2;
      if (lo > cursor) {
        segments.push(
          horizontal
            ? { a: { u: cursor, v: av }, b: { u: lo, v: av } }
            : { a: { u: ax, v: cursor }, b: { u: ax, v: lo } },
        );
      }
      cursor = Math.max(cursor, hi);
    }
    if (cursor < to) {
      segments.push(
        horizontal
          ? { a: { u: cursor, v: av }, b: { u: to, v: av } }
          : { a: { u: ax, v: cursor }, b: { u: ax, v: to } },
      );
    }
  };

  // 前面(主門を刻む)
  addEdge(-E, -E, E, -E, gates.filter((g) => g.v === -E));
  // 側面(副門を刻む。部分囲いのときは主庭帯の途中まで)
  const sideEnd = fullEnclosure ? E : vCourtEnd - court * 0.3;
  if (openSide !== "left") {
    addEdge(-E, -E, -E, sideEnd, gates.filter((g) => g.u === -E));
  }
  if (openSide !== "right") {
    addEdge(E, -E, E, sideEnd, gates.filter((g) => g.u === E));
  }
  // 背面(全周囲いのときのみ。開放辺 back は除く)
  if (fullEnclosure && openSide !== "back") {
    addEdge(-E, E, E, E, []);
  }

  // --- 隅塔(authority のみ。2〜4。契約 4軸表) ---
  const turrets: PrecinctTurret[] = [];
  if (axis === "authority") {
    const tw = clamp(usable * 0.09, 2.0, 3.4);
    const corners: [number, number][] = fullEnclosure
      ? monument > 0.55
        ? [[-E, -E], [E, -E], [-E, E], [E, E]]
        : [[-E, -E], [E, -E]]
      : [[-E, -E], [E, -E]];
    for (const [u, v] of corners) turrets.push({ u, v, width: tw });
  }

  // --- 縫合(connector)。annex を主館または囲いへ接続する。
  //     囲いの縁(u = ±H)に接して置いた annex は囲いと接続済みとみなす ---
  const connectors: PrecinctConnector[] = [];
  for (const a of annexes) {
    const touchesEnclosure = a.u0 <= -H + 0.01 || a.u1 >= H - 0.01;
    if (!touchesEnclosure) {
      // 主館の前面へ短い接続壁(現計画では発生しないが契約の保証として実装)
      const cu = (a.u0 + a.u1) / 2;
      connectors.push({
        a: { u: cu, v: a.v1 },
        b: { u: cu, v: hallRect.v0 },
      });
    }
  }

  return {
    axis,
    usable,
    bands,
    courts,
    enclosure: { kind: enclosureKind, openSide, segments },
    gates,
    turrets,
    masses,
    connectors,
    accentTower,
  };
}
