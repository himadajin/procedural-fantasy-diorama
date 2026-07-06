/**
 * 生成パイプラインの段構成(contracts/pipeline.md の段契約)。
 * PHASE 1 時点は最小生成物(無地の平坦な仮グラウンド)のみ。
 * PHASE 2 以降で導出設定・地面・水系…の各段に置換・追加していく。
 */
import type { PipelineStep } from "./run";

/** 仮グラウンドのワールド実寸(PHASE 2 で World Scale 駆動の導出値に置換) */
const PLACEHOLDER_WORLD_SIZE = 400;

export function buildSteps(): PipelineStep[] {
  return [
    {
      name: "世界の下地を準備中…",
      run(model) {
        model.meta.derived.worldSize = PLACEHOLDER_WORLD_SIZE;
      },
    },
    {
      name: "地面を敷いています…",
      run(model) {
        model.ground.size = model.meta.derived.worldSize;
        model.summary.scale.worldSize = model.ground.size;
      },
    },
  ];
}
