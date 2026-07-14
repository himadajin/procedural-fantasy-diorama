/**
 * 描画プリセット。
 * 定義・判定規則の正は contracts/pipeline.md「描画プリセット・LOD・
 * デバッグ表示」。プリセットは表示側のみを変え、WorldModel と
 * 絵(色・光・構図。art-direction)は変えない。判定は決定論的で
 * Math.random() を使わない。three 非依存の純データ+純関数
 * (Vitest から直接検証できる)。
 */

export type PresetName = "high" | "low";

export interface RenderPreset {
  name: PresetName;
  /** renderer.setPixelRatio(min(devicePixelRatio, この値)) */
  pixelRatioMax: number;
  /** 太陽の影マップ解像度(正方形) */
  shadowMapSize: number;
  /** 影カメラ far = ワールド一辺 × この係数 */
  shadowFarFactor: number;
  /** 植生の表示個体数上限(mesh/vegetation.ts の vegBudget で count を絞る) */
  vegetationMax: number;
  /** 水面シェーダーのノイズ簡略度(1=3オクターブ / 0=1オクターブ) */
  waterDetail: number;
  /** 時間 uniform(水面揺らぎ・発光明滅・浮遊上下動)の最小更新間隔 [s] */
  timeUpdateInterval: number;
}

export const PRESETS: Record<PresetName, RenderPreset> = {
  high: {
    name: "high",
    pixelRatioMax: 2,
    shadowMapSize: 2048,
    shadowFarFactor: 3,
    vegetationMax: Infinity,
    waterDetail: 1,
    timeUpdateInterval: 0,
  },
  low: {
    name: "low",
    pixelRatioMax: 1.5,
    shadowMapSize: 1024,
    shadowFarFactor: 2,
    vegetationMax: 900,
    waterDetail: 0,
    timeUpdateInterval: 0.05,
  },
};

/** 起動時判定: この dpr 以上は「低」から始める(高dprスマホ帯) */
export const DEVICE_DPR_LOW = 2.5;
/** 起動時判定: 物理ピクセル数(css幅×css高×dpr²)がこの値以上は「低」 */
export const DEVICE_PIXELS_LOW = 4_600_000;

/**
 * デバイス簡易判定(起動時に1回)。画面解像度と devicePixelRatio のみで
 * 決める粗い初期値で、誤判定は初回生成後の実測補正(correctPresetByFps)が
 * 引き取る(contracts/pipeline.md)。
 */
export function choosePresetByDevice(
  devicePixelRatio: number,
  cssWidth: number,
  cssHeight: number,
): PresetName {
  if (devicePixelRatio >= DEVICE_DPR_LOW) return "low";
  const physicalPixels = cssWidth * cssHeight * devicePixelRatio * devicePixelRatio;
  return physicalPixels >= DEVICE_PIXELS_LOW ? "low" : "high";
}

/** 実測補正: 「高」でこの fps を下回ったら「低」へ */
export const FPS_DEMOTE_BELOW = 40;
/** 実測補正: 「低」でこの fps 以上なら「高」へ */
export const FPS_PROMOTE_AT = 55;
/** 実測補正のウォームアップ(捨てる)フレーム数 */
export const FPS_PROBE_WARMUP_FRAMES = 30;
/** 実測補正の計測フレーム数 */
export const FPS_PROBE_FRAMES = 90;

/**
 * 初回生成後の実測補正(1回だけ)。計測平均 fps から起動時判定を
 * 修正する。しきい値にヒステリシスを持たせ、境界付近での往復を防ぐ。
 */
export function correctPresetByFps(
  current: PresetName,
  measuredFps: number,
): PresetName {
  if (current === "high" && measuredFps < FPS_DEMOTE_BELOW) return "low";
  if (current === "low" && measuredFps >= FPS_PROMOTE_AT) return "high";
  return current;
}
