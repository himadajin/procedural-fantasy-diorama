# main 公開前クリーンアップ(2026-07-15)

ワールド生成刷新ロードマップ(川・道路・配置・施設)の完結を受け、develop を
main へマージして公開する前の総点検と是正の計画・実施記録である。
push・main へのマージ自体は本計画の範囲外(ユーザー決定 2026-07-15)。

## 1. 背景と目的

コードコメント・テスト名に開発履歴の語彙(フェーズ名・タスク ID・commit 番号・
計画書参照)が漏れている。これらは計画書や実装時の歴史に依存した言葉であり、
コードに書くべきではない。書くならば仕様書(contracts / specs)に書き、それを
参照すべきである(ユーザー指摘 2026-07-15)。あわせて、main マージ時に問題と
なる箇所がないかを認知バイアスを避けて総点検する。

方針(ユーザー決定 2026-07-15):

- 修正規模の最小化は目的ではなく、**ルールの一貫性**を重視して全面修正する。
  初期実装由来の「PHASE n commit m」参照も、刷新由来の「Phase X・タスク ID」
  参照も、すべて対象。
- 総点検で新たに見つかった問題も修正する。
- push・main へのマージ作業は行わない。LICENSE 等の公開適合対応は行わない。

## 2. 総点検の結果(2026-07-15。5 レンズのサブエージェント検証)

互いに独立な 5 観点で検証した。要約のみ記す(全数一覧は受け入れ基準の
grep で再導出可能)。

1. **歴史語彙の全数列挙**: src/ + test/ の全 61 ファイルに計 431 件。
   内訳 — A: 歴史語を削れば自立 240 件 / B: 実在する契約節への付け替えが必要
   102 件 / C: 受け皿となる契約記述が未存在 40 件(実質 9 論点)/ D: テスト名内
   49 件。危険注意: 回転・アニメーション位相を表す変数名 `phase` は無関係
   (一括置換禁止)。パイプラインの「段 N」は contracts/pipeline.md が定義する
   現行概念であり歴史語彙ではない。test/hash.test.ts の 40〜700 行はハッシュ値
   変遷のチェンジログであり、行単位でなくブロック単位で扱う。
2. **参照整合**: 不一致 0 件(コード→docs 285 箇所、docs 相互リンク、
   docs→コードのシンボル 37 個・パス 23 個、contracts/README.md 索引)。
3. **残骸・デッドコード**: 到達不能コード・コメントアウト塊・`.only`/`debugger`
   等は 0 件。`src/model/worldmodel.ts:11-12` の未使用バレル再エクスポート 2 行、
   `docs/user/.gitkeep` の冗長、ビルドの単一チャンク警告(容認の明文なし)のみ。
4. **docs⇄実装整合**: 乖離 4 件。重大 2 件はいずれも `docs/user/README.md` に
   水系刷新前の「川」が残存(Water Presence 説明・サマリーの読み方)。軽微は
   パネルのスライダー説明文の列挙欠落(梁・格・結界門/聖域/水晶ほか)。数値系
   (マテリアル色 15 点・ライティング・回転周期・UI トークン・施設配置式)は
   全一致。「扱わないもの」への抵触なし。
5. **新鮮な目(文脈なしの総点検)**: High 2 件 — (H1) 風車・水車の造形が生成する
   door/window 部品を `src/mesh/facilities.ts` が描画できず黙って捨てており、
   生成のたびに console.warn「未知の部品型 4 件を読み飛ばした」が出る実バグ
   (契約 facilities.md は開口を明記。WorldModel・ハッシュには入るのに絵に
   出ない)。(H2) README の「川」残存(レンズ 4 と同一)。Medium 8 件のうち
   要対処: test/summary.test.ts のテスト名「段15 サマリー」×4 が現行の段 16 と
   不一致(段 14「施設」挿入時の更新漏れ)、implementation-spec.md 1.2/1.3 節の
   モジュール・段一覧が現行 16 段構成と乖離、テストヘルパーのコピペ
   (cached×13・段チェーン手組み×約15・withParams×3)による drift ハザード。
   決定性規律・モジュール境界・リソース管理・ハッシュ運用は精査の上クリーン。

## 3. スコープとタスク分割

タスクは N1 から N6 の順に逐次実行する。**本計画に生成ロジックの変更は一切
含まれない**ため、全タスクで 8 つのハッシュ SNAPSHOT が不変であることが
受け入れ条件になる(更新は発生しない)。

### N0: docs: 規範の追加と本計画書(オーケストレーター)

- workflow.md に「コードコメント・テスト名の規範」を追加(歴史語彙の禁止・
  契約参照への一本化・docs-first での受け皿追記)。
- plans/README.md に本計画のエントリを追加。

