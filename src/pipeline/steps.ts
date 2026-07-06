/**
 * 生成パイプラインの段構成(contracts/pipeline.md の段契約)。
 * PHASE 2 時点は段1「導出設定」〜段3「水系」まで。
 * 段4「立地評価」以降は担当PHASEで追加していく。
 * 表示名は Generating インジケーターにそのまま使う(art-direction 9.5節)。
 */
import type { PipelineStep } from "./run";
import { runDerive } from "./derive";
import { runGround } from "./ground";
import { runWater } from "./water";

export function buildSteps(): PipelineStep[] {
  return [
    { name: "世界の理を定めています…", run: runDerive },
    { name: "地面を敷いています…", run: runGround },
    { name: "水系を計画中…", run: runWater },
  ];
}
