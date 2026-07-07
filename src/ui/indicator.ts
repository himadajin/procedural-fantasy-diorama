/**
 * Generating インジケーター: 上部中央の小さなピル。
 * 琥珀の点滅ドット+現在のパイプラインステップ名(art-direction 9.5節)。
 * 全画面ローディングは使わない。
 */
export interface Indicator {
  show(stepName: string): void;
  hide(): void;
}

export function createIndicator(root: HTMLElement): Indicator {
  const pill = document.createElement("div");
  pill.className = "pfd-indicator";
  pill.setAttribute("role", "status");
  pill.hidden = true;

  const dot = document.createElement("span");
  dot.className = "pfd-indicator-dot";
  const label = document.createElement("span");
  label.className = "pfd-indicator-label";

  pill.append(dot, label);
  root.appendChild(pill);

  return {
    show(stepName) {
      label.textContent = stepName;
      pill.hidden = false;
    },
    hide() {
      pill.hidden = true;
    },
  };
}
