# パイプライン・RNG インターフェース契約

モジュール間(rng / pipeline / model / mesh / viewer / ui)のインターフェースの正。
変更はコードより先に本書を更新する。
生成手順の設計意図と検証条件は `../specs/implementation-spec.md` を参照。

## モジュール境界規則

- `rng/`・`model/`・`pipeline/` は Three.js 非依存の純関数群とする。
  `three` の import を禁止し、ESLint の import 制約で機械化する。
- `mesh/` は WorldModel のみを入力とし、パイプラインの内部状態に依存しない。
  純関数の共用は状態依存ではないため許す(例: 発光面積の正
  `pipeline/center.ts` の `glowPartArea` を `mesh/wardparts.ts` が共用する。
  wards.md「結界構造の立体化」)。
- `mesh/wardparts.ts`(結界立体・魔法灯・浮遊要素の Part 展開。
  PHASE 5b commit 17〜18)と `mesh/bridgeparts.ts`(橋の Part 展開。
  PHASE 5b commit 18)は mesh 配下だが three 非依存の純関数とし、
  テストから直接検証できる。WorldModel には書き戻さない
  (正規化ハッシュに影響しない)。橋の渡り区間の標本化・道路リボンの
  基準高・水路上の持ち上げ量は bridgeparts を正とし、
  `mesh/paving.ts` が同じ純関数・定数を共用して取り付きの隙間を
  出さない(wards.md「魔法灯・浮遊要素・橋の立体化」)。
- `viewer/` は時間演出(浮遊の上下動、発光の明滅、カメラ慣性)と
  描画プリセットの適用(下記「描画プリセット・LOD・デバッグ表示」)を
  担当する。時間・表示状態・プリセットを WorldModel に書き戻さない。
- `ui/` は params と seed の編集、Generate の発火、サマリー表示のみを行う。
  生成内容には関与しない。

## RNG API(`src/rng/`)

```ts
hashString(s: string): number          // 文字列→32bit整数ハッシュ(FNV-1a)
makeRng(seed: string, label: string): Rng
                                       // seedとラベルのハッシュから独立ストリームを派生

interface Rng {
  next(): number                       // [0, 1)。基礎PRNGは splitmix32
  range(min: number, max: number): number
  int(min: number, max: number): number      // 両端含む整数
  normal(mean: number, stddev: number): number  // 正規分布近似
  pick<T>(items: T[]): T
  weighted<T>(items: T[], weights: number[]): T
  shuffle<T>(items: T[]): T[]          // 非破壊。Fisher-Yates
  chance(p: number): boolean
}
```

規約(implementation-spec 1.4節):

- `Math.random()` の使用を全面禁止する。
- サブストリームのラベル体系: 段の名前(`"water"`、`"network"` 等)、
  要素ごとの乱数は安定IDから派生(`"building/" + buildingId`、
  `"parcel/" + parcelId` 等)。生成順序の変更が無関係な箇所の乱数消費に
  波及しないようにする。
- 環境依存になりうる順序(`Object.keys` 等)に乱数消費を依存させない。
- リトライを含む処理(結界環の再生成、水路の再サンプル)は、
  リトライ回数も同一ストリームから消費して決定性を保つ。

## パイプライン段契約

各段は `(model: WorldModel, rng基盤) => void`(担当フィールドを埋める)の純関数。
後段は前段の結果のみに依存する。段の順序と担当フィールド:

