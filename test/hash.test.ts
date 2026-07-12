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
  // 新旧対応(A3 → A4):
  //   everdusk-101 {}              69da6671 → 69da6671(不変)
  //   everdusk-101 {water:0}       16eb82ac → 16eb82ac(不変)
  //   everdusk-101 {water:95}      a9c68291 → 8d0d2687
  //   everdusk-101 {worldScale:0}  71827f89 → 3dd658a9
  //   everdusk-101 {worldScale:100} 3958b5ca → 3958b5ca(不変)
  //   seed-a {}                    6a40e14c → 6a40e14c(不変)
  //   seed-b {}                    a9d7a39d → 3e3e2341
  //   seed-b {water:70}            98f0350c → 7849a971
  //
  // 計画書 2026-07-11-worldgen-rework-water.md タスク A4 差し戻し対応で確認
  // (2026-07-12)。意図した変更: 水路×道路の単一交差の渡り長上限
  // max(18, canalWidth×6) を追加した(道路と水路の長距離並走が 1 つの
  // 巨大な橋になる破綻の対策。渡り長は確定済み水路とのコリドー合成水域で
  // 判定する。contracts/ground-water.md「水路の性質」)。乱数消費規約は不変で、
  // 棄却は上限を超える並走交差を生む個体でのみ発生する(harbor-1 / water=100
  // で実測。渡り長 134.6 → 全交差が上限以下)。本表の 8 組では棄却が
  // 発生せず、再生成の結果 8 組すべてのハッシュが不変だった(値の更新なし)。
  //
  // 計画書 2026-07-11-worldgen-rework-water.md タスク A7 で更新。意図した変更:
  // 水路の形状健全性(自己近接・既存水路との重なり・迂曲率)を受理条件に
  // 追加し、経由点を水路 index ごとに異なる主道間隙へ向けて分散させた
  // (mainRoadGaps。3.2節(6)「形状健全性」)。あわせて、この検査を追加した
  // 結果リトライ回数 3 では健全な候補(またはフォールバック堀留の候補)が
  // 見つからず水路が全滅する個体が複数見つかったため、リトライ回数を
  // 3 から 25 へ引き上げた(contracts/ground-water.md「水路の性質」)。
  // これらはいずれも水路の経路(および経由点が向かう間隙)を変えるため、
  // 後段(区画・建物・植生等)の生成結果も変わり、water:0(水域なし。水路
  // 生成の対象外)を除く 7 組のハッシュが変わる。water:0 は不変(16eb82ac
  // のまま)。seed-a {} は水路が単一水域からの1本のみで、割り当てられた
  // 間隙・形状検査のいずれにも抵触しない経路がそのまま採用されたため、
  // 結果としてハッシュも不変だった(69da6671 ではなく元々 6a40e14c であり、
  // A2 以降 6a40e14c のまま変化していない)。
  // 新旧対応(A6 → A7):
  //   everdusk-101 {}              69da6671 → b4a46541
  //   everdusk-101 {water:0}       16eb82ac → 16eb82ac(不変)
  //   everdusk-101 {water:95}      8d0d2687 → 0d7a81c7
  //   everdusk-101 {worldScale:0}  3dd658a9 → c1754828
  //   everdusk-101 {worldScale:100} 3958b5ca → 2ebaf32f
  //   seed-a {}                    6a40e14c → 6a40e14c(不変)
  //   seed-b {}                    3e3e2341 → 37b960fd
  //   seed-b {water:70}            7849a971 → 992ee82a
  //
  // 計画書 2026-07-12-worldgen-rework-roads.md タスク B2 で更新。意図した変更:
  // derive.ts の entryPointCount を `clamp(round(2 + 2×scale + entryJitter), 2, 4)`
  // から `clamp(round(2 + 2.8×scale + entryJitter), 2, 5)` へ変更した(進入点数を
  // World Scale に強く連動させ、大きい箱庭の幹線骨格を増やす。3.2節(7)・
  // worldmodel-core.md「Derived」)。entryJitter・pondJitter の消費数・消費順は
  // 不変(rng 消費に影響する変更ではなく、丸め対象の式のみを変えたため)。
  // worldScale=0 は新旧どちらの式でも entryPointCount=2 に丸まるため不変。
  // worldScale=50(全パラメータ既定)は 3+jitter → 3.4+jitter へ丸め閾値が動くため、
  // entryJitter が閾値をまたぐ seed のみ変わる(everdusk-101 は 3→4 へ変化、
  // seed-a・seed-b は元々 3 のまま変化なし=不変)。worldScale=100 は
  // 旧式が常に 4 に飽和していたのに対し新式は 4.8+jitter で 5 まで届くため、
  // everdusk-101 は 4→5 へ変化した。進入点数が変わった組は道路網(段5)以降
  // (密度・結界・広場・区画・建物・植生等)の生成結果も連鎖して変わる。
  // 新旧対応(A7 → B2):
  //   everdusk-101 {}              b4a46541 → 019930b4
  //   everdusk-101 {water:0}       16eb82ac → 70b7bd86
  //   everdusk-101 {water:95}      0d7a81c7 → 6b7825a1
  //   everdusk-101 {worldScale:0}  c1754828 → c1754828(不変)
  //   everdusk-101 {worldScale:100} 2ebaf32f → 079c7947
  //   seed-a {}                    6a40e14c → 6a40e14c(不変)
  //   seed-b {}                    37b960fd → 37b960fd(不変)
  //   seed-b {water:70}            992ee82a → 992ee82a(不変)
  //
  // 計画書 2026-07-12-worldgen-rework-roads.md タスク B3 で更新。意図した変更:
  // 幹線(main/connector)から発芽して局所規則で伸びる二次街路(class
  // "street")を導入した(段5後半サブフェーズ pipeline/streets.ts。
  // contracts/network-plaza.md「二次街路(street)の有機成長」)。
  // 発芽点ごとの独立乱数サブストリーム(`streets/sprout/<edgeId>/<k>`)を
  // 新規消費するため、street が1本でも生える組(streetBudget > 0 は
  // worldScale の全域で正)はすべてハッシュが変わる。街路の追加は
  // 密度(道路近接ブースト)→結界→広場→区画→建物→植生へ連鎖するため、
  // worldScale=0(道路網に依存しない部分は不変でも街路自体は生える)を
  // 含む全 8 組が変わる。
  // 新旧対応(B2 → B3):
  //   everdusk-101 {}              019930b4 → c2917dc5
  //   everdusk-101 {water:0}       70b7bd86 → 3b793c62
  //   everdusk-101 {water:95}      6b7825a1 → 7a73349f
  //   everdusk-101 {worldScale:0}  c1754828 → 4697ee8f
  //   everdusk-101 {worldScale:100} 079c7947 → 8007b11a
  //   seed-a {}                    6a40e14c → d4b53d5c
  //   seed-b {}                    37b960fd → 439327ba
  //   seed-b {water:70}            992ee82a → 13b94626
  const SNAPSHOTS: [string, Partial<Params>, string][] = [
    ["everdusk-101", {}, "c2917dc5"],
    ["everdusk-101", { water: 0 }, "3b793c62"],
    ["everdusk-101", { water: 95 }, "7a73349f"],
    ["everdusk-101", { worldScale: 0 }, "4697ee8f"],
    ["everdusk-101", { worldScale: 100 }, "8007b11a"],
    ["seed-a", {}, "d4b53d5c"],
    ["seed-b", {}, "439327ba"],
    ["seed-b", { water: 70 }, "13b94626"],
  ];

  for (const [seed, over, expected] of SNAPSHOTS) {
    it(`seed=${seed} ${JSON.stringify(over)} → ${expected}`, async () => {
      const model = await runPipeline(seed, withParams(over));
      expect(model.summary.hash).toBe(expected);
    });
  }
});
