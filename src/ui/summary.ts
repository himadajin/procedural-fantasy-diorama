/**
 * 生成結果サマリーの描画(読み取り専用。art-direction 9.5節)。
 * 先頭に生成記述文(やや大きい暖白・IM Fell English の欧文題字と同族の
 * 表示書体は使わず、記述文は日本語のため本文書体+やや大きめ)、以下は
 * ラベル(青灰 --text-lo)+値(暖白 --text-hi、数値は等幅 --font-mono)の行を
 * ヘアラインで区切る。UI に結界青緑は使わない(琥珀のみ)。
 * 複雑度(頂点数・インスタンス数・draw call・triangle)はレンダラー実測値
 * (renderer.info)を表示時に埋める(WorldModel には持たない。
 * contracts/vegetation-summary.md Summary 節の設計判断)。
 * PHASE 7 commit 22 で開発用デバッグ表示を本サマリーへ統合した:
 * ハッシュは「ハッシュ」行、renderer.info は「複雑度」行
 * (implementation-spec 1.10節、contracts/pipeline.md
 * 「描画プリセット・LOD・デバッグ表示」)。
 */
import { DEFAULT_PARAMS, type Params, type WorldModel } from "../model/worldmodel";

/** 複雑度の実測値(UI が renderer.info から埋める。表示時のみの量) */
export interface Complexity {
  vertices: number;
  instances: number;
  drawCalls: number;
  triangles: number;
}

/** パラメータの表示ラベル(design.md「入力」の順) */
const PARAM_LABELS: { key: keyof Params; label: string }[] = [
  { key: "worldScale", label: "World Scale" },
  { key: "settlement", label: "Settlement" },
  { key: "prosperity", label: "Prosperity" },
  { key: "water", label: "Water" },
  { key: "arcana", label: "Arcana" },
  { key: "monumentality", label: "Monumentality" },
];

/**
 * 建物役割の表示名(内部 role → 日本語)。ギャラリーの対象セレクタ
 * (G2)がラベル(role の日本語名)として再利用する
 */
export const ROLE_LABELS: Record<string, string> = {
  house: "住居",
  waterside: "水辺",
  bridgehead: "橋詰め",
  hall: "公館",
  warehouse: "倉庫",
  outskirt: "外縁",
  center: "中心建築",
};

/** buildingCounts をこの順で並べる(内訳の読みやすさ) */
const ROLE_ORDER = [
  "center",
  "hall",
  "house",
  "waterside",
  "bridgehead",
  "warehouse",
  "outskirt",
];

const WARD_LEVEL_LABELS = ["なし", "境界標", "部分結界", "完全結界"];

function fmtInt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

/** ラベル+値の1行(ヘアラインで区切る) */
function row(label: string, value: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "pfd-summary-row";
  const l = document.createElement("span");
  l.className = "pfd-summary-label";
  l.textContent = label;
  const v = document.createElement("span");
  v.className = "pfd-summary-value";
  v.textContent = value;
  el.append(l, v);
  return el;
}

function complexityText(complexity?: Complexity): string {
  return complexity
    ? `${fmtInt(complexity.drawCalls)} calls / ${(complexity.triangles / 1000).toFixed(1)}k tri / ${fmtInt(complexity.instances)} inst / ${(complexity.vertices / 1000).toFixed(1)}k 頂点`
    : "—";
}

/** サマリーの描画ハンドル(複雑度は表示時に随時更新できる) */
export interface SummaryView {
  /** 複雑度の目安を差し替える(レンダラー実測。他行は再描画しない) */
  setComplexity(complexity: Complexity): void;
}

/**
 * サマリーを container に描画する。
 * complexity はレンダラー実測(未取得なら省略可。後から setComplexity で更新)。
 */
