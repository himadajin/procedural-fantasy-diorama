/**
 * 描画プリセット(PHASE 7 commit 22)のテスト。
 * 契約は contracts/pipeline.md「描画プリセット・LOD・デバッグ表示」:
 * プリセットは表示側のみを変え、WorldModel(生成内容・ハッシュ)に
 * 影響しない。デバイス判定・実測補正・植生間引きは決定論的。
 */
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { DEFAULT_PARAMS, type WorldModel } from "../src/model/worldmodel";
import { runPipeline } from "../src/pipeline/run";
import {
  FPS_DEMOTE_BELOW,
  FPS_PROMOTE_AT,
  PRESETS,
  choosePresetByDevice,
  correctPresetByFps,
} from "../src/viewer/preset";
import {
  buildVegetation,
  treeLumps,
  vegetationDrawOrder,
  type VegBudget,
} from "../src/mesh/vegetation";

let cachedModel: WorldModel | null = null;
async function model(): Promise<WorldModel> {
  cachedModel ??= await runPipeline("everdusk-101", DEFAULT_PARAMS);
  return cachedModel;
}

describe("プリセット差で WorldModel ハッシュ不変(contracts/pipeline.md)", () => {
  it("高/低プリセットの設定値の下でも runPipeline の出力は同一", async () => {
    // プリセットは runPipeline に一切入力されない(表示側のみ)。
    // 各プリセットの設定を「有効」とみなした環境で生成しても
    // ハッシュが変わらないことを、全プリセットの走査で機械的に固定する
    const hashes = new Set<string>();
    for (const preset of Object.values(PRESETS)) {
      expect(preset.pixelRatioMax).toBeGreaterThan(0);
      const result = await runPipeline("everdusk-101", DEFAULT_PARAMS);
      hashes.add(result.summary.hash);
    }
    expect(hashes.size).toBe(1);
  });

  it("高と低は表示側の設定として実際に異なる(テストの空洞化防止)", () => {
    expect(PRESETS.high.pixelRatioMax).not.toBe(PRESETS.low.pixelRatioMax);
    expect(PRESETS.high.shadowMapSize).not.toBe(PRESETS.low.shadowMapSize);
    expect(PRESETS.high.vegetationMax).not.toBe(PRESETS.low.vegetationMax);
    expect(PRESETS.high.waterDetail).not.toBe(PRESETS.low.waterDetail);
    expect(PRESETS.high.timeUpdateInterval).not.toBe(
      PRESETS.low.timeUpdateInterval,
    );
  });
});

describe("デバイス簡易判定・実測補正の決定性(contracts/pipeline.md)", () => {
  it("同一入力 → 同一プリセット(決定論的)", () => {
    for (const [dpr, w, h] of [
      [1, 1920, 1080],
      [3, 390, 844],
      [2, 1440, 900],
    ] as const) {
      expect(choosePresetByDevice(dpr, w, h)).toBe(
        choosePresetByDevice(dpr, w, h),
      );
    }
  });

  it("dpr・物理ピクセル数のしきい値で高/低が分かれる", () => {
    // 標準的なデスクトップ(dpr 1)は高
    expect(choosePresetByDevice(1, 1920, 1080)).toBe("high");
    // 高dprスマホ(dpr 3)は低
    expect(choosePresetByDevice(3, 390, 844)).toBe("low");
    // dpr 2 でも物理ピクセル数が大きい(Retinaノート)は低
    // (初回生成後の実測補正が高へ引き上げる余地を持つ)
    expect(choosePresetByDevice(2, 1440, 900)).toBe("low");
    // dpr 2 の小画面は高
    expect(choosePresetByDevice(2, 800, 600)).toBe("high");
  });

  it("実測補正: ヒステリシス付きで高⇔低を1回だけ修正する", () => {
    expect(correctPresetByFps("high", FPS_DEMOTE_BELOW - 1)).toBe("low");
    expect(correctPresetByFps("high", FPS_DEMOTE_BELOW)).toBe("high");
    expect(correctPresetByFps("low", FPS_PROMOTE_AT)).toBe("high");
    expect(correctPresetByFps("low", FPS_PROMOTE_AT - 1)).toBe("low");
  });
});

