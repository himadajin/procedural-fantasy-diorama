/**
 * 非モーダルのパラメータパネル。
 * 大画面=浮く右サイドパネル(開閉トグル)、
 * モバイル=浮くボトムシート(半開/全開。半開は seed + Randomize + Generate のみ)。
 * 造形・文言の方針は art-direction 9節、スライダーの定義は design.md を正とする。
 *
 * パネル上部の「箱庭 / ギャラリー」タブ(design.md「UI とサマリー」節、
 * 「ギャラリー(語彙の単体鑑賞)」節)で2つの表示を切り替える。
 * タブは表示の切替のみを行い、箱庭とギャラリーの生成状態
 * (seed・パラメータ・入力欄の値)は互いに独立に保持する
 * (共有状態を作らない)。
 */
import { DEFAULT_PARAMS, type Params } from "../model/worldmodel";
import { CENTER_GALLERY_PARAM_KEYS, galleryUrlParamKeys } from "./gallery-url";

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
    description:
      "建物や道の集まりやすさ、中心部の密度、外縁への広がり、農村ゾーンに広がる畑や牧草地の量に影響する。",
  },
  {
    key: "prosperity",
    name: "Prosperity / 繁栄度",
    description:
      "建物の整備度、素材の上質さ、屋根・窓・梁・道・広場の見栄え、広場に並ぶ市場の屋台や井戸、風車の現れやすさに影響する。",
  },
  {
    key: "water",
    name: "Water Presence / 水辺の強さ",
    description: "湖や池、街を通る水路、橋、岸辺、水辺の建築、水車、桟橋に影響する。",
  },
  {
    key: "arcana",
    name: "Arcana / 魔法の濃さ",
    description:
      "魔導塔、結界門、聖域、魔法灯、発光する紋様や水晶、小さな浮遊要素の現れやすさに影響する。最低値では魔法要素が消え、素朴な中世風の集落になる。",
  },
  {
    key: "monumentality",
    name: "Monumentality / 中心建築の格",
    description: "中心建築の大きさ、格、存在感、周辺の広場や道の集まり方に影響する。",
  },
];

/**
 * ギャラリーで公開するスライダー(contracts/pipeline.md
 * 「ギャラリー生成エントリ」節の入力定義「関連パラメータ(造形に効く
 * もののみ)」)。対象により異なるため、全対象のキーの和集合ぶんの
 * スライダーを生成し、選択中の対象のキー(`galleryUrlParamKeys`)のみを
 * 表示・適用する。一般建物・施設は Prosperity / Settlement の 2 キー、
 * 中心建築は 4 軸スコア・派生値に効く 5 キー
 */
const GALLERY_SLIDERS = SLIDERS.filter((d) =>
  CENTER_GALLERY_PARAM_KEYS.includes(d.key),
);

export type TabKey = "world" | "gallery";

export interface GalleryTarget {
  /** 対象id(`building/<role>` 等。contracts/pipeline.md「対象idの体系」) */
  id: string;
  /** 表示ラベル(日本語の role 名) */
  label: string;
}

export interface GalleryPanelInit {
  targets: readonly GalleryTarget[];
  defaultTargetId: string;
  defaultSeed: string;
  /** 初期スライダー値(URL起動時はここに反映済みの値を渡す) */
  defaultParams: Params;
  onGenerate: (targetId: string, seed: string, params: Params) => void;
}

export interface Panel {
  getSeed(): string;
  setSeed(seed: string): void;
  getParams(): Params;
  /** サマリー領域(生成結果・デバッグ表示の描画先) */
  summaryElement: HTMLElement;

  gallery: {
    getTargetId(): string;
    getSeed(): string;
    getParams(): Params;
    /** ギャラリー用の簡易サマリー領域(描画先) */
    summaryElement: HTMLElement;
  };

