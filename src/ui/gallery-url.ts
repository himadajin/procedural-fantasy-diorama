/**
 * ギャラリーの起動時URLパラメータ(`?gallery=<対象id>&seed=...&<関連パラメータ>`)の
 * 解析・直列化(implementation-spec 1.11節「ギャラリー」、
 * contracts/pipeline.md「ギャラリー生成エントリ」)。
 * DOM に依存しない純粋なロジックのみを持ち(URLSearchParams の入出力のみ)、
 * main.ts / panel.ts から呼ばれる。
 *
 * 関連パラメータは「造形に効くもの」に限る(contracts/pipeline.md
 * 「ギャラリー生成エントリ」節の入力定義)。対象により異なる:
 * 一般建物・施設は Prosperity / Settlement の 2 キーのみが対象生成に
 * 影響する。中心建築(`building/center`)は 4 軸スコアと派生値を通じて
 * Water / Arcana / Monumentality も効くため 5 キーとする。
 * 省略項目・不正値は design.md の既定値(50)を補う。
 */
import { DEFAULT_PARAMS, type Params } from "../model/worldmodel";

/** URL に載せる関連パラメータのキー(一般建物・施設。造形に効くもののみ) */
export const GALLERY_URL_PARAM_KEYS: readonly (keyof Params)[] = [
  "prosperity",
  "settlement",
];

/** 中心建築対象の関連パラメータのキー(4軸スコア・派生値に効くもの) */
export const CENTER_GALLERY_PARAM_KEYS: readonly (keyof Params)[] = [
  "prosperity",
  "settlement",
  "water",
  "arcana",
  "monumentality",
];

/** 対象idに応じた関連パラメータのキー(UI のスライダー表示と URL が共用) */
export function galleryUrlParamKeys(
  targetId: string,
): readonly (keyof Params)[] {
  return targetId === "building/center"
    ? CENTER_GALLERY_PARAM_KEYS
    : GALLERY_URL_PARAM_KEYS;
}

export interface GalleryUrlState {
  targetId: string;
  seed: string;
  params: Params;
}

/** 0〜100 の整数へクランプする。欠落・非数値は fallback を返す */
function clampParam(raw: string | null, fallback: number): number {
  if (raw === null) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(100, Math.max(0, Math.round(n)));
}

/**
 * `location.search`(`?`の有無いずれも可)を解析する。
 * `gallery` パラメータが無い、または `knownTargetIds` に含まれない
 * (未知の対象id)場合は null を返す — 起動時はギャラリータブを開かず、
 * 従来どおり箱庭タブでの自動生成を行う(implementation-spec 1.11節)。
 */
export function parseGalleryUrl(
  search: string,
  knownTargetIds: readonly string[],
  defaultSeed: string,
): GalleryUrlState | null {
  const q = new URLSearchParams(search);
  const targetId = q.get("gallery");
  if (!targetId || !knownTargetIds.includes(targetId)) return null;

  const seedRaw = q.get("seed")?.trim();
  const seed = seedRaw || defaultSeed;

  const params: Params = { ...DEFAULT_PARAMS };
  for (const key of galleryUrlParamKeys(targetId)) {
    params[key] = clampParam(q.get(key), DEFAULT_PARAMS[key]);
  }

  return { targetId, seed, params };
}

/**
 * ギャラリーの現在状態を `?gallery=...` クエリ文字列へ直列化する
 * (`history.replaceState` 用。先頭に `?` を含む)。
 */
export function serializeGalleryUrl(
  targetId: string,
  seed: string,
  params: Params,
): string {
  const q = new URLSearchParams();
  q.set("gallery", targetId);
  q.set("seed", seed);
  for (const key of galleryUrlParamKeys(targetId)) {
    q.set(key, String(params[key]));
  }
  return `?${q.toString()}`;
}