| # | 段(ステップ名) | モジュール | 読む | 書く |
|---|---|---|---|---|
| 1 | 導出設定 | pipeline/derive | seed, params | meta.derived |
| 2 | 地面 | pipeline/ground | meta | ground(zoneMask下地) |
| 3 | 水系 | pipeline/water | meta, ground | water.rivers/lakes/shoreline、ground.edgeStyle、zoneMask(湿地・砂洲) |
| 4 | 立地評価 | pipeline/siting | meta, ground, water | centerPlan.position/footprint/axes、network.entryPoints |
| 5 | 道路網 | pipeline/network | 〜centerPlan | network.nodes/edges、water.bridges |
| 6 | 水路 | pipeline/canals | 〜network | water.canals、water.bridges(追加) |
| 7 | 一次密度場 | pipeline/density | 〜canals | density.primary |
| 8 | 結界計画 | pipeline/wards | 〜density.primary | wards 一式、water.bridges(再抽出) |
| 9 | 広場 | pipeline/plazas | 〜wards | plazas、centerPlan.facing/heightHint |
| 10 | 舗装 | pipeline/paving | 〜plazas(network / water.canals / plazas) | ground.zoneMask(舗装チャネル上書き) |
| 11 | 区画 | pipeline/parcels | 〜舗装 | density.final、parcels |
| 12 | 建物 | pipeline/buildings | 〜parcels | buildings(骨格+部品リスト。中心建築を含む)、plazas(中庭 "courtyard" の追記) |
| 13 | 小道 | pipeline/lanes | 〜buildings | network.nodes/edges(lane の追記のみ)、ground.zoneMask(小道の舗装追記)、summary.scale.roadLength(加算) |
| 14 | 植生 | pipeline/vegetation | 〜lanes | vegetation |
| 15 | サマリー | pipeline/summary | 全部 | summary |

- 各段はパイプライン内アサーション(データ検証)を持ってよい。
  違反は throw せず件数を console に出し、生成は続行する
  (詳細は implementation-spec 1.10節)。
- 各段の表示名(「水系を計画中…」等)は Generating インジケーターに
  そのまま使う(art-direction 9.5節)。
- 段6「水路」の BridgeSite 追加は仮のもので、段8「結界計画」が結界門
  スナップ後に全道路 edge を河川・湖・水路の合成水域で標本化し直して
  bridges 全体を置き換える(ground-water.md Water 節)。水路は waterfield・
  岸線に影響させない(同節の設計判断)。zoneMask への舗装上書きは
  段5/6/9 の各段では行わず、段10「舗装」へ集約する
  (ground-water.md ZoneMask 節)。段10 は乱数サブストリームを消費しない。
- 段13「小道」(PHASE 4b)は段12「建物」の後に走る専用段とし、
  裏手の小道(区画の列の奥)と水路沿いの岸沿い道(towpathSide 側)を
  lane class の edge として network へ**追記のみ**で加える
  (既存 node / edge の id・内容は不変。network-plaza.md Network 節
  「小道の性質」)。小道は水域を渡らず(bridges は段8 の出力のまま)、
  結界環も横切らない(gates は段8 確定のまま)。小道の舗装被覆は
  段10 と同じ流儀で zoneMask へ追記する(乱数非消費)。乱数は要素ごとの
  独立サブストリーム `"lanes/back/<roadEdgeId>/<L|R>"` /
  `"lanes/towpath/<canalId>"` のみを消費する。
  表示名は段13「小道を通しています…」。
- リトライを含む処理(水路の交差超過の再サンプル、結界環の縮小リトライ)は
  RNG API 節の規約どおり、リトライ回数も同一サブストリームから消費する。
- 段11「区画」と段12「建物」は 2 段に分ける(設計判断: 区画は敷地の
  幾何と採択、建物は役割・骨格・部品で関心が異なり、PHASE 4b の小道追加が
  区画に手を入れずに建物段以降を再利用できるようにする)。表示名は
  段11「敷地を区切っています…」、段12「家々を建てています…」。
  PHASE 4a 内の分担: commit 12 は段11全体と段12の骨格データ
  (id / parcelId / role / footprint / facing / floors / roof / foundation)を
  埋め、commit 13 が段12の部品リスト展開(materials / parts)と
  zoneMask の建物 footprint 上書きを足す(buildings.md Parcel / Building 節)。
  段11は要素サブストリーム `"parcel/<id>"`、段12は `"building/<id>"` のみを
  消費する(段レベルの共有ストリームを持たない)。density.final の算出は
  乱数を消費しない(network-plaza.md Density 節)。
- 段12「建物」は一般建物の展開後、中心建築 1 棟(role "center"、
  parcelId null)を専用の拡張文法(pipeline/center)で展開して
  buildings の末尾に追加し、中庭の Plaza(kind "courtyard")を
  plazas へ追記する(PHASE 5a。buildings.md Parcel / Building 節
  「中心建築」)。乱数は `"building/center"` /
  `"building/center/details"` のみを消費する。スカイライン検証
  (中心最高点 ≥ 周辺一般建物の最高点 × derived.skylineRatio)と
  発光面積の上限は段12 のパイプライン内アサーションで検証する。
