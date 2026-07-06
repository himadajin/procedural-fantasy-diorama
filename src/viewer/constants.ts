/**
 * ライティング・空・カメラの固定数値。
 * 数値の正は docs/internal/specs/art-direction.md 3・4・8節。
 * 変更する場合は先に同文書を更新する。
 */

/** 太陽(平行光) */
export const SUN_COLOR = "#ffc189";
export const SUN_INTENSITY = 1.15;
/** 仰角 約24度(ラジアン) */
export const SUN_ELEVATION = (24 * Math.PI) / 180;
/** 方位は seed に依らず固定(北=+Z基準、時計回り) */
export const SUN_AZIMUTH = (245 * Math.PI) / 180;

/** HemisphereLight */
export const HEMI_SKY_COLOR = "#8ea6c0";
export const HEMI_GROUND_COLOR = "#665d4e";
export const HEMI_INTENSITY = 0.5;

/** 霧 */
export const FOG_COLOR = "#a9b6c6";
/**
 * FogExp2 密度 = FOG_DENSITY_FACTOR / ワールド一辺。
 * 基準 0.6(2.2→0.9: 初期構図で箱庭中心まで霧に沈むため 2026-07-06 改定。
 * 0.9→0.6: 実機確認のフィードバックでさらに減量 2026-07-07。art-direction 3節)
 */
export const FOG_DENSITY_FACTOR = 0.6;

/** トーンマッピング露出(ACESFilmic) */
export const EXPOSURE = 1.05;

/** 空のグラデーション */
export const SKY_ZENITH = "#45566e";
export const SKY_MID = "#8195ab";
export const SKY_HORIZON_SUN = "#d9a978";
export const SKY_HORIZON_AWAY = "#96a4b3";

/** カメラ(art-direction 8節) */
export const CAMERA_FOV = 40;
/** 初期視点: 太陽方位から約120度ずれた方角 */
export const CAMERA_INITIAL_AZIMUTH = SUN_AZIMUTH - (120 * Math.PI) / 180;
/** 初期俯角 約45度 */
export const CAMERA_INITIAL_PITCH = (45 * Math.PI) / 180;

/** 太陽方向の単位ベクトル(y-up) */
export function sunDirection(): { x: number; y: number; z: number } {
  return {
    x: Math.cos(SUN_ELEVATION) * Math.sin(SUN_AZIMUTH),
    y: Math.sin(SUN_ELEVATION),
    z: Math.cos(SUN_ELEVATION) * Math.cos(SUN_AZIMUTH),
  };
}
