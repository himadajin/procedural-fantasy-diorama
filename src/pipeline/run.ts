/**
 * パイプライン実行フレームワーク。
 * インターフェースの契約は docs/internal/contracts/pipeline.md を正とする。
 * ステップ間で rAF に制御を返すチャンク実行により、生成中もカメラ操作と
 * UI を生かす。
 */
import {
  createEmptyWorldModel,
  type Params,
  type WorldModel,
} from "../model/worldmodel";
import { buildSteps } from "./steps";

export interface PipelineStep {
  /** インジケーター表示名(日本語)。art-direction 9.5節 */
  name: string;
  run(model: WorldModel): void;
}

export interface RunPipelineOptions {
  onProgress?(stepName: string, index: number, total: number): void;
  /** 中断。中断時は AbortError で reject する */
  signal?: AbortSignal;
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => resolve());
    } else {
      setTimeout(resolve, 0);
    }
  });
}

function abortError(): Error {
  const e = new Error("generation aborted");
  e.name = "AbortError";
  return e;
}

/** テスト・内部用: 任意のステップ列でモデルを構築する */
export async function executeSteps(
  model: WorldModel,
  steps: readonly PipelineStep[],
  opts: RunPipelineOptions = {},
): Promise<WorldModel> {
  for (let i = 0; i < steps.length; i++) {
    if (opts.signal?.aborted) throw abortError();
    const step = steps[i];
    if (!step) continue;
    opts.onProgress?.(step.name, i, steps.length);
    step.run(model);
    await nextFrame();
  }
  if (opts.signal?.aborted) throw abortError();
  return model;
}

/** seed + params から WorldModel を生成する(決定論的) */
export function runPipeline(
  seed: string,
  params: Params,
  opts: RunPipelineOptions = {},
): Promise<WorldModel> {
  const model = createEmptyWorldModel(seed, params);
  return executeSteps(model, buildSteps(), opts);
}