### N1: docs: 契約の受け皿整備と文書追随(`docs:`)

コードから参照するための受け皿を先に整備し、文書側の乖離を是正する。
コード変更は含まない。

- `docs/user/README.md`: Water Presence 説明とサマリーの読み方から「川」を
  除去し design.md の該当記述と揃える。「集会所」を UI 実表記「公館」に統一。
- 受け皿の追記(レンズ 1 の C 分類):
  - `contracts/network-plaza.md` 二次街路節: kick 角(70°〜110°)の根拠。
  - `specs/design.md` 入力節: デフォルト seed の選定基準の短い注記。
  - `specs/design.md` UI とサマリー節: 「タブ切替では再生成しない」規約。
  - `specs/art-direction.md` 8 節: ギャラリー初期構図の距離決定則
    (バウンディング球と FOV から算出)。
  - `contracts/buildings.md` 同型連続の抑制節: 統計的実測の実装補足。
  - `contracts/pipeline.md` ハッシュ節: 「ハッシュ比較は同一エンジン内での
    み保証」の一文と、mesh 側ハッシュ補助関数(hash3/hash2)の値域
    0 ≤ h < 1 の契約化(配置はエージェント裁量で適切な節に)。
  - mesh の「未知の部品型は警告して読み飛ばす」防御規約の明文化
    (配置候補: contracts/materials.md または pipeline.md)。
  - `contracts/pipeline.md`: `src/pipeline/run.ts` の rAF/setTimeout 参照は
    チャンク実行スケジューリングのみの意図的例外で生成結果に影響しない旨。
- `specs/implementation-spec.md` 1.3 節: 「段構成の正は contracts/pipeline.md」
  の宣言を追加し、段一覧を現行 16 段に追随。1.2 節のモジュール構成例も現行に
  追随(1.10 節の歴史保存註記と整合させ、意図的保存と更新漏れを区別する)。
- `contracts/materials.md` 冒頭: 同期先を「art-direction 5.1 節・5.5 節」に修正。
- `specs/implementation-spec.md` 性能規律の節: three.js 起因の単一チャンク
  (約 770KB / gzip 約 220KB)の Vite 警告は容認済みである旨を明記。
- `docs/user/.gitkeep` の削除。

### N2: src/ の歴史語彙の全面除去と stale コメント修正(`chore:`)

- src/ 内の歴史語彙(約 291 件)を全数処置: A は歴史語のみ削除、B は実在する
  契約節参照へ付け替え、C は N1 で整備した受け皿への参照に置換。
- 事実と食い違う stale コメントの是正: `src/model/worldmodel.ts`(「それまで
  null / 空配列」等の過渡的記述)、`src/pipeline/buildings.ts`(rowhouse /
  courtyard の過渡的注記)、`src/pipeline/parcels.ts` / `buildings.ts` 冒頭の
  旧 13 段基準の段番号(現行の段番号に修正)。
- `src/model/worldmodel.ts` の未使用バレル再エクスポート 2 行を削除。
- 禁止事項: 変数・フィールド名の `phase`(回転位相)に触れない。「段 N」は
  現行概念なので保持。挙動変更は一切なし(コメントと未使用 export のみ)。

### N3: test/ の歴史語彙の除去とテスト名改名(`chore:`)

- test/ 内の歴史語彙(約 140 件)を全数処置。テスト名・describe の改名は
  アサーションの意味を変えない。
- `test/hash.test.ts`: 40〜700 行のハッシュ値変遷チェンジログをブロック削除し、
  現行の 8 SNAPSHOT 値と「更新の意図は commit メッセージに記す」規約
  (contracts/pipeline.md)への参照のみを残す。**SNAPSHOT の値自体は 1 桁も
  変更しない。**
- `test/summary.test.ts`: テスト名の「段15」を現行の「段16」に修正(4 箇所)。
- `test/waterfront.test.ts`: 代表 seed 選定の経緯記述を削除し、現行の不変条件
  (複数の水辺タイプ共存)の記述のみ残す。
- `test/smoke.test.ts`(スキャフォールド残骸)を削除(438 → 437 件になる)。

### N4: 施設メッシュの door/window 描画修正(`chore:`)

- `src/mesh/facilities.ts` が風車・水車の door/window 部品を描画できるように
  する(素材・寸法規則は建物の door/window と同一。実装経路はエージェント
  裁量)。修正により「未知の部品型」warn がデフォルト seed・ギャラリーで
  0 件になること。
- 回帰テストを新設(施設の全部品型が読み飛ばされないこと)。
- `src/viewer/spin.ts` の未使用 `collectSpinners` と `src/mesh/build.ts` の
  同等インライン実装の二重化を一本化。