  /** タブを切り替える(表示のみ。生成状態には触れない) */
  setActiveTab(tab: TabKey): void;
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

/** seed 入力欄+Randomize Seed(ダイス)の行。Randomize は欄を更新するのみ(再生成しない) */
function buildSeedRow(idPrefix: string, initialSeed: string): {
  row: HTMLElement;
  input: HTMLInputElement;
} {
  const seedRow = document.createElement("div");
  seedRow.className = "pfd-seed-row";
  const seedLabel = document.createElement("label");
  seedLabel.className = "pfd-seed-label";
  seedLabel.htmlFor = `${idPrefix}-seed`;
  seedLabel.textContent = "seed";
  const seedInput = document.createElement("input");
  seedInput.id = `${idPrefix}-seed`;
  seedInput.className = "pfd-seed-input";
  seedInput.type = "text";
  seedInput.spellcheck = false;
  seedInput.autocomplete = "off";
  seedInput.value = initialSeed;
  const dice = document.createElement("button");
  dice.type = "button";
  dice.className = "pfd-ghost-btn";
  dice.title = "Randomize Seed";
  dice.setAttribute("aria-label", "Randomize Seed(seed欄を新しい値にする。再生成はしない)");
  dice.innerHTML = DICE_SVG;
  dice.addEventListener("click", () => {
    seedInput.value = randomSeed();
  });
  seedRow.append(seedLabel, seedInput, dice);
  return { row: seedRow, input: seedInput };
}

/** スライダー1個ぶんの行(値の反映は呼び出し側の Generate 押下時のみ) */
function buildSliderRow(
  idPrefix: string,
  def: SliderDef,
  initial: number,
): { wrap: HTMLElement; range: HTMLInputElement } {
  const wrap = document.createElement("div");
  wrap.className = "pfd-param";
  const head = document.createElement("div");
  head.className = "pfd-param-head";
  const name = document.createElement("label");
  name.className = "pfd-param-name";
  name.htmlFor = `${idPrefix}-param-${def.key}`;
  name.textContent = def.name;
  const value = document.createElement("output");
  value.className = "pfd-param-value";
  value.textContent = String(initial);
  head.append(name, value);

  const range = document.createElement("input");
  range.id = `${idPrefix}-param-${def.key}`;
  range.className = "pfd-range";
  range.type = "range";
  range.min = "0";
  range.max = "100";
  range.step = "1";
  range.value = String(initial);
  range.style.setProperty("--fill", `${initial}%`);
  range.addEventListener("input", () => {
    value.textContent = range.value;
    range.style.setProperty("--fill", `${range.value}%`);
  });

  const desc = document.createElement("p");
  desc.className = "pfd-param-desc";
  desc.textContent = def.description;

  wrap.append(head, range, desc);
  return { wrap, range };
}

export function createPanel(
  root: HTMLElement,
  defaultSeed: string,
  onGenerate: (seed: string, params: Params) => void,
  galleryInit: GalleryPanelInit,
  initialTab: TabKey = "world",
  onTabChange?: (tab: TabKey) => void,
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

  // --- タブ(箱庭 / ギャラリー)。パネル上部・半開/全開どちらでも常に見える ---
  const tabs = document.createElement("div");
  tabs.className = "pfd-tabs";
  tabs.setAttribute("role", "tablist");
  const worldTabBtn = document.createElement("button");
  worldTabBtn.type = "button";
  worldTabBtn.className = "pfd-tab";
  worldTabBtn.setAttribute("role", "tab");
  worldTabBtn.textContent = "箱庭";
  const galleryTabBtn = document.createElement("button");
  galleryTabBtn.type = "button";
  galleryTabBtn.className = "pfd-tab";
  galleryTabBtn.setAttribute("role", "tab");
  galleryTabBtn.textContent = "ギャラリー";
  tabs.append(worldTabBtn, galleryTabBtn);

  // --- 箱庭タブの内容(既存のパネル一式) ---
  const worldView = document.createElement("div");
  worldView.className = "pfd-view";
  worldView.setAttribute("role", "tabpanel");

  const { row: seedRow, input: seedInput } = buildSeedRow("pfd-world", defaultSeed);

  const sliders = document.createElement("div");
  sliders.className = "pfd-sliders";
  const inputs = new Map<keyof Params, HTMLInputElement>();
  for (const def of SLIDERS) {
    const { wrap, range } = buildSliderRow("pfd-world", def, DEFAULT_PARAMS[def.key]);
    sliders.appendChild(wrap);
    inputs.set(def.key, range);
  }

  const generate = document.createElement("button");
  generate.type = "button";
  generate.className = "pfd-generate";
  generate.textContent = "Generate";

  const hairline1 = document.createElement("hr");
  hairline1.className = "pfd-hairline";
  const hairline2 = document.createElement("hr");
  hairline2.className = "pfd-hairline";

  const summary = document.createElement("div");
  summary.className = "pfd-summary";
  summary.setAttribute("aria-live", "polite");

  worldView.append(seedRow, hairline1, sliders, generate, hairline2, summary);

  // --- ギャラリータブの内容(対象・seed・関連パラメータ・生成・再抽選・簡易サマリー) ---
  const galleryView = document.createElement("div");
  galleryView.className = "pfd-view";
  galleryView.setAttribute("role", "tabpanel");

  const targetRow = document.createElement("div");
  targetRow.className = "pfd-gallery-target-row";
  const targetLabel = document.createElement("label");
  targetLabel.className = "pfd-seed-label";
  targetLabel.htmlFor = "pfd-gallery-target";
  targetLabel.textContent = "対象";
  const targetSelect = document.createElement("select");
  targetSelect.id = "pfd-gallery-target";
  targetSelect.className = "pfd-select";
  for (const t of galleryInit.targets) {
    const opt = document.createElement("option");
    opt.value = t.id;
    opt.textContent = t.label;
    targetSelect.appendChild(opt);
  }
  targetSelect.value = galleryInit.defaultTargetId;
  targetRow.append(targetLabel, targetSelect);

  const { row: gallerySeedRow, input: gallerySeedInput } = buildSeedRow(
    "pfd-gallery",
    galleryInit.defaultSeed,
  );

  const galleryHairline1 = document.createElement("hr");
  galleryHairline1.className = "pfd-hairline";
  const galleryHairline2 = document.createElement("hr");
  galleryHairline2.className = "pfd-hairline";

  const gallerySliders = document.createElement("div");
  gallerySliders.className = "pfd-sliders";
  const galleryInputs = new Map<keyof Params, HTMLInputElement>();
  const gallerySliderRows = new Map<keyof Params, HTMLElement>();
  for (const def of GALLERY_SLIDERS) {
    const { wrap, range } = buildSliderRow(
      "pfd-gallery",
      def,
      galleryInit.defaultParams[def.key],
    );
    gallerySliders.appendChild(wrap);
    galleryInputs.set(def.key, range);
    gallerySliderRows.set(def.key, wrap);
  }
  // 選択中の対象に関連するスライダーのみ表示する(キーは URL と共用)
  const updateGallerySliderVisibility = (): void => {
    const keys = galleryUrlParamKeys(targetSelect.value);
    for (const [key, wrap] of gallerySliderRows) {
      wrap.style.display = keys.includes(key) ? "" : "none";
    }
  };
  updateGallerySliderVisibility();
  targetSelect.addEventListener("change", updateGallerySliderVisibility);

  const galleryActions = document.createElement("div");
  galleryActions.className = "pfd-gallery-actions";
  const galleryGenerate = document.createElement("button");
  galleryGenerate.type = "button";
  galleryGenerate.className = "pfd-generate";
  galleryGenerate.textContent = "Generate";
  const galleryReroll = document.createElement("button");
  galleryReroll.type = "button";
  galleryReroll.className = "pfd-ghost-btn";
  galleryReroll.title = "Reroll";
  galleryReroll.setAttribute(
    "aria-label",
    "次の個体を生成する(seedを送って直ちに再生成する)",
  );
  galleryReroll.textContent = "↻";
  galleryActions.append(galleryGenerate, galleryReroll);

  const gallerySummary = document.createElement("div");
  gallerySummary.className = "pfd-summary";
  gallerySummary.setAttribute("aria-live", "polite");

  galleryView.append(
    targetRow,
    gallerySeedRow,
    galleryHairline1,
    gallerySliders,
    galleryActions,
    galleryHairline2,
    gallerySummary,
  );

  scroll.append(tabs, title, worldView, galleryView);

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

  // --- タブ切替(表示のみ。生成状態には触れない) ---
  function setActiveTab(tab: TabKey): void {
    worldView.hidden = tab !== "world";
    galleryView.hidden = tab !== "gallery";
    worldTabBtn.setAttribute("aria-selected", tab === "world" ? "true" : "false");
    galleryTabBtn.setAttribute(
      "aria-selected",
      tab === "gallery" ? "true" : "false",
    );
    onTabChange?.(tab);
  }
  worldTabBtn.addEventListener("click", () => setActiveTab("world"));
  galleryTabBtn.addEventListener("click", () => setActiveTab("gallery"));
  setActiveTab(initialTab);

  const getParams = (): Params => {
    const params = { ...DEFAULT_PARAMS };
    for (const [key, input] of inputs) {
      params[key] = Number(input.value);
    }
    return params;
  };

  const getGalleryParams = (): Params => {
    const params = { ...DEFAULT_PARAMS };
    // 選択中の対象に関連するキーのみ適用する(非表示スライダーの値は
    // 対象の生成に影響させない。契約「関連パラメータ」)
    const keys = galleryUrlParamKeys(targetSelect.value);
    for (const [key, input] of galleryInputs) {
      if (keys.includes(key)) params[key] = Number(input.value);
    }
    return params;
  };

  generate.addEventListener("click", () => {
    onGenerate(seedInput.value.trim() || "0", getParams());
  });

  galleryGenerate.addEventListener("click", () => {
    galleryInit.onGenerate(
      targetSelect.value,
      gallerySeedInput.value.trim() || "0",
      getGalleryParams(),
    );
  });

  // 再抽選(seed 送り): Randomize Seed と異なり、seed 欄を更新した直後に
  // 直ちに再生成する
  galleryReroll.addEventListener("click", () => {
    const seed = randomSeed();
    gallerySeedInput.value = seed;
    galleryInit.onGenerate(targetSelect.value, seed, getGalleryParams());
  });

  root.append(panel, open);

  return {
    getSeed: () => seedInput.value.trim() || "0",
    setSeed: (seed) => {
      seedInput.value = seed;
    },
    getParams,
    summaryElement: summary,
    gallery: {
      getTargetId: () => targetSelect.value,
      getSeed: () => gallerySeedInput.value.trim() || "0",
      getParams: getGalleryParams,
      summaryElement: gallerySummary,
    },
    setActiveTab,
  };
}