export function renderSummary(
  container: HTMLElement,
  model: WorldModel,
  complexity?: Complexity,
): SummaryView {
  const s = model.summary;
  container.replaceChildren();

  // 先頭: 生成記述文(やや大きい暖白)
  const desc = document.createElement("p");
  desc.className = "pfd-summary-desc";
  desc.textContent = s.centerDescription;
  container.appendChild(desc);

  // seed
  container.appendChild(row("seed", model.meta.seed));

  // 使用パラメータ(既定と違う値は視認できるよう全て並べる)
  const params = model.meta.params;
  const paramText = PARAM_LABELS.map(({ key, label }) => {
    const v = params[key];
    const mark = v === DEFAULT_PARAMS[key] ? "" : "*";
    return `${label} ${v}${mark}`;
  }).join("  ");
  container.appendChild(row("パラメータ", paramText));

  // 建物数(役割別内訳)
  const total = Object.values(s.buildingCounts).reduce((a, b) => a + b, 0);
  const breakdown = ROLE_ORDER.filter((r) => s.buildingCounts[r]).map(
    (r) => `${ROLE_LABELS[r] ?? r} ${s.buildingCounts[r]}`,
  );
  container.appendChild(
    row("建物", `${fmtInt(total)}  (${breakdown.join(" / ") || "なし"})`),
  );

  // 水辺の概要
  const w = s.waterOverview;
  container.appendChild(
    row("水辺", `湖 ${w.lakes} / 池 ${w.ponds} / 水路 ${w.canals} / 橋 ${w.bridges}`),
  );

  // 結界構造
  const ward = s.wardOverview;
  const ringLen = ward.level >= 1 ? `周長 ${fmtInt(ward.ringLength)} / ` : "";
  container.appendChild(
    row(
      "結界",
      `${WARD_LEVEL_LABELS[ward.level] ?? ward.level}  (${ringLen}塔 ${ward.towers} / 門 ${ward.gates} / 聖域 ${ward.shrines} / 浮遊 ${ward.floaters})`,
    ),
  );

  // おおまかなスケール
  container.appendChild(
    row(
      "スケール",
      `一辺 ${fmtInt(s.scale.worldSize)} / 道 ${fmtInt(s.scale.roadLength)}`,
    ),
  );

  // 複雑度の目安(レンダラー実測。表示時に埋める)
  const cxRow = row("複雑度", complexityText(complexity));
  const cxValue = cxRow.querySelector<HTMLElement>(".pfd-summary-value");
  container.appendChild(cxRow);

  // 正規化ハッシュ(旧デバッグ表示の統合。実機・ブラウザ間の決定性確認用)
  container.appendChild(row("ハッシュ", `#${s.hash}`));

  return {
    setComplexity(next) {
      if (cxValue) cxValue.textContent = complexityText(next);
    },
  };
}

/**
 * 施設 kind の表示名(内部 kind → 日本語。Phase D。対象化した kind のみ。
 * D3〜D5 の各実装タスクが行を足す)
 */
const FACILITY_LABELS: Record<string, string> = {
  field: "畑",
  pasture: "牧草地",
};

/**
 * ギャラリー対象id(`building/<role>` / `facility/<kind>`)の表示ラベル
 * (日本語名)。対象セレクタ(G2)と簡易サマリーが共用する
 */
export function galleryTargetLabel(targetId: string): string {
  const name = targetId.split("/")[1] ?? targetId;
  return ROLE_LABELS[name] ?? FACILITY_LABELS[name] ?? name;
}

/**
 * ギャラリーの簡易サマリー(design.md「ギャラリー」節・計画書3.4節)。
 * 対象・seed・部品数・ハッシュのみの読み取り専用表示(本番サマリーの
 * 複雑度・水辺・結界などの箱庭スケールの情報は持たない)。
 */
export function renderGallerySummary(
  container: HTMLElement,
  targetId: string,
  model: WorldModel,
): void {
  container.replaceChildren();
  // 対象は建物または施設(Phase D)。どちらも parts を持つ
  const target = model.buildings[0] ?? model.facilities[0];

  container.appendChild(
    row("対象", `${galleryTargetLabel(targetId)} (${targetId})`),
  );
  container.appendChild(row("seed", model.meta.seed));
  container.appendChild(
    row("部品数", target ? fmtInt(target.parts.length) : "—"),
  );
  container.appendChild(row("ハッシュ", `#${model.summary.hash}`));
}
