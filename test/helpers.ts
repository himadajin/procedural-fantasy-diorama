/**
 * 生成テスト用の共有ヘルパー(段チェーンの組み立て・パラメータ合成・メモ化)。
 * 段順は contracts/pipeline.md の段契約表を正とし、
 * src/pipeline/steps.ts の buildSteps() が返す配列から機械的に導出する。
 * 呼び出し側・本ファイルのいずれにも手書きの段順序列を持たない。
 */
import {
  DEFAULT_PARAMS,
  createEmptyWorldModel,
  type Params,
  type WorldModel,
} from "../src/model/worldmodel";
import { buildSteps } from "../src/pipeline/steps";

/** over を DEFAULT_PARAMS に上書き合成する */
export function withParams(over: Partial<Params>): Params {
  return { ...DEFAULT_PARAMS, ...over };
}

/**
 * seed + params から WorldModel を作り、steps.ts の buildSteps() が返す
 * 段順に沿って、指定した段(その段の run 関数そのもの)まで同期実行する。
 * buildSteps() を都度呼び出し、参照一致で stage の位置を探すため、
 * 段の追加・入れ替えが起きても本関数・呼び出し側の変更は不要。
 */
export function buildUpTo(
  stage: (model: WorldModel) => void,
  seed: string,
  params: Partial<Params> = {},
): WorldModel {
  const model = createEmptyWorldModel(seed, withParams(params));
  const steps = buildSteps();
  const index = steps.findIndex((s) => s.run === stage);
  if (index < 0) {
    throw new Error("buildUpTo: 指定した段が steps.ts の段順に見つからない");
  }
  for (let i = 0; i <= index; i++) {
    steps[i]!.run(model);
  }
  return model;
}

/**
 * build 関数の結果を (seed, over) の組でメモ化する。
 * 生成コストの高い後段のテストで同一入力の再計算を避けるために使う。
 */
export function makeCached(
  build: (seed: string, over: Partial<Params>) => WorldModel,
): (seed: string, over?: Partial<Params>) => WorldModel {
  const cache = new Map<string, WorldModel>();
  return (seed: string, over: Partial<Params> = {}): WorldModel => {
    const key = seed + JSON.stringify(over);
    let model = cache.get(key);
    if (!model) {
      model = build(seed, over);
      cache.set(key, model);
    }
    return model;
  };
}
