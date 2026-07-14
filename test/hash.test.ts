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
  //
  // 計画書 2026-07-12-worldgen-rework-roads.md タスク B4 で更新。意図した変更:
  // 中心前広場が確定した後、最寄りの道路ノードから広場縁(facing の延長線
  // ±30° 以内)への接続路(class "street"、id "street/plaza/<plazaId>")を
  // network へ追記した(contracts/network-plaza.md Plaza 節「中心前広場の
  // 接続路」)。中心前広場は全 seed×params で必ず1個確定するため、接続路の
  // 追記(nodes/edges 各+1)は全組で発生し、後段(舗装・区画・小道・建物)へ
  // 連鎖する。よって全 8 組のハッシュが変わる。
  // 新旧対応(B3 → B4):
  //   everdusk-101 {}              c2917dc5 → beb17b57
  //   everdusk-101 {water:0}       3b793c62 → 755240c1
  //   everdusk-101 {water:95}      7a73349f → 9a80742e
  //   everdusk-101 {worldScale:0}  4697ee8f → b42d2dc4
  //   everdusk-101 {worldScale:100} 8007b11a → 6511a826
  //   seed-a {}                    d4b53d5c → b7522aab
  //   seed-b {}                    439327ba → dfffb83c
  //   seed-b {water:70}            13b94626 → 80c34214
  // 計画書 2026-07-12-worldgen-rework-roads.md タスク B5 で更新。意図した変更:
  // `model.zoning`(市街度 urbanity。0〜1 の 64² FieldGrid)を新設し、段7
  // 「一次密度場」(density.ts の runDensity)が density.primary と同じ走査で
  // 算出・書き込むようにした(contracts/network-plaza.md「Density 節
  // zoning」)。urbanity = smoothstep(0.10, 0.45, protoDensity + 0.5×roadBoost)
  // で、protoDensity・roadBoost は density.primary の算出に使う既存の値
  // (centerTerm×fade・道路近接ブースト)をそのまま流用する(乱数非消費・
  // density.primary はビット同一のまま)。zoning は WorldModel 直下の新規
  // フィールドであり正規化ハッシュの直列化対象に加わるため、値そのものが
  // 変わらない worldScale=0 の組を含む全 8 組でハッシュが変わる
  // (フィールドの追加自体が構造差になるため)。
  // 新旧対応(B4 → B5):
  //   everdusk-101 {}              beb17b57 → 1899b2b0
  //   everdusk-101 {water:0}       755240c1 → 3519feb0
  //   everdusk-101 {water:95}      9a80742e → d445ceb0
  //   everdusk-101 {worldScale:0}  b42d2dc4 → 6ff6fe5d
  //   everdusk-101 {worldScale:100} 6511a826 → 214d49fe
  //   seed-a {}                    b7522aab → 9bdacd9a
  //   seed-b {}                    dfffb83c → 32764980
  //   seed-b {water:70}            80c34214 → 88009bca
  //
  // 計画書 2026-07-12-worldgen-rework-roads.md タスク B6 で更新。意図した変更:
  // オーケストレーターの数値検査(3 seed × Settlement{0,50,100} ×
  // Scale{50,100})に基づき derived の2式を調整した(worldmodel-core.md
  // 「Derived」、network-plaza.md 予算節):
  //   (1) parcelCountMax = round(60 + 200×scale) → round(60 + 200×scale +
  //       80×settle)。60〜340(旧 60〜260)。街路の導入で街路沿いに区画が
  //       生まれるようになり、Settlement=100 側がほぼ全条件で上限
  //       (160/160・260/260)に飽和していたため、Settlement 連動を追加。
  //   (2) streetBudget = worldSize×(0.5+2.2×settle)×(0.55+0.9×scale) →
  //       worldSize×(0.35+2.35×settle)×(0.55+0.9×scale)。Settlement=0 の
  //       基礎係数を 0.5→0.35 へ引き下げ(寒村(建物14棟程度)に街路13〜15本が
  //       生えていたのを是正)。Settlement=100 側の係数 2.7 は不変。
  // どちらも Settlement Pressure に連動する式であり、乱数消費は不変
  // (parcelCountMax は棄却上限、streetBudget は成長打ち切り閾値としてのみ
  // 使われるため、乱数消費順自体は変わらないが、生成結果(区画・街路の本数と
  // 形状)が変わるため密度→結界→広場→区画→建物→植生へ連鎖し、全 8 組が変わる。
  // 新旧対応(B5 → B6):
  //   everdusk-101 {}              1899b2b0 → d92da4fc
  //   everdusk-101 {water:0}       3519feb0 → 50e1727f
  //   everdusk-101 {water:95}      d445ceb0 → 2bff0d52
  //   everdusk-101 {worldScale:0}  6ff6fe5d → c016779e
  //   everdusk-101 {worldScale:100} 214d49fe → 5ad9fb39
  //   seed-a {}                    9bdacd9a → c9345f90
  //   seed-b {}                    32764980 → d7f9a3ee
  //   seed-b {water:70}            88009bca → c0c7c687
  //
  // 計画書 2026-07-12-worldgen-rework-layout.md タスク C2 で更新。意図した変更:
  // `Parcel.groupId`("block/<roadEdgeId>/<L|R>/<runIndex>")を新設した
  // (contracts/buildings.md「区画グループとクラスタパターン」)。同一
  // roadEdgeId・同一側(L/R)でスロット連番が連続して採択された区画の並び
  // (run)を、採択済み区画からの決定論的な後処理で検出して付与する
  // (parcels.ts assignGroupIds)。乱数は消費せず、区画の採択・位置・数・
  // 順序も一切変えない(4 seed × 3 param 組で groupId を除いた区画列が
  // 変更前とビット同一であることを一時比較で確認済み)。groupId は
  // WorldModel 直下の Parcel の新規フィールドであり正規化ハッシュの
  // 直列化対象に加わるため、区画が1件でも存在する組はすべてハッシュが変わる
  // (フィールドの追加自体が構造差になるため)。本表の全 8 組は区画を持つため
  // 全組が変わる。
  // 新旧対応(B6/B7 → C2):
  //   everdusk-101 {}              d92da4fc → dc90e334
  //   everdusk-101 {water:0}       50e1727f → 601ffc8c
  //   everdusk-101 {water:95}      2bff0d52 → 4d4da11e
  //   everdusk-101 {worldScale:0}  c016779e → 7ac593d7
  //   everdusk-101 {worldScale:100} 5ad9fb39 → 4d2444f6
  //   seed-a {}                    c9345f90 → 8b072991
  //   seed-b {}                    d7f9a3ee → 223287ea
  //   seed-b {water:70}            c0c7c687 → 55c73d2d
  //
  // 計画書 2026-07-12-worldgen-rework-layout.md タスク C3 で更新。意図した変更:
  // (1) サイズ勾配(contracts/buildings.md「floors の改訂」): floors の算出式に
  //     urbanity 項を追加した(`floorsBase += 1.1 × smoothstep(0.55, 0.9,
  //     urbanity(建物位置))`。urbanity は `model.zoning` から footprint 手前の
  //     center 位置でサンプルする、Phase B 導入の既存 FieldGrid)。クランプ
  //     上限を「urbanity ≥ 0.75 の一般建物のみ 4、それ以外は従来どおり 3」に
  //     した(中心建築の 1〜5 階は不変)。
  // (2) 同型連続の抑制(contracts/buildings.md「同型連続の抑制の設計原理」):
  //     `Parcel.groupId` のハッシュ + parcel.id 由来のスロット連番から決まる
  //     決定論的な ±1 符号(`layoutParity`。乱数非消費)を導入し、house の
  //     L 字抽選確率(`0.35 ± 0.25×parity`)・壁材/屋根材の階層添字の揺らぎ
  //     (`±0.5×parity` を既存 rng ±0.6 揺らぎに加算)・hip 屋根抽選確率
  //     (`±0.1×parity`)・roof.pitch(`±1.5°×parity`)へ加算した。いずれも
  //     隣接建物の生成結果は参照しない(位置由来のみ)。
  // どちらも乱数消費数・消費順は不変(floors の urbanity 項・parity 変調は
  // すべて既存の乱数値への加算/クランプ対象の変更のみ)。区画が1件でも存在
  // する組はすべて生成結果(floors・shape・materials・roof)が変わるため、
  // 全 8 組のハッシュが変わる(water:0 も区画・建物は生成されるため対象)。
  // オーケストレーター確認(Settlement 100・3 seed): floors[1/2/3/4] の
  // 棟数分布は概ね 0/0〜3/123〜219/2、4 階はすべて urbanity ≥ 0.75 の位置
  // (below75floor4 = 0 を機械確認)。壁材 3 連続の頻度(区画グループ内・
  // スロット順の長さ3窓)は変調前 29/191(rate 0.152)→ 変調後 17/191
  // (rate 0.089)で明確に低下した。
  // 新旧対応(C2 → C3):
  //   everdusk-101 {}              dc90e334 → f7fac9c2
  //   everdusk-101 {water:0}       601ffc8c → 804d1da0
  //   everdusk-101 {water:95}      4d4da11e → a24efad4
  //   everdusk-101 {worldScale:0}  7ac593d7 → 1e6ad8b1
  //   everdusk-101 {worldScale:100} 4d2444f6 → 7aec297a
  //   seed-a {}                    8b072991 → c8729c73
  //   seed-b {}                    223287ea → c645b0dd
  //   seed-b {water:70}            55c73d2d → f01a5f6f
  // C4b(グループ抽選と雁行。計画書 2026-07-12-worldgen-rework-layout.md
  // タスク C4b。contracts/buildings.md「区画グループとクラスタパターン」
  // 「雁行(stagger)の性質」)で更新。意図した変更:
  // (1) 段12「建物」の本番ループの前に、区画グループ(`Parcel.groupId`)
  //     ごとに `makeRng(seed, "layout/<groupId>")` の固定消費でクラスタ
  //     パターン(rowhouse/courtyard/stagger/single)を 1 つ抽選する
  //     (`planGroupLayouts`。契約「抽選消費の先行(13)」により rowhouse 当選・
  //     courtyard 当選も本タスクでは single として扱う=footprint 生成は
  //     従来どおり単棟のまま変わらない)。新設ストリームの消費が加わるため、
  //     区画グループが 1 件でも存在する組(=区画が採択される全組)のハッシュが
  //     変わる。
  // (2) 雁行(stagger)当選グループの各建物に、グループ内序数のパリティで
  //     前面セットバック 0.5 / 2.0 を交互に与え(`frontSetback`)、footprint
  //     重心まわりの向き揺らぎを従来のランダム揺らぎ(rng 消費値は捨てるが
  //     消費自体は行い、消費順・消費数は不変)から決定論的な ±4°(頂点変位は
  //     従来と同じ shiftCap で安全側にクランプ)へ置き換えた
  //     (waterside/canalside 区画を含むグループは雁行の適格から除外。
  //     契約 3.4 節(14))。
  // (3) 連棟の適格判定(役割が house 系に揃うか)のため、`planGroupLayouts`
  //     内で `"building/<id>"` と同一ラベルの使い捨て rng インスタンスで
  //     `decideRole` を先読みする。同一ラベルの新規 `makeRng` は独立した
  //     状態を持つ純関数のため、本番ループの `"building/<id>"` ストリームの
  //     消費列には影響しない。
  // いずれも乱数消費順・消費数は「building/<id>」「parcel/<id>」の既存
  // ストリームでは不変(新設の `"layout/<groupId>"` ストリームの消費のみ
  // 追加)。全 8 組のハッシュが変わる(区画が生成される全組が対象)。
  // 実装時スイープで確認: 4 seed(既定 SEEDS + 追加 seed)× Settlement
  // {50,100} × Prosperity{50,100} のスイープで、雁行(stagger)当選グループが
  // 各条件で複数出現し、当選グループ内でセットバックが交互(統計的に
  // 有意な差)になることを確認済み(詳細は本タスクの実装報告を参照)。
  // 新旧対応(C3 → C4b):
  //   everdusk-101 {}              f7fac9c2 → 1a247577
  //   everdusk-101 {water:0}       804d1da0 → 49094d75
  //   everdusk-101 {water:95}      a24efad4 → 3eec1d88
  //   everdusk-101 {worldScale:0}  1e6ad8b1 → 363fcd8e
  //   everdusk-101 {worldScale:100} 7aec297a → 0dad2c84
  //   seed-a {}                    c8729c73 → e8e1b942
  //   seed-b {}                    c645b0dd → f9e003fe
  //   seed-b {water:70}            f01a5f6f → f99be753
  // C4c(中庭型: 回転・塀・courtyard Plaza。計画書
  // 2026-07-12-worldgen-rework-layout.md タスク C4c。
  // contracts/buildings.md「中庭型(courtyard)の性質」「建物部品の性質」)で
  // 更新。意図した変更:
  // (1) 中庭型(courtyard)当選グループ(C4b までは単棟同様に扱っていた)を
  //     実際に組む: 全メンバーの背面セットバックを後退させ(区画の素の
  //     可住奥行きから決定論的に算出した目標値。役割別サイズ式自体は
  //     不変)、footprint を矩形へ固定する(L/T 抽選は行い結果を破棄)。
  // (2) グループ先頭・末尾の建物を、接道正面セットバック線上の点を軸に
  //     footprint をちょうど 90° 回転する候補へ差し替える(他の建物・
  //     道路・広場と衝突する場合、またはその建物の役割が waterside の
  //     場合はフォールバックして従来の単棟のまま残す)。
  // (3) 扉は wing0 の 4 外壁面のうち、外向き法線が親区画の facing に
  //     最も近い面へ置く(`expandDetailParts` の `doorFace` 選択則。
  //     回転していない建物では常に従来の front 面が選ばれるため、
  //     「扉の外向き=親区画 facing」の既存検証は無傷)。
  // (4) グループの区画データ(frontEdge・可住奥行き)と確定済み中間メンバー
  //     の footprint から塀(courtyard-wall。グループ先頭の建物に帰属)と
  //     courtyard Plaza(id "plaza/courtyard/<groupId>")の外形を導出し、
  //     帯制約(グループのいずれかの区画から 1.2 以内)を満たすまで間口
  //     方向を段階的に縮める。満たせない、または最小寸法(幅 6・奥行き
  //     2.5)を下回る場合はグループ全体を単棟へフォールバックする。
  // いずれも乱数は消費しない(セットバック・回転・塀・Plaza の導出は
  // 区画データと確定済み建物からの決定論的な後処理)。中庭型当選グループが
  // 1 件でも存在する組はハッシュが変わる: everdusk-101 {}・{water:0}・
  // {water:95}・{worldScale:100}・seed-a {}・seed-b {water:70} の 6 組が
  // 該当し、{worldScale:0}(世界が小さく長さ3以上のグループが生じない)と
  // seed-b {}(中庭型が当選しない)の 2 組は不変(実測で確認済み)。
  // 新旧対応(C4b → C4c):
  //   everdusk-101 {}              1a247577 → 0091b572
  //   everdusk-101 {water:0}       49094d75 → 552f861a
  //   everdusk-101 {water:95}      3eec1d88 → b1584d11
  //   everdusk-101 {worldScale:0}  363fcd8e → 363fcd8e(不変)
  //   everdusk-101 {worldScale:100} 0dad2c84 → 2af12dc2
  //   seed-a {}                    e8e1b942 → 50591329
  //   seed-b {}                    f9e003fe → f9e003fe(不変)
  //   seed-b {water:70}            f99be753 → 5c0653a3
  // C5(連棟(rowhouse)。計画書 2026-07-12-worldgen-rework-layout.md タスク
  // C5。contracts/buildings.md「連棟(rowhouse)の性質」)で更新。意図した変更:
  // (1) `Building.spanParcelIds` を新設した(単棟は長さ 1 = [parcelId]、
  //     連棟は列の全区画 id。先頭 = parcelId)。WorldModel 直下の Building の
  //     新規フィールドであり正規化ハッシュの直列化対象に加わるため、建物が
  //     1 棟でも存在する組はすべてハッシュが変わる(フィールドの追加自体が
  //     構造差になる。groupId 導入時の C2 と同型)。
  // (2) 連棟(rowhouse)当選グループ(C4b までは単棟同様に扱っていた)を
  //     実際に合成する: 本番ループがメンバー全員を単棟として生成した後
  //     (`"building/<id>"` 系ストリームの消費数・消費順は不変)、
  //     `finalizeRowhouseGroups` が k 区画を貫く帯状矩形の 1 棟へ差し替える。
  //     footprint(帯状矩形。列の両端のみ通常の側面セットバック)・壁体・
  //     連続屋根(単一の gable。妻は両端のみ)は乱数を消費せず区画データと
  //     確定済み先頭区画の建物(役割・階数・素材・基壇高をそのまま流用)から
  //     導出する。ファサード(住戸ごとの扉 1・窓列・独立採択の煙突+住戸境界の
  //     分節縦梁)のみ `"building/<compositeId>/details"` の新規インスタンス
  //     (先頭区画と同一ラベル。メンバー生成が消費した既存インスタンスとは
  //     独立)を消費する。成立しない場合(帯状矩形が他の建物・道路・広場と
  //     衝突、寸法が最小値未満、帯制約 1.2 を満たさない)はメンバーを単棟の
  //     まま残す(決定論的フォールバック)。
  // `layout/<groupId>` の抽選(消費数・消費順)は C4b から不変(契約 (13))。
  // 連棟が 1 件でも成立する組はハッシュが変わる: 実装時スイープ(4 seed ×
  // Settlement/Prosperity 4 組)で連棟当選 103 グループ中 92 成立(最長スパン
  // 10 区画、成立棟の住戸合計 410)。建物が 1 棟でも存在する組はすべて (1) の
  // 影響を受けるため、本表の全 8 組が変わる。
  // 新旧対応(C4c → C5):
  //   everdusk-101 {}              0091b572 → 781cc8df
  //   everdusk-101 {water:0}       552f861a → 79b95e14
  //   everdusk-101 {water:95}      b1584d11 → 2a409626
  //   everdusk-101 {worldScale:0}  363fcd8e → 2fde376a
  //   everdusk-101 {worldScale:100} 2af12dc2 → fcce29e5
  //   seed-a {}                    50591329 → 8462e141
  //   seed-b {}                    f9e003fe → 69c3c3a1
  //   seed-b {water:70}            5c0653a3 → 58715b26
  // C6(裏庭。計画書 2026-07-12-worldgen-rework-layout.md タスク C6。
  // contracts/buildings.md「裏庭の性質」)で更新。意図した変更: 段12「建物」
  // が区画背面の帯(建物背面〜区画背面 ≥ 2.5)へ裏庭(fence 3 本+確率で
  // shed 1 棟)を追加した。単棟・雁行は `buildParcelBuilding` 内で
  // `"building/<id>"` ストリーム(骨格)の末尾へ追加消費、連棟の共有裏庭は
  // `finalizeRowhouseGroups` が既存の `"building/<compositeId>/details"`
  // ストリームの末尾へ追加消費する(骨格・詳細の既存消費順・消費数は不変。
  // 中庭型グループは裏庭を持たないため乱数消費なし)。裏庭のある建物は
  // 1 棟でも `parts` 配列が伸びるため、建物が存在する組はすべてハッシュが
  // 変わる。実装時スイープ(3 seed × Settlement/Prosperity 5 組)で
  // 一般建物 1534 棟中 44 棟が裏庭を持ち(うち shed 14 棟)、連棟 71 棟中
  // 1 棟が共有裏庭を持った(採択率・帯条件は提案値。C7 で調整しうる)。
  // 新旧対応(C5 → C6):
  //   everdusk-101 {}              781cc8df → ff09a3b8
  //   everdusk-101 {water:0}       79b95e14 → be687c4f
  //   everdusk-101 {water:95}      2a409626 → d49389f3
  //   everdusk-101 {worldScale:0}  2fde376a → 5bed4eb1
  //   everdusk-101 {worldScale:100} fcce29e5 → c31ee40c
  //   seed-a {}                    8462e141 → 782cede1
  //   seed-b {}                    69c3c3a1 → f2ba3256
  //   seed-b {water:70}            58715b26 → 3b10d92f
  //
  // T1(裏庭の帯確保。奥行き絞りの再生成。計画書
  // 2026-07-13-worldgen-rework-tuning.md タスク T1。contracts/buildings.md
  // 「裏庭の性質」実装補足「単棟・雁行の帯確保」)で更新。意図した変更:
  // 単棟・雁行の建物のうち裏庭の帯が目標 BACKYARD_TARGET_BAND(2.9)に
  // 満たない(下限 2.5 未満で裏庭ロール自体が未実行の建物を含む)ものを、
  // 段12 本番ループの直後の後処理パス finalizeBackyardBandGrowth が
  // buildParcelBuilding を背面追加セットバック付きで再呼び出しし、奥行きを
  // 絞った単棟として再生成する(絞り上限は元の建物奥行きの32%。値の調整に
  // ついては buildings.ts の BACKYARD_REGEN_SHRINK_MAX_FRACTION のコメント
  // 参照)。再生成後に裏庭(fence)が実際に成立した建物のみ差し替える(乱数は
  // 追加消費しないが、絞りにより帯が初めて下限を上回る建物では
  // 建物自身の "building/<id>" ストリーム内で裏庭ロールが新たに実行される
  // ため、その建物の parts が伸びる)。裏庭を新たに獲得する建物が1棟でも
  // 存在する組はハッシュが変わるため、本表の全8組が変わる。中庭型・連棟は
  // 対象外(連棟の共有裏庭は従来どおり finalizeRowhouseGroups が判定する)。
  // 実測(3 seed × Settlement{0,50,100} × Prosperity{0,50,100} の27条件):
  // settle0 発生率 30.16%→63.49%、settle50 11.90%→34.99%、
  // settle100 0.66%→13.79%(完了条件 ≥10% を達成)。絞りを適用した建物
  // 387 件・平均絞り量 1.21(最大 1.88)。
  // 新旧対応(C6 → T1):
  //   everdusk-101 {}              ff09a3b8 → 9ba7191a
  //   everdusk-101 {water:0}       be687c4f → 8333c340
  //   everdusk-101 {water:95}      d49389f3 → d22e5515
  //   everdusk-101 {worldScale:0}  5bed4eb1 → aad21a5a
  //   everdusk-101 {worldScale:100} c31ee40c → 9202570a
  //   seed-a {}                    782cede1 → 9d5b26ea
  //   seed-b {}                    f2ba3256 → 83000cd2
  //   seed-b {water:70}            3b10d92f → 9f347408
  //
  // T2(中庭型の適格緩和。計画書 2026-07-13-worldgen-rework-tuning.md
  // タスク T2+3.2 節追補。contracts/buildings.md「区画グループとクラスタ
  // パターン」節)で更新。意図した変更:
  // (1) 中庭型の適格条件の緩和: グループ長 3〜5→3〜6、minUsableD 6→5。
  // (2) 適格条件への「囲いの成立見込み」事前判定の追加(3.2 節追補):
  //     グループの区画データのみから囲いの内側奥行きの見込みを見積もり
  //     (乱数非消費・順序非依存。式は契約と buildings.ts の
  //     courtyardEnclosureFeasible)、最小奥行き 2.5 に構造的に届かない
  //     グループを抽選の候補から外す。事前判定なしでは settle100 の当選が
  //     ほぼ全て降格の空振りとなり、抽選の重みを占有して連棟の成立を
  //     毀損していた(54 条件実測: 184→146 棟)。
  // (3) 採択率 `0.12+0.28×prosper` → `0.20+0.60×prosper`(事前判定と
  //     セットで、連棟の完了条件(基準の 95%)内で中庭成立を最大化)。
  // 中庭型の当選・成立が変わるグループが 1 つでも生じる seed×params の
  // 組はハッシュが変わる(中庭型メンバーは footprint の後退・回転・
  // courtyard-wall・courtyard Plaza が単棟と異なるため)。降格側(囲いの
  // 帯 1.2・最小寸法)・雁行/連棟/裏庭の判定基準は無傷(読み替え表どおり)。
  // 実測(6 seed × Settlement{0,50,100} × Prosperity{0,50,100} の54条件):
  // 中庭当選 20→37、成立(courtyard Plaza 成立)14→29、降格 8 件
  // (破綻なし)、連棟成立 184→177 棟(基準の 96.2%)。事前判定による
  // 除外は 192 グループ(うち settle100 が 183)。完了条件(3.2 節追補:
  // 中庭成立 ≥22 かつ 連棟成立 ≥ 基準の 95% = 175)を達成。8 組中 4 組は
  // 該当 seed の乱数列上たまたま中庭型の当選・成立が変わらなかったため不変。
  // 新旧対応(T1 → T2):
  //   everdusk-101 {}              9ba7191a → 1bbf4203
  //   everdusk-101 {water:0}       8333c340 → 012c27e7
  //   everdusk-101 {water:95}      d22e5515 → d22e5515(不変)
  //   everdusk-101 {worldScale:0}  aad21a5a → aad21a5a(不変)
  //   everdusk-101 {worldScale:100} 9202570a → 978ed67e
  //   seed-a {}                    9d5b26ea → 9d5b26ea(不変)
  //   seed-b {}                    83000cd2 → b832272a
  //   seed-b {water:70}            9f347408 → 9f347408(不変)
  //
  // 計画書 2026-07-13-worldgen-rework-tuning.md タスク T3(階数分布の再配分)
  // で更新。意図した変更: buildings.ts の floors 算出式(floorsBase)の
  // 係数を再配分した(contracts/buildings.md「floors の改訂」T3 追補)。
  // C7 実測で settle100 の floors 分布が 3 階 89% に偏っていたため、
  // 基準定数 1.05→0.5・urbanity 項係数 1.1→1.7・揺らぎ項を非対称
  // [-0.3,0.5] → 対称 [-0.65,0.65] へ変更した(乱数消費数・順序は不変。
  // rng.range の引数のみの変更)。floors は全建物で共通に算出されるため、
  // 8 組すべてのハッシュが変わる。
  // 新旧対応(T2 → T3):
  //   everdusk-101 {}               1bbf4203 → ff09b628
  //   everdusk-101 {water:0}        012c27e7 → 8fe1e5e2
  //   everdusk-101 {water:95}       d22e5515 → 0443ad8d
  //   everdusk-101 {worldScale:0}   aad21a5a → 6ecaca07
  //   everdusk-101 {worldScale:100} 978ed67e → 52e0c8e7
  //   seed-a {}                     9d5b26ea → 94790fdf
  //   seed-b {}                     b832272a → c682f116
  //   seed-b {water:70}             9f347408 → bfa32c09
  // 計画書 2026-07-14-worldgen-rework-facilities.md タスク D2a
  // (差し戻し 1 回を含む最終構成)で更新。意図した変更:
  // (1) スキーマ追加: `model.facilities: Facility[]`(常に空配列。段14
  //     「施設」の実装は D2b 以降)、`Parcel.kind: "residential" |
  //     "farmland"`(既定 residential)。WorldModel 直下・Parcel の新規
  //     フィールドであり正規化ハッシュの直列化対象に加わるため、区画が
  //     1件でも存在する組はすべてハッシュが変わる(groupId 導入時の C2 と
  //     同型)。全 8 組が対象。
  // (2) 農地区画の切り出し(段11「区画」の拡張。contracts/facilities.md
  //     「field(畑)・pasture(牧草地)」実装補足): farmland 区画を
  //     residential より先に切り出し、農村ゾーン(zoning の urbanity <
  //     0.45。確定判定は縮小ステップごとの実候補中心)の道路沿いを
  //     先取りする。id は parcel/<edge>/<L|R>/farm<slot> の専用 slot
  //     空間、乱数は "parcel/<id>" ストリームの流儀(奥行き揺らぎ →
  //     採択ロールの固定消費順)。間口 clamp(1.7 × residential 候補間口の
  //     中央値, 14, 40)・奥行き比 1.6・採択率 farmlandRate =
  //     clamp(0.25+0.55×(1−settle), 0.25, 0.8)。候補走査は両側不成立の
  //     位置を 1/4 間口刻みで再試行する(決定論・乱数非消費)。farmland の
  //     先取りにより residential の採択結果(区画数・位置)も変わる
  //     (D2a 差し戻しの判定基準による設計変更。当初の残地方式は
  //     Settlement 30 以降で農地が構造的に 0 件になるため棄却された)。
  // (3) 区画グループ(groupId)の run 検出に kind 一致条件を追加した
  //     (parcels.ts assignGroupIds)。residential のみの入力では常に真に
  //     なるため無挙動(既存の区画グループ化ロジックは不変)。
  // (4) 全単射契約の読み替え(contracts/buildings.md「全単射の対象範囲」。
  //     D1a で確定済み): 段12「建物」(buildings.ts の
  //     planGroupLayouts・runBuildings)は kind "farmland" の区画を建物
  //     生成・クラスタリングの対象から除外する(farmland 区画は建物 0。
  //     farmland 区画に対して "building/<id>" 系の RNG を消費しない)。
  // 農地区画の実測(6 seed × 既定 World Scale。差し戻しの判定基準):
  // settle0 平均 11.7 件/seed(最小 7)、settle20 平均 9.3(最小 7)、
  // settle50 平均 2.2(最小 1・0 件 seed なし)、settle100 は 0 件。
  // 農地の最小間口 / residential 実測中央値の比は全条件 1.68〜1.95
  // (基準 1.5 以上)。residential 区画数への影響: settle0 で 2〜7 件/seed
  // 減・settle50 で 0〜2 件減・settle100 で不変(農村の住居が農地に
  // 置き換わる)。worldScale:0 の組は farmland が 1 件も切られず
  // residential も不変のため、(1) のスキーマ追加ぶんのみの差となる。
  // farmland の量・走査則は提案値(facilities.md)であり、D7 の実測
  // スイープで調整しうる。
  // 新旧対応(T3 → D2a):
  //   everdusk-101 {}               ff09b628 → 2a39c640
  //   everdusk-101 {water:0}        8fe1e5e2 → a388ba50
  //   everdusk-101 {water:95}       0443ad8d → b8c119eb
  //   everdusk-101 {worldScale:0}   6ecaca07 → 1ad27f0e
  //   everdusk-101 {worldScale:100} 52e0c8e7 → 22074c19
  //   seed-a {}                     94790fdf → 9b96a6dd
  //   seed-b {}                     c682f116 → fc152906
  //   seed-b {water:70}             bfa32c09 → 98d588bf
  const SNAPSHOTS: [string, Partial<Params>, string][] = [
    ["everdusk-101", {}, "2a39c640"],
    ["everdusk-101", { water: 0 }, "a388ba50"],
    ["everdusk-101", { water: 95 }, "b8c119eb"],
    ["everdusk-101", { worldScale: 0 }, "1ad27f0e"],
    ["everdusk-101", { worldScale: 100 }, "22074c19"],
    ["seed-a", {}, "9b96a6dd"],
    ["seed-b", {}, "fc152906"],
    ["seed-b", { water: 70 }, "98d588bf"],
  ];

  for (const [seed, over, expected] of SNAPSHOTS) {
    it(`seed=${seed} ${JSON.stringify(over)} → ${expected}`, async () => {
      const model = await runPipeline(seed, withParams(over));
      expect(model.summary.hash).toBe(expected);
    });
  }
});
