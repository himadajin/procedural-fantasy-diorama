/**
 * 開発用デバッグオーバーレイ: WorldModel 正規化ハッシュ、renderer.info
 * (draw call / triangle 数)、描画プリセット名を画面隅に小さく表示する。
 * PHASE 7 commit 22 でハッシュ・renderer.info はサマリーの
 * 「複雑度」「ハッシュ」行へ統合し、本オーバーレイは既定非表示・
 * URL パラメータ `?debug=1` のときのみ main が生成する
 * (implementation-spec 1.10節、contracts/pipeline.md
 * 「描画プリセット・LOD・デバッグ表示」)。
 * 造形は art-direction 9節のトークンに従い、絵の露出を邪魔しない控えめさに留める。
 */
export interface DebugOverlay {
  setHash(hash: string): void;
  setRenderInfo(calls: number, triangles: number): void;
  /** 描画プリセット名(例 "high" / "low (fps補正)")を表示する */
  setPreset(label: string): void;
}

/** draw call 予算(implementation-spec 1.8節)。表示は「実測/予算」の常時比較 */
const DRAW_CALL_BUDGET = 50;

export function createDebugOverlay(container: HTMLElement): DebugOverlay {
  const el = document.createElement("div");
  el.className = "pfd-debug";
  el.setAttribute("aria-hidden", "true");
  const hashEl = document.createElement("span");
  const infoEl = document.createElement("span");
  const presetEl = document.createElement("span");
  el.append(hashEl, infoEl, presetEl);
  container.appendChild(el);
  return {
    setHash: (hash) => {
      hashEl.textContent = `#${hash}`;
    },
    setRenderInfo: (calls, triangles) => {
      infoEl.textContent = `${calls}/${DRAW_CALL_BUDGET} calls · ${(triangles / 1000).toFixed(1)}k tri`;
    },
    setPreset: (label) => {
      presetEl.textContent = `preset ${label}`;
    },
  };
}
