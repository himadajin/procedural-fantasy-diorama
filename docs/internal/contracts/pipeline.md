# パイプライン・RNG インターフェース契約

モジュール間(rng / pipeline / model / mesh / viewer / ui)のインターフェースの正。
変更はコードより先に本書を更新する。
生成手順の設計意図と検証条件は `../specs/implementation-spec.md` を参照。

## モジュール境界規則

- `rng/`・`model/`・`pipeline/` は Three.js 非依存の純関数群とする。
  `three` の import を禁止し、ESLint の import 制約で機械化する。
- `mesh/` は WorldModel のみを入力とし、パイプラインの内部状態に依存しない。
- `viewer/` は時間演出(浮遊の上下動、発光の明滅、カメラ慣性)を担当する。
  時間・表示状態を WorldModel に書き戻さない。
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
| 12 | 建物 | pipeline/buildings | 〜parcels | buildings(部品リスト含む) |
| 13 | 植生 | pipeline/vegetation | 〜buildings | vegetation |
| 14 | サマリー | pipeline/summary | 全部 | summary |

- 各段はパイプライン内アサーション(データ検証)を持ってよい。
  違反は throw せず件数を console に出し、生成は続行する
  (詳細は implementation-spec 1.10節)。
- 各段の表示名(「水系を計画中…」等)は Generating インジケーターに
  そのまま使う(art-direction 9.5節)。
- 段6「水路」の BridgeSite 追加は仮のもので、段8「結界計画」が結界門
  スナップ後に全道路 edge を河川・湖・水路の合成水域で標本化し直して
  bridges 全体を置き換える(worldmodel.md Water 節)。水路は waterfield・
  岸線に影響させない(同節の設計判断)。zoneMask への舗装上書きは
  段5/6/9 の各段では行わず、段10「舗装」へ集約する
  (worldmodel.md ZoneMask 節)。段10 は乱数サブストリームを消費しない。
- リトライを含む処理(水路の交差超過の再サンプル、結界環の縮小リトライ)は
  RNG API 節の規約どおり、リトライ回数も同一サブストリームから消費する。

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
- 画面のデバッグ表示にも同じ値を出す(実機確認用。renderer.info の
  draw call・triangle 数と併記し、PHASE 7 でサマリーへ統合する)。
