/**
 * ギャラリーの初期構図(計画書 `2026-07-14-gallery.md`「ギャラリー表示に
 * 適した初期カメラ距離は実装判断でよい(対象1体が画面に収まる距離)」の
 * 実装。G2b で固定距離から対象寸法駆動へ改めた)。
 *
 * 対象(建物または施設1体。施設は Phase D タスク D2b で追加)の寸法を
 * WorldModel から見積もり、外接球が視野に余白つきで収まるカメラ距離・
 * 注視点・方位を導出する純関数。
 * 表示専用のロジックであり、WorldModel には一切書き込まない。
 * three 非依存(viewer 内だが数学のみ。テスト可能な純関数として分離)。
 */
import {
  FLOOR_HEIGHT,
  type Building,
  type Facility,
  type Part,
  type Polygon,
  type WorldModel,
} from "../model/worldmodel";
import { CAMERA_INITIAL_AZIMUTH } from "./constants";

/**
 * OrbitController.configure の home distance がカメラ基準寸法(size)から
 * 導かれる比率(orbit.ts の home 式と同期)。framing は「望む距離 ÷ 本比率」を
 * size として渡すことで home distance を正確に狙う
 */
export const HOME_DISTANCE_RATIO = 0.75;

/**
 * 余白係数。外接球がぴったり収まる距離(r / sin(halfFov))に対する倍率。
 * 1.3 で「対象が画面の狭い側の約 75% を占め、周囲に余白が残る」構図になる
 * (デスクトップの右パネル・モバイルのボトムシートのどちらとも重ならない
 * 中央配置を実測で確認した値)
 */
const FIT_MARGIN = 1.3;

/**
 * バウンディングボックスへの水平パディング(実寸)。
 * 部品の回転による AABB 見積もりの誤差と、部品スケールに現れない細部
 * (縁・持ち送り等)のための固定余裕
 */
const BOX_PAD = 0.5;

/**
 * 初期方位の正面からのずらし角。真正面(facing の逆から見る)では
 * 立体感が失われるため、35度ずらした3/4ビューにする。ずらす向きは
 * 太陽方位(SUN_AZIMUTH=245度)側 — ギャラリー区画の建物は -z 向き
 * (facing≈-π/2)に生成され、正面と左側面(-x)が順光になるため、
 * 左側面が見える側へずらすと両可視面とも日が当たる(実装判断)
 */
const AZIMUTH_OFFSET = (35 * Math.PI) / 180;

export interface GalleryFraming {
  /** OrbitController.configure に渡すカメラ基準寸法(home distance = size×HOME_DISTANCE_RATIO) */
  size: number;
  /** orbit の注視点(対象の外接球中心) */
  target: { x: number; y: number; z: number };
  /** 初期方位(正面がやや見える3/4ビュー) */
  azimuth: number;
}

/** 対象が無い場合のフォールバック(区画寸法相当の据え置き値) */
const FALLBACK: GalleryFraming = {
  size: 40,
  target: { x: 0, y: 0, z: 0 },
  azimuth: CAMERA_INITIAL_AZIMUTH,
};

/** 対象のバウンディングボックス(実寸) */
interface Box {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
}

/**
 * 対象のバウンディングボックスの見積もり。
 *
 * 基本は建築部品(`Building.parts`)の transform から取る — メッシュは
 * 部品の展開そのものであり、footprint の外に出る部品(裏庭の塀・付属屋、
 * 軒の張り出し、煙突、杭。Phase C6 以降の語彙)まで含めた実表示範囲に
 * 一致する。部品のジオメトリ詳細(型ごとの原点規約)はメッシュビルダーの
 * 実装詳細のため参照せず、xz は position ± (|sx|+|sz|)/2(任意の y 軸回転で
 * 安全な AABB 上界)、y は position.y 〜 position.y + |sy|(部品は下端
 * 基準)で保守的に見積もる。
 *
 * footprint バウンディングボックス(壁体上端 = 基壇+階数×階高)との
 * 和集合を取り、部品が空のモデルでも成立させる。
 */
function footprintBox(footprint: Polygon): Box | null {
  const box: Box = {
    minX: Infinity,
    maxX: -Infinity,
    minY: Infinity,
    maxY: -Infinity,
    minZ: Infinity,
    maxZ: -Infinity,
  };
  for (const p of footprint) {
    box.minX = Math.min(box.minX, p.x);
    box.maxX = Math.max(box.maxX, p.x);
    box.minZ = Math.min(box.minZ, p.z);
    box.maxZ = Math.max(box.maxZ, p.z);
  }
  if (!Number.isFinite(box.minX)) return null;
  return box;
}