describe("植生間引きの決定性(mesh/vegetation.ts)", () => {
  it("描画順は決定論的で、全個体をちょうど1回ずつ含む", async () => {
    const m = await model();
    const a = vegetationDrawOrder(m);
    const b = vegetationDrawOrder(m);
    expect(a).toEqual(b);
    expect(a.length).toBe(
      m.vegetation.trees.length + m.vegetation.shrubs.length,
    );
    const keys = new Set(a.map((ind) => `${ind.kind}/${ind.index}`));
    expect(keys.size).toBe(a.length);
  });

  it("vegBudget の prefix 表: 単調非減少で、全個体 = 全インスタンス", async () => {
    const m = await model();
    const objects = buildVegetation(m);
    const trunkMesh = objects.find(
      (o) => o.name === "vegetation-trunks",
    ) as THREE.InstancedMesh;
    const canopyMesh = objects.find(
      (o) => o.name === "vegetation-canopy",
    ) as THREE.InstancedMesh;
    const trunkBudget = trunkMesh.userData.vegBudget as VegBudget;
    const canopyBudget = canopyMesh.userData.vegBudget as VegBudget;
    const individuals =
      m.vegetation.trees.length + m.vegetation.shrubs.length;
    expect(trunkBudget.individuals).toBe(individuals);
    expect(canopyBudget.individuals).toBe(individuals);
    expect(trunkBudget.prefix.length).toBe(individuals + 1);
    expect(canopyBudget.prefix.length).toBe(individuals + 1);
    for (const budget of [trunkBudget, canopyBudget]) {
      for (let k = 1; k <= individuals; k++) {
        expect(budget.prefix[k]!).toBeGreaterThanOrEqual(
          budget.prefix[k - 1]!,
        );
      }
    }
    // 上限なし(k = 全個体)で全インスタンスが表示される
    expect(trunkBudget.prefix[individuals]).toBe(trunkMesh.count);
    expect(canopyBudget.prefix[individuals]).toBe(canopyMesh.count);
  });

  it("上位 k 個体の間引きは幹・樹冠で同じ個体集合に揃う", async () => {
    const m = await model();
    const order = vegetationDrawOrder(m);
    const objects = buildVegetation(m);
    const trunkBudget = (
      objects.find((o) => o.name === "vegetation-trunks") as THREE.InstancedMesh
    ).userData.vegBudget as VegBudget;
    const canopyBudget = (
      objects.find((o) => o.name === "vegetation-canopy") as THREE.InstancedMesh
    ).userData.vegBudget as VegBudget;
    // 上位 k 個体から期待されるインスタンス数を独立に再計算して照合する
    const k = Math.floor(order.length / 2);
    let expectedTrunks = 0;
    let expectedLumps = 0;
    for (let i = 0; i < k; i++) {
      const ind = order[i]!;
      if (ind.kind === "tree") {
        const tree = m.vegetation.trees[ind.index]!;
        expectedTrunks++;
        expectedLumps += treeLumps(tree).length;
      } else {
        expectedLumps++;
      }
    }
    expect(trunkBudget.prefix[k]).toBe(expectedTrunks);
    expect(canopyBudget.prefix[k]).toBe(expectedLumps);
    // 同一プリセット(同一 k)→ 同一表示集合(再構築でも同じ prefix)
    const again = buildVegetation(m);
    const trunkAgain = (
      again.find((o) => o.name === "vegetation-trunks") as THREE.InstancedMesh
    ).userData.vegBudget as VegBudget;
    expect(trunkAgain.prefix).toEqual(trunkBudget.prefix);
  });
});
