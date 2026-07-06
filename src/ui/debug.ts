/**
 * 開発用デバッグ表示: WorldModel 正規化ハッシュと renderer.info
 * (draw call / triangle 数)を画面隅に小さく常時表示する
 * (implementation-spec 1.10節。PHASE 7 でサマリーの「複雑度の目安」へ統合)。
 * 造形は art-direction 9節のトークンに従い、絵の露出を邪魔しない控えめさに留める。
 */
export interface DebugOverlay {
  setHash(hash: string): void;
  setRenderInfo(calls: number, triangles: number): void;
}

export function createDebugOverlay(container: HTMLElement): DebugOverlay {
  const el = document.createElement("div");
  el.className = "pfd-debug";
  el.setAttribute("aria-hidden", "true");
  const hashEl = document.createElement("span");
  const infoEl = document.createElement("span");
  el.append(hashEl, infoEl);
  container.appendChild(el);
  return {
    setHash: (hash) => {
      hashEl.textContent = `#${hash}`;
    },
    setRenderInfo: (calls, triangles) => {
      infoEl.textContent = `${calls} calls · ${(triangles / 1000).toFixed(1)}k tri`;
    },
  };
}
