/**
 * 生成パイプラインの段構成(contracts/pipeline.md の段契約)。
 * 現時点は段1「導出設定」〜段14「植生」まで。
 * 段15「サマリー」は担当PHASE(PHASE 7)で追加する。
 * 表示名は Generating インジケーターにそのまま使う(art-direction 9.5節)。
 */
import type { PipelineStep } from "./run";
import { runDerive } from "./derive";
import { runGround } from "./ground";
import { runWater } from "./water";
import { runSiting } from "./siting";
import { runNetwork } from "./network";
import { runCanals } from "./canals";
import { runDensity } from "./density";
import { runWards } from "./wards";
import { runPlazas } from "./plazas";
import { runPaving } from "./paving";
import { runParcels } from "./parcels";
import { runBuildings } from "./buildings";
import { runLanes } from "./lanes";
import { runVegetation } from "./vegetation";

export function buildSteps(): PipelineStep[] {
  return [
    { name: "世界の理を定めています…", run: runDerive },
    { name: "地面を敷いています…", run: runGround },
    { name: "水系を計画中…", run: runWater },
    { name: "町の立地を見立てています…", run: runSiting },
    { name: "道を通しています…", run: runNetwork },
    { name: "水路を巡らせています…", run: runCanals },
    { name: "にぎわいを見立てています…", run: runDensity },
    { name: "結界を計画中…", run: runWards },
    { name: "広場を空けています…", run: runPlazas },
    { name: "道を踏み固めています…", run: runPaving },
    { name: "敷地を区切っています…", run: runParcels },
    { name: "家々を建てています…", run: runBuildings },
    { name: "小道を通しています…", run: runLanes },
    { name: "草木を茂らせています…", run: runVegetation },
  ];
}
