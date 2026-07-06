import { describe, expect, it } from "vitest";
import { DEFAULT_PARAMS, createEmptyWorldModel } from "../src/model/worldmodel";
import { executeSteps, runPipeline, type PipelineStep } from "../src/pipeline/run";

describe("runPipeline", () => {
  it("全ステップを実行して WorldModel を返す", async () => {
    const model = await runPipeline("seed-a", DEFAULT_PARAMS);
    expect(model.meta.seed).toBe("seed-a");
    expect(model.ground.size).toBeGreaterThan(0);
    expect(model.summary.scale.worldSize).toBe(model.ground.size);
  });

  it("同一 seed + params で同一の WorldModel を返す(決定性)", async () => {
    const a = await runPipeline("seed-det", DEFAULT_PARAMS);
    const b = await runPipeline("seed-det", DEFAULT_PARAMS);
    expect(a).toEqual(b);
  });

  it("onProgress がステップ名と進捗を順に通知する", async () => {
    const seen: [string, number, number][] = [];
    await runPipeline("seed-p", DEFAULT_PARAMS, {
      onProgress: (name, index, total) => seen.push([name, index, total]),
    });
    expect(seen.length).toBeGreaterThan(0);
    seen.forEach(([name, index, total], i) => {
      expect(name.length).toBeGreaterThan(0);
      expect(index).toBe(i);
      expect(total).toBe(seen.length);
    });
  });

  it("params は防御的にコピーされる", async () => {
    const params = { ...DEFAULT_PARAMS };
    const model = await runPipeline("seed-c", params);
    params.water = 99;
    expect(model.meta.params.water).toBe(DEFAULT_PARAMS.water);
  });
});

describe("executeSteps", () => {
  it("ステップ間で制御を返しながら順に実行する", async () => {
    const order: string[] = [];
    const steps: PipelineStep[] = [
      { name: "one", run: () => order.push("one") },
      { name: "two", run: () => order.push("two") },
      { name: "three", run: () => order.push("three") },
    ];
    await executeSteps(createEmptyWorldModel("s", DEFAULT_PARAMS), steps);
    expect(order).toEqual(["one", "two", "three"]);
  });

  it("signal の中断で AbortError を投げ、後続ステップを実行しない", async () => {
    const abort = new AbortController();
    const order: string[] = [];
    const steps: PipelineStep[] = [
      {
        name: "one",
        run: () => {
          order.push("one");
          abort.abort();
        },
      },
      { name: "two", run: () => order.push("two") },
    ];
    await expect(
      executeSteps(createEmptyWorldModel("s", DEFAULT_PARAMS), steps, {
        signal: abort.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(order).toEqual(["one"]);
  });
});
