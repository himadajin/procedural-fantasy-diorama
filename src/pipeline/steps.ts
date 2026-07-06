/**
 * 生成パイプラインの段構成(contracts/pipeline.md の段契約)。
 * 現時点は段1「導出設定」〜段5「道路網」まで。
 * 段6「水路」以降は担当PHASE・commitで追加していく。
 * 表示名は Generating インジケーターにそのまま使う(art-direction 9.5節)。
 */
import type { PipelineStep } from "./run";
import { runDerive } from "./derive";
import { runGround } from "./ground";
import { runWater } from "./water";
import { runSiting } from "./siting";
import { runNetwork } from "./network";

export function buildSteps(): PipelineStep[] {
  return [
    { name: "世界の理を定めています…", run: runDerive },
    { name: "地面を敷いています…", run: runGround },
    { name: "水系を計画中…", run: runWater },
    { name: "町の立地を見立てています…", run: runSiting },
    { name: "道を通しています…", run: runNetwork },
  ];
}
