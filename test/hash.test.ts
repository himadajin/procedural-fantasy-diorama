import { describe, expect, it } from "vitest";
import { DEFAULT_PARAMS, type Params } from "../src/model/worldmodel";
import { hashWorldModel } from "../src/model/hash";
import { runPipeline } from "../src/pipeline/run";

function withParams(over: Partial<Params>): Params {
  return { ...DEFAULT_PARAMS, ...over };
}

describe("hashWorldModel: 決定性(contracts/pipeline.md)", () => {
  it("同一入力の2回生成でハッシュが一致し、summary.hash に格納される", async () => {
    const a = await runPipeline("everdusk-101", DEFAULT_PARAMS);
    const b = await runPipeline("everdusk-101", DEFAULT_PARAMS);
    expect(a.summary.hash).toBe(b.summary.hash);
    expect(a.summary.hash).toMatch(/^[0-9a-f]{8}$/);
  });

  it("summary.hash 自身はハッシュ計算から除外される(格納後も不変)", async () => {
    const model = await runPipeline("everdusk-101", DEFAULT_PARAMS);
    const stored = model.summary.hash;
    // 格納済みの状態で再計算しても同じ値になる
    expect(hashWorldModel(model)).toBe(stored);
    model.summary.hash = "ffffffff";
    expect(hashWorldModel(model)).toBe(stored);
  });

  it("seed・params が違えばハッシュが変わる", async () => {
    const base = await runPipeline("everdusk-101", DEFAULT_PARAMS);
    const otherSeed = await runPipeline("seed-a", DEFAULT_PARAMS);
    const otherParams = await runPipeline(
      "everdusk-101",
      withParams({ water: 51 }),
    );
    expect(otherSeed.summary.hash).not.toBe(base.summary.hash);
    expect(otherParams.summary.hash).not.toBe(base.summary.hash);
  });
});