- 段12「建物」は waterside 役割の建物に水辺拡張の部品(杭繋ぎ梁・
  杭支持デッキ・張り出し部屋・水路裏口)を追記する(PHASE 6 commit 19。
  buildings.md「水辺建築の拡張」)。乱数は派生サブストリーム
  `"building/<id>/waterfront"` のみを消費し、既存の
  `"building/<id>"` 系ストリームの消費は変えない。
- 段14「植生」(PHASE 6 commit 20)は段13「小道」の後に走り、
  `vegetation` のみを書く(他フィールドには触れない)。散布はセル格子の
  マスクベース(森リング > 外縁草地 > 水辺低木・湿地植生 >
  道・広場周辺 > 結界内僅少。vegetation-summary.md Vegetation 節)で、
  建物・道路・広場・水面・水路バッファとの衝突をハード除外する。
  乱数はセルごとの独立サブストリーム `"vegetation/<ix>_<iz>"` のみを
  消費する。表示名は段14「草木を茂らせています…」。
- 段15「サマリー」(PHASE 7 commit 21)は全段の後に走り、`summary` の
  全フィールドを最終状態の WorldModel から機械的に**再算出**して確定する
  (中間PHASEの各段の部分先埋めを上書きするため、乖離は起こらない。
  vegetation-summary.md Summary 節)。`buildingCounts`(役割別集計)・
  `centerDescription`(支配軸+特徴からの記述文)・`waterOverview` /
  `wardOverview` / `scale` を書く。複雑度(頂点数・インスタンス数・
  draw call)は表示依存の実測値のため WorldModel に持たず UI が
  `renderer.info` から埋める(同節の設計判断)。段15 は乱数サブストリームを
  消費しない(決定的な集計)。表示名は段15「箱庭を書き留めています…」。

## チャンク実行フレームワーク

```ts
interface PipelineStep {
  name: string;                        // インジケーター表示名(日本語)
  run(model: WorldModel): void;
}
runPipeline(seed: string, params: Params, opts?: {
  onProgress?(stepName: string, index: number, total: number): void;
  signal?: AbortSignal;                // 中断。中断時は AbortError で reject する
}): Promise<WorldModel>
```

- ステップ間で requestAnimationFrame に制御を返し、生成中もカメラ操作と
  UIを生かす(フリーズ不可)。rAF が無い環境(テスト)では setTimeout に
  フォールバックする。
- `runPipeline` は全段完了後に正規化ハッシュ(下記)を `summary.hash` へ
  格納してから resolve する。
- 完了時、呼び出し側(main)が旧シーンサブツリーを dispose 付きで差し替える。
- 生成中の再入(Generate 連打)は、呼び出し側が実行中の生成を `signal` で
  中断して最後の要求だけを実行する(結果は最後の seed+params のみに依存し、
  決定性を壊さない)。

## WorldModel 正規化ハッシュ

決定性検証(implementation-spec 1.10節)の正式定義:

1. WorldModel を深さ優先で走査する。オブジェクトのキーは辞書順にソートする。
2. 数値は 1e-6 で丸めた固定精度(小数6桁)で文字列化する。
   文字列・真偽値はそのまま文字列化する。
3. 走査順にキーと値を連結した文字列を FNV-1a(32bit)でハッシュし、
   16進8桁の文字列とする。

- `summary.hash` 自身はハッシュ計算から除外する。
- 実装は `src/model/hash.ts` の `hashWorldModel`(three 非依存の純関数)。
- Vitest では「同一入力で2回生成してハッシュ一致」と
  「代表 seed×params 組のハッシュのスナップショット固定」の両方を行う。
- 画面ではサマリーの「ハッシュ」行に同じ値を出す(実機・ブラウザ間の
  決定性確認用)。開発用オーバーレイは既定非表示とし、URL パラメータ
  `?debug=1` のときのみ表示する(PHASE 7 commit 22 で統合済み。
  下記「描画プリセット・LOD・デバッグ表示」)。

## 描画プリセット・LOD・デバッグ表示(viewer / ui。PHASE 7 commit 22)