- 水路水面高の定数二重定義(`mesh/bridgeparts.ts` と `mesh/paving.ts`、同値)を
  参照共有に一本化。
- mesh のみの変更であり WorldModel・ハッシュに影響しない。目視検収は
  オーケストレーターがギャラリー(風車・水車)で行う。

### N5: テストヘルパーの集約(`chore:`)

- `test/helpers.ts` を新設し、コピペされた `cached`・段チェーン手組み
  (`buildUpTo` として集約。`src/pipeline/steps.ts` と同期)・`withParams` を
  一本化して全該当ファイルを移行。
- 非同期 runPipeline 方式と同期手組み方式の混在の統一はスコープ外
  (ヘルパー化のみ)。テスト数・アサーション意味は不変。

### N6: UI 文言と半開シートの仕様追随(`chore:`)

- `src/ui/panel.ts` スライダー説明文を design.md の列挙に追随: Prosperity に
  「梁」、Monumentality に「格」、Arcana に「結界門・聖域・水晶」と「最低値では
  魔法要素が消える」旨を補完(短い説明文の範囲で)。
- `src/ui/styles.css` モバイル半開シートの非表示リストにギャラリーの対象
  セレクタ行・アクション行を追加(art-direction 9.4 節「半開= seed と Generate
  のみ」に追随)。

### 対象外(記録のみ。将来の候補)

- テスト網羅の拡充(mesh/facilities の回帰テスト以外、pipeline/noise.ts、
  ui/summary.ts)/ ESLint による境界・Math.random 禁止の機械化 /
  `?gallery=` 直リンク時の FPS プリセット補正(既存の初期構図バグ課題に統合)/
  タブの ARIA 補完 / clamp・smoothstep 等の純関数ヘルパー集約(早すぎる抽象化を
  避ける)/ パイプライン警告の本番ゲート / package.json engines と .nvmrc の
  表記整合 / three.js の manualChunks 分割(警告は容認を明文化)/
  同一ファイル内でしか使われない export 58 件(慣習であり残骸ではない)。

## 4. 受け入れ基準

統合ブランチ上で以下をすべて満たす。

1. `grep -rniE "phase [a-d]\b|PHASE [0-9]|フェーズ|計画書|plans/20|commit [0-9]|タスク [A-DGT][0-9]" src test` が 0 件
   (回転位相の変数名 `phase` は該当しないことを目視確認)。
2. `test/hash.test.ts` の 8 SNAPSHOT 値が本計画の全 commit を通して不変
   (git diff で値行の変更が無いこと)。
3. `npm test`・`npm run typecheck`・`npm run lint`・`npm run build` が全緑
   (テスト件数は smoke 削除と回帰テスト追加を反映した数で全緑)。
4. `npm run dev` でデフォルト seed の生成・ギャラリー(風車・水車)表示時に
   console warn/error が 0 件(H1 の解消)。
5. docs の乖離(README の川・集会所、implementation-spec 1.2/1.3、materials
   表題)が解消され、レンズ 2 相当の参照整合が保たれている。

## 5. 実行プロトコル

- ワールド生成刷新(Phase A 以降)の体制(workflow.md)を踏襲する:
  サブエージェントが実装と commit、オーケストレーターはコードを書かず
  指示・レビュー・マージのみ。タスクは逐次実行。リモート操作は一切禁止。
- ブランチ: 統合 `chore/main-prep`(develop から作成)、タスク
  `chore/main-prep-n<N>-<slug>`。commit プレフィックスは `chore:`
  (docs のみは `docs:`)。
- モデル: 全タスク claude-sonnet-5(新規造形判断を含まないため。N4 の描画
  修正は既存の建物 door/window の素材・規則の流用であり造形設計ではない)。
- 差し戻し運用は `plans/2026-07-11-worldgen-rework-water.md` 5.5 節を踏襲
  (同一エージェントへ最大 2 回 → 新規エージェント 1 回 → エスカレーション)。
- レビューは workflow.md「レビュー6観点」。本計画は生成変更ゼロが前提のため、
  観点 2(決定性)は「SNAPSHOT 不変の確認」に読み替える。

## 6. 進捗ステータス

| タスク | 状態 | 備考 |
|---|---|---|
| N0 規範追加と計画書 | 完了 | 本 commit |
| N1 docs 受け皿整備と文書追随 | 未着手 | |
| N2 src/ 歴史語彙の全面除去 | 未着手 | |
| N3 test/ 歴史語彙の除去と改名 | 未着手 | |
| N4 施設 door/window 描画修正 | 未着手 | |
| N5 テストヘルパー集約 | 未着手 | |
| N6 UI 文言・半開シート追随 | 未着手 | |
| 検収(受け入れ基準 1〜5) | 未着手 | |