describe("hashWorldModel: 代表 seed×params のスナップショット固定", () => {
  // 意図した生成変更でこの表が変わる場合は、スナップショット更新を同一commitに
  // 含め、意図を commit メッセージに記す(implementation-spec 1.10節)
  // commit 21(PHASE 7)でサマリーぶんを更新。意図した変更:
  // 段15「サマリー」が summary(buildingCounts / centerDescription /
  // waterOverview / wardOverview / scale)を最終確定する
  // (contracts/vegetation-summary.md Summary 節)。段15 は乱数を消費しないが、
  // 従来 buildingCounts は {}・centerDescription は "" のままだったのに対し、
  // 本段が両者を最終状態から機械算出して埋めるため、8 組すべてのハッシュが
  // 変わる(その他のフィールドは commit 20 から不変)。summary.complexity は
  // WorldModel から除外した(レンダラー実測=表示依存のため。同節の設計判断)
  // が、従来も 0 固定でハッシュに寄与していたのはキー名 "complexity" 等の
  // 構造ぶんであり、除外と summary 埋めの両方が今回のハッシュ差に含まれる。
  // summary.hash 自身は従来どおりハッシュ計算から除外される。
  // 新旧対応(commit 20 → commit 21):
  //   everdusk-101 {}              884882c7 → 1125a04d
  //   everdusk-101 {water:0}       f1a62db2 → eed82045
  //   everdusk-101 {water:95}      58609e07 → f7773829
  //   everdusk-101 {worldScale:0}  cd8205af → aff7f80d
  //   everdusk-101 {worldScale:100} 06acdfcb → 7bfd75e6
  //   seed-a {}                    413344bc → 9913230d
  //   seed-b {}                    360ce1b7 → a7018aa7
  //   seed-b {water:70}            37add040 → 8765d9eb
  //
  // 計画書 2026-07-11-worldgen-rework-water.md タスク A2 で更新。意図した変更:
  // (1) siting.ts の placeEntryPoints から「主河川がある場合、進入点が
  //     全て同じ岸に偏ったら1点を対岸へ移す」処理を削除した(乱数非消費の
  //     処理のため、この変更自体はハッシュに影響しない)。
  // (2) canals.ts の buildAnchors を「川沿いの等間隔点+湖の内側点」から
  //     「岸線ループ(model.water.shoreline.loops)沿いの等間隔点(法線の
  //     逆方向へ 1.5 押し込み、waterSdf < 0 を満たす点のみ採用)」へ
  //     一般化した。アンカー候補の弧長間隔 CANAL_ANCHOR_SPACING = 40
  //     (旧・水域沿い間隔の実寸レンジ 12.5〜40 の上限側と同程度)。
  //     アンカー候補の「数」は乱数消費数に影響しない(planCanal は
  //     anchors.length を用いて `Math.floor(pick × n)` で固定個の乱数値を
  //     インデックス化するのみで、消費数自体は試行ごとに固定のため)。
  // 上記いずれもアンカー・進入点の座標が変わるため、水路の経路・橋・
  // それに連鎖する後段(区画・建物・植生等)の生成結果が変わり、
  // water:0(水域なし。橋岸移設もアンカー生成も対象外)を除く 7 組の
  // ハッシュが変わる。water:0 は不変(eed82045 のまま)。
  // 新旧対応(commit 21 → A2):
  //   everdusk-101 {}              1125a04d → 1f4feffc
  //   everdusk-101 {water:0}       eed82045 → eed82045(不変)
  //   everdusk-101 {water:95}      f7773829 → 8b2d7238
  //   everdusk-101 {worldScale:0}  aff7f80d → 30905ae4
  //   everdusk-101 {worldScale:100} 7bfd75e6 → 2c74088a
  //   seed-a {}                    9913230d → 2e3997c5
  //   seed-b {}                    a7018aa7 → b23fd78c
  //   seed-b {water:70}            8765d9eb → c08c38d7
  //
  // 計画書 2026-07-11-worldgen-rework-water.md タスク A3 で更新。意図した変更:
  // 川をスキーマごと削除し、湖(0〜1)+池(0〜4)の独立配置モデルへ全面置換した
  // (Water の該当フィールドを削除して ponds を追加、Derived の川本数・川幅の
  // 該当フィールドを削除して pondCount/pondArea/canalWidth を追加、
  // 道路(段5)は湖・池を渡らず BridgeSite を抽出しない設計へ変更 等。
  // 詳細は 3.2節・contracts/ground-water.md)。water:0 を含む全 8 組が変わる
  // (Water インターフェースのフィールド名自体が変わった=water:0 でも
  // 「水なし」の内部表現(空配列のフィールド名)が変わり、waterOverview の
  // キー名も変わるため)。
  // 新旧対応(A2 → A3):
  //   everdusk-101 {}              1f4feffc → 69da6671
  //   everdusk-101 {water:0}       eed82045 → 16eb82ac
  //   everdusk-101 {water:95}      8b2d7238 → a9c68291
  //   everdusk-101 {worldScale:0}  30905ae4 → 71827f89
  //   everdusk-101 {worldScale:100} 2c74088a → 3958b5ca
  //   seed-a {}                    2e3997c5 → 6a40e14c
  //   seed-b {}                    b23fd78c → a9d7a39d
  //   seed-b {water:70}            c08c38d7 → 98f0350c
  //
  // 計画書 2026-07-11-worldgen-rework-water.md タスク A4 で更新。意図した変更:
  // canals.ts の水中区間の押し出し処理から「深い横断部
  // (waterSdf < −(幅/2+6))は対象外」の例外を削除し、始端・終端の接続窓を
  // 除くすべての水中区間を岸へ押し出すよう強化した。あわせて中間部の陸上率の
  // 棄却閾値を 0.7 → 0.95 へ引き上げ、「全試行が閾値未満でも陸上率最大の
  // 試行を受理する」救済を廃止した(棄却→全滅時はフォールバック堀留への
  // 縮退の一本道に統一。contracts/ground-water.md「水路の性質」)。
  // 実装中に発見した副次的な不具合の修正も含む: フォールバック堀留
  // (`planFallbackCanal`)の終端選定が「中心方向へ一定距離進めた点を勾配で
  // 陸側へ押し出す」方式だったため、巨大な湖では終端が直線から大きく逸れ、
  // 始端〜終端の直線が湖の内部を数百単位横断する経路を生んでいた
  // (2026-07-11 のブラウザ観察で確認済みの破綻と同種)。岸→中心方向への
  // 直線を等間隔走査して「水中に留まる最後の地点」を探す方式へ置き換え、
  // その水中区間が接続窓を超えるアンカーは採用しないよう修正した。
  // 水路・橋の経路が変わるため後段(区画・建物・植生等)の生成結果も変わり、
  // water:0(水域なし。水路生成の対象外)を除く 7 組のハッシュが変わる。
  // water:0 は不変(16eb82ac のまま)。
  // 新旧対応(A3 → 本 commit):
  //   everdusk-101 {}              69da6671 → 69da6671(不変)
  //   everdusk-101 {water:0}       16eb82ac → 16eb82ac(不変)
  //   everdusk-101 {water:95}      a9c68291 → 8d0d2687
  //   everdusk-101 {worldScale:0}  71827f89 → 3dd658a9
  //   everdusk-101 {worldScale:100} 3958b5ca → 3958b5ca(不変)
  //   seed-a {}                    6a40e14c → 6a40e14c(不変)
  //   seed-b {}                    a9d7a39d → 3e3e2341
  //   seed-b {water:70}            98f0350c → 7849a971
  const SNAPSHOTS: [string, Partial<Params>, string][] = [
    ["everdusk-101", {}, "69da6671"],
    ["everdusk-101", { water: 0 }, "16eb82ac"],
    ["everdusk-101", { water: 95 }, "8d0d2687"],
    ["everdusk-101", { worldScale: 0 }, "3dd658a9"],
    ["everdusk-101", { worldScale: 100 }, "3958b5ca"],
    ["seed-a", {}, "6a40e14c"],
    ["seed-b", {}, "3e3e2341"],
    ["seed-b", { water: 70 }, "7849a971"],
  ];

  for (const [seed, over, expected] of SNAPSHOTS) {
    it(`seed=${seed} ${JSON.stringify(over)} → ${expected}`, async () => {
      const model = await runPipeline(seed, withParams(over));
      expect(model.summary.hash).toBe(expected);
    });
  }
});