モバイル性能の確保は**表示側のみ**で行う(implementation-spec 8章、
art-direction 10節)。規律:

- **不変条件**: プリセット・LOD は `runPipeline` に一切入力されない。
  WorldModel(生成内容・正規化ハッシュ)と絵(色・光・構図。
  art-direction の全数値)はプリセットの高低で変わらない。
  判定・間引きに `Math.random()` を使わない(全て決定論的)。

**プリセット定義**(`src/viewer/preset.ts` の `RenderPreset`。高/低の2段階):

| 変えてよいもの(表示のみ) | 高 | 低 |
|---|---|---|
| pixelRatio 上限 | 2.0 | 1.5 |
| 影マップ解像度 | 2048 | 1024 |
| 影カメラ far(ワールド一辺比) | ×3 | ×2 |
| 植生の表示個体数上限(InstancedMesh の count 縮小) | 無制限 | 900 |
| 水面シェーダーのノイズ簡略度(uniform 分岐) | 3オクターブ | 1オクターブ |
| 時間 uniform(水面揺らぎ・発光明滅・浮遊上下動)の更新間隔 | 毎フレーム | 50ms |

変えてはいけないもの: WorldModel、色・光・構図(トーンマッピング露出、
ライティング、霧、パレット、カメラ構図)。発光の明滅・浮遊の簡略化は
**更新頻度の削減のみ**で行い、位相・振幅・強度の数値規範は変えない。

**デバイス簡易判定**(`choosePresetByDevice` / `correctPresetByFps`):

- 起動時に1回: `devicePixelRatio ≥ 2.5`、または物理ピクセル数
  (CSSビューポート幅×高さ×dpr²)≥ 4.6M なら「低」、それ以外は「高」。
- 初回生成の完了後に実測補正を1回だけ行う: ウォームアップ 30 フレームの後
  90 フレームの平均 fps を実測し、「高」で 40fps 未満なら「低」へ、
  「低」で 55fps 以上なら「高」へ切り替える(適用は pixelRatio・影・
  植生 count・水面 uniform・更新間隔のライブ反映のみで、再生成しない)。
- URL パラメータ `?preset=high|low` で強制でき、その場合は自動判定・
  実測補正とも行わない(検証用)。

**植生間引きの決定性**(`src/mesh/vegetation.ts`):
個体(樹木・低木)を位置ハッシュの優先順位で降順に整列し
(`vegetationDrawOrder`。乱数ストリーム非消費)、InstancedMesh には
この順で個体単位に積む。各メッシュの `userData.vegBudget` に
prefix 表(優先上位 k 個体 → インスタンス数)を持ち、viewer 側が
`count = prefix[min(k, 上限)]` に絞る。幹と樹冠の間引きは同じ個体集合で
揃う(幹だけ・樹冠だけの欠けを作らない)。同一モデル+同一プリセット →
同一表示集合。上限無制限(高)のとき表示集合は全個体で、整列は
描画順のみの違い(絵は不変)。

**遠距離 LOD**(`src/mesh/buildings.ts`。プリセット非依存):
小部品の InstancedMesh(`building-trim` / `building-openings`)は、
カメラ距離がワールド一辺の 1.15 倍から 1.5 倍にかけて
ディザ(`alphaHash`)で減衰し、透明ソートなしでポッピングを見せずに
消える。初期構図(距離 = 一辺×0.75。art-direction 8節)では減衰しない
(署名の絵を変えない)。

**メモリ規律**: 再生成時は `disposeWorld` が geometry / material /
InstancedMesh を破棄し、viewer は空ドームの差し替え時と影マップの
解像度変更時に旧リソースを破棄する。開発時は `?debug=1` で
`window.pfdSoak(n)`(連続 n 回再生成し `renderer.info.memory` を
console へ出す)により単調増加がないことを検証できる。

**デバッグ表示の縮退**(implementation-spec 1.10節の PHASE 7 対応):
WorldModel ハッシュはサマリーの「ハッシュ」行へ、renderer.info
(draw call・triangle・インスタンス・頂点)はサマリーの「複雑度」行へ
統合した。開発用オーバーレイ(calls/予算・tri・ハッシュ・プリセット名)は
既定非表示で、`?debug=1` のときのみ表示する。
