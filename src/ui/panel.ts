/**
 * 非モーダルのパラメータパネル。
 * 大画面=浮く右サイドパネル(開閉トグル)、
 * モバイル=浮くボトムシート(半開/全開。半開は seed + Randomize + Generate のみ)。
 * 造形・文言の方針は art-direction 9節、スライダーの定義は design.md を正とする。
 */
import { DEFAULT_PARAMS, type Params } from "../model/worldmodel";

interface SliderDef {
  key: keyof Params;
  name: string;
  description: string;
}

/** design.md「入力」の6パラメータ。順序も同文書に従う */
const SLIDERS: SliderDef[] = [
  {
    key: "worldScale",
    name: "World Scale / 敷地規模",
    description: "箱庭全体の広さ、生成される建築量、道や外縁の余裕に影響する。",
  },
  {
    key: "settlement",
    name: "Settlement Pressure / 居住圧力",
    description: "建物や道の集まりやすさ、中心部の密度、外縁への広がりに影響する。",
  },
  {
    key: "prosperity",
    name: "Prosperity / 繁栄度",
    description: "建物の整備度、素材の上質さ、屋根・窓・道・広場の見栄えに影響する。",
  },
  {
    key: "water",
    name: "Water Presence / 水辺の強さ",
    description: "川、湖、街を通る水路、橋、岸辺、水辺の建築に影響する。",
  },
  {
    key: "arcana",
    name: "Arcana / 魔法の濃さ",
    description: "結界、魔導塔、魔法灯、発光する紋様や浮遊要素の現れやすさに影響する。",
  },
  {
    key: "monumentality",
    name: "Monumentality / 中心建築の格",
    description: "中心建築の大きさと存在感、周辺の広場や道の集まり方に影響する。",
  },
];

export interface Panel {
  getSeed(): string;
  setSeed(seed: string): void;
  getParams(): Params;
  /** サマリー領域(生成結果・デバッグ表示の描画先) */
  summaryElement: HTMLElement;
}

/** Math.random を使わない seed 生成(implementation-spec 1.4節の規約) */
function randomSeed(): string {
  const buf = new Uint32Array(2);
  crypto.getRandomValues(buf);
  return Array.from(buf, (n) => n.toString(36).padStart(7, "0"))
    .join("")
    .slice(0, 12);
}

const DICE_SVG = `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
  <rect x="2.5" y="2.5" width="15" height="15" rx="3" stroke="currentColor" stroke-width="1.5"/>
  <circle cx="7" cy="7" r="1.4" fill="currentColor"/>
  <circle cx="13" cy="7" r="1.4" fill="currentColor"/>
  <circle cx="10" cy="10" r="1.4" fill="currentColor"/>
  <circle cx="7" cy="13" r="1.4" fill="currentColor"/>
  <circle cx="13" cy="13" r="1.4" fill="currentColor"/>
</svg>`;