function extendByParts(box: Box, parts: readonly Part[]): void {
  for (const part of parts) {
    const [px, py, pz] = part.transform.position;
    const [sx, sy, sz] = part.transform.scale;
    const half = (Math.abs(sx) + Math.abs(sz)) / 2;
    box.minX = Math.min(box.minX, px - half);
    box.maxX = Math.max(box.maxX, px + half);
    box.minZ = Math.min(box.minZ, pz - half);
    box.maxZ = Math.max(box.maxZ, pz + half);
    box.minY = Math.min(box.minY, py);
    box.maxY = Math.max(box.maxY, py + Math.abs(sy));
  }
}

function estimateBounds(b: Building): Box | null {
  const box = footprintBox(b.footprint);
  if (!box) return null;
  box.minY = Math.min(0, b.foundation.bottomY);
  box.maxY = b.foundation.plinthHeight + b.floors * FLOOR_HEIGHT;
  extendByParts(box, b.parts);
  return box;
}

/**
 * 施設(Phase D タスク D2b)のバウンディングボックス。施設は階数・基礎を
 * 持たないため、footprint(高さの既定は接地する低い構造 0〜0.5)と部品の
 * 和集合で見積もる。複数の施設(屋台の列。D3)は全体の和集合を取る
 * (列全体が 1 つの鑑賞対象)。
 */
function estimateFacilitiesBounds(
  facilities: readonly Facility[],
): Box | null {
  let union: Box | null = null;
  for (const f of facilities) {
    const box = footprintBox(f.footprint);
    if (!box) continue;
    box.minY = 0;
    box.maxY = 0.5;
    extendByParts(box, f.parts);
    if (!union) {
      union = box;
    } else {
      union.minX = Math.min(union.minX, box.minX);
      union.maxX = Math.max(union.maxX, box.maxX);
      union.minZ = Math.min(union.minZ, box.minZ);
      union.maxZ = Math.max(union.maxZ, box.maxZ);
      union.minY = Math.min(union.minY, box.minY);
      union.maxY = Math.max(union.maxY, box.maxY);
    }
  }
  return union;
}

/**
 * ギャラリーの初期構図を対象の寸法から導出する。
 *
 * 手順: 対象のバウンディングボックス(`estimateBounds`。建築部品込み)から
 * 外接球(中心 = 直方体中心、半径 r)を求め、視野の狭い側の半画角
 * halfFov = min(垂直 fov/2, atan(tan(垂直 fov/2)×アスペクト比)) に対して
 * distance = r / sin(halfFov) × FIT_MARGIN を取る(縦横比が狭い画面では
 * 収まる側で計算)。方位は building.facing から
 * azimuth = π/2 − facing + AZIMUTH_OFFSET(正面がやや見える3/4ビュー)。
 *
 * @param fovDeg カメラの垂直画角(度数。viewer の CAMERA_FOV)
 * @param aspect 画面アスペクト比(幅/高さ。camera.aspect)
 */
export function computeGalleryFraming(
  model: WorldModel,
  fovDeg: number,
  aspect: number,
): GalleryFraming {
  // 対象は建物または施設(Phase D)。施設は複数(屋台の列)でも
  // 全体の和集合を 1 つの鑑賞対象として収める
  const b = model.buildings[0] ?? null;
  const facing = b?.facing ?? model.facilities[0]?.facing;
  const box = b ? estimateBounds(b) : estimateFacilitiesBounds(model.facilities);
  if (!box || facing === undefined) return FALLBACK;

  const target = {
    x: (box.minX + box.maxX) / 2,
    y: (box.minY + box.maxY) / 2,
    z: (box.minZ + box.maxZ) / 2,
  };
  const r = Math.hypot(
    (box.maxX - box.minX) / 2 + BOX_PAD,
    (box.maxZ - box.minZ) / 2 + BOX_PAD,
    (box.maxY - box.minY) / 2,
  );

  const halfV = ((fovDeg / 2) * Math.PI) / 180;
  const halfH = Math.atan(Math.tan(halfV) * Math.max(aspect, 0.1));
  const halfFov = Math.min(halfV, halfH);
  const distance = (r / Math.sin(halfFov)) * FIT_MARGIN;

  return {
    size: distance / HOME_DISTANCE_RATIO,
    target,
    azimuth: Math.PI / 2 - facing + AZIMUTH_OFFSET,
  };
}