export function createPanel(
  root: HTMLElement,
  defaultSeed: string,
  onGenerate: (seed: string, params: Params) => void,
): Panel {
  root.dataset.panelOpen = "true";
  root.dataset.sheet = "half";

  const panel = document.createElement("section");
  panel.className = "pfd-panel";
  panel.setAttribute("aria-label", "生成パラメータ");

  // ボトムシートのつまみ(モバイルのみ表示)
  const handle = document.createElement("button");
  handle.type = "button";
  handle.className = "pfd-sheet-handle";
  handle.setAttribute("aria-label", "パネルを開閉");

  const scroll = document.createElement("div");
  scroll.className = "pfd-panel-scroll";

  const title = document.createElement("h1");
  title.className = "pfd-title";
  title.textContent = "Procedural Fantasy Diorama";

  // seed 行
  const seedRow = document.createElement("div");
  seedRow.className = "pfd-seed-row";
  const seedLabel = document.createElement("label");
  seedLabel.className = "pfd-seed-label";
  seedLabel.htmlFor = "pfd-seed";
  seedLabel.textContent = "seed";
  const seedInput = document.createElement("input");
  seedInput.id = "pfd-seed";
  seedInput.className = "pfd-seed-input";
  seedInput.type = "text";
  seedInput.spellcheck = false;
  seedInput.autocomplete = "off";
  seedInput.value = defaultSeed;
  const dice = document.createElement("button");
  dice.type = "button";
  dice.className = "pfd-ghost-btn";
  dice.title = "Randomize Seed";
  dice.setAttribute("aria-label", "Randomize Seed(seed欄を新しい値にする。再生成はしない)");
  dice.innerHTML = DICE_SVG;
  // Randomize Seed は seed 入力欄だけを更新する。再生成は Generate 押下時のみ
  dice.addEventListener("click", () => {
    seedInput.value = randomSeed();
  });
  seedRow.append(seedLabel, seedInput, dice);

  // スライダー群(値の反映は Generate 押下時のみ。変更では再生成しない)
  const sliders = document.createElement("div");
  sliders.className = "pfd-sliders";
  const inputs = new Map<keyof Params, HTMLInputElement>();
  for (const def of SLIDERS) {
    const wrap = document.createElement("div");
    wrap.className = "pfd-param";
    const head = document.createElement("div");
    head.className = "pfd-param-head";
    const name = document.createElement("label");
    name.className = "pfd-param-name";
    name.htmlFor = `pfd-param-${def.key}`;
    name.textContent = def.name;
    const value = document.createElement("output");
    value.className = "pfd-param-value";
    value.textContent = String(DEFAULT_PARAMS[def.key]);
    head.append(name, value);

    const range = document.createElement("input");
    range.id = `pfd-param-${def.key}`;
    range.className = "pfd-range";
    range.type = "range";
    range.min = "0";
    range.max = "100";
    range.step = "1";
    range.value = String(DEFAULT_PARAMS[def.key]);
    range.style.setProperty("--fill", `${DEFAULT_PARAMS[def.key]}%`);
    range.addEventListener("input", () => {
      value.textContent = range.value;
      range.style.setProperty("--fill", `${range.value}%`);
    });

    const desc = document.createElement("p");
    desc.className = "pfd-param-desc";
    desc.textContent = def.description;

    wrap.append(head, range, desc);
    sliders.appendChild(wrap);
    inputs.set(def.key, range);
  }

  // Generate(パネル内唯一の塗りボタン)
  const generate = document.createElement("button");
  generate.type = "button";
  generate.className = "pfd-generate";
  generate.textContent = "Generate";

  const hairline1 = document.createElement("hr");
  hairline1.className = "pfd-hairline";
  const hairline2 = document.createElement("hr");
  hairline2.className = "pfd-hairline";

  // サマリー(読み取り専用。内容は後続PHASEで埋める)
  const summary = document.createElement("div");
  summary.className = "pfd-summary";
  summary.setAttribute("aria-live", "polite");

  scroll.append(title, seedRow, hairline1, sliders, generate, hairline2, summary);

  // 大画面用: パネルを閉じるトグル
  const close = document.createElement("div");
  close.className = "pfd-panel-close";
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "pfd-ghost-btn";
  closeBtn.setAttribute("aria-label", "パネルを閉じる");
  closeBtn.textContent = "×";
  closeBtn.addEventListener("click", () => {
    root.dataset.panelOpen = "false";
  });
  close.appendChild(closeBtn);

  panel.append(handle, scroll, close);

  // 大画面用: 閉じたパネルを開くボタン
  const open = document.createElement("div");
  open.className = "pfd-panel-open";
  const openBtn = document.createElement("button");
  openBtn.type = "button";
  openBtn.className = "pfd-ghost-btn";
  openBtn.setAttribute("aria-label", "パネルを開く");
  openBtn.textContent = "☰";
  openBtn.addEventListener("click", () => {
    root.dataset.panelOpen = "true";
  });
  open.appendChild(openBtn);

  // ボトムシート: つまみのタップで半開/全開を切り替え、ドラッグでも切り替え
  const setSheet = (state: "half" | "full") => {
    root.dataset.sheet = state;
    handle.setAttribute("aria-expanded", state === "full" ? "true" : "false");
  };
  let dragStart: number | null = null;
  let dragged = false;
  handle.addEventListener("pointerdown", (e) => {
    dragStart = e.clientY;
    dragged = false;
    handle.setPointerCapture(e.pointerId);
  });
  handle.addEventListener("pointermove", (e) => {
    if (dragStart === null) return;
    const dy = e.clientY - dragStart;
    if (Math.abs(dy) > 24) {
      setSheet(dy < 0 ? "full" : "half");
      dragged = true;
      dragStart = e.clientY;
    }
  });
  handle.addEventListener("pointerup", () => {
    if (!dragged) {
      setSheet(root.dataset.sheet === "half" ? "full" : "half");
    }
    dragStart = null;
  });
  setSheet("half");

  const getParams = (): Params => {
    const params = { ...DEFAULT_PARAMS };
    for (const [key, input] of inputs) {
      params[key] = Number(input.value);
    }
    return params;
  };

  generate.addEventListener("click", () => {
    onGenerate(seedInput.value.trim() || "0", getParams());
  });

  root.append(panel, open);

  return {
    getSeed: () => seedInput.value.trim() || "0",
    setSeed: (seed) => {
      seedInput.value = seed;
    },
    getParams,
    summaryElement: summary,
  };
}
