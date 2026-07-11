# WorldModel スキーマ契約 — 植生とサマリー(Vegetation・Summary)

WorldModel スキーマ契約の一部(2026-07-07 に worldmodel.md から分割)。
本書は Vegetation と Summary の正である。
スキーマの変更はコードより先に本書を更新する。
索引と節→ファイルの対応表は [README.md](README.md) を参照。
関連: Summary が集計する各ドメインの値は README.md の対応表から辿る。

### Vegetation(PHASE 6 commit 20)

```ts
interface Vegetation {
  trees: { id: string; position: Vec2; form: "conifer" | "broadleaf";
           scale: number; rotation: number; colorVar: number }[];
  shrubs: { id: string; position: Vec2; scale: number }[];
  grassPatches: { id: string; polygon: Polygon }[];
}
```

植生の性質(段14「植生」= `pipeline/vegetation.ts` が保証し、
後段・メッシュビルダーが前提としてよい):

- **格子走査**: 一辺 `VEG_CELL = 5.0`(実寸)のセル格子を
  `[-size/2, +size/2]²` に張り、セルごとに候補 1 点(セル内ジッター)を
  生成する。走査順は z 外側 → x 内側で決定的。`id` はセル由来で安定
  (`"tree/<ix>_<iz>"` / `"shrub/<ix>_<iz>"` / `"grass/<ix>_<iz>"`)
- **乱数**: セルごとの独立サブストリーム `"vegetation/<ix>_<iz>"` のみを
  消費する(セル内の消費数は採否に応じて可変でよい。セル独立のため
  他所へ波及しない)。間引き(下記)は乱数を追加消費しない
- **散布マスクの優先順位**(implementation-spec 7章。1 > 2 > 4 > 5 は
  先に該当したカテゴリが基準確率を決め、3「水辺」はカテゴリではなく
  森リング外の帯に働く**加算層**とする — 岸辺は外縁草地・内地と重なる
  ことが多く、排他カテゴリにすると Water 駆動の岸辺植生が読めないため):
  1. **森リング**(密): `boundarySdf < derived.marginWidth`。
     木の基準採択率 0.62。内縁は幅 6 の smoothstep で草地へ減衰。
     World Scale が marginWidth を介してリング厚を駆動する
  2. **外縁草地**(まばら): `boundarySdf < marginWidth × 2.2`。
     木 0.10 / 低木 0.07 / 草むら 0.06
  3. **水辺低木・湿地植生**(加算層): 湖・池の `waterSdf < 7`
     (森リング外)。低木 += (0.6 + 0.35 × 湿地チャネル) ×
     `derived.shoreVegetation` × 岸近接(0.35〜1.0)、
     木 += 0.10 × shoreVegetation、草むら += 0.06 × shoreVegetation。
     Water が岸辺植生を駆動する
  4. **道・広場周辺の控えめな緑**: 道路・広場の縁から 6 以内。
     低木 0.05 / 木 0.025 / 草むら 0.04
  5. **内地(それ以外)**: 微量(木 0.018 / 低木 0.02 / 草むら 0.03)
- **抑制**(カテゴリ確率に乗じる):
  結界内(`wards.ringPath` の内側)は × 0.12(僅少。外へ向かって
  植生が増える勾配を作る)。最終密度場 `density.final` による市街地の
  抑制 × (1 − 0.8 × final)
- **衝突除外(ハード。保証)**: trees / shrubs / grassPatches の候補点は
  境界(内側 2.2 未満)、水面(湖・池の waterSdf < 1.2)、水路
  (中心線距離 − 幅/2 < 1.2)、道路(edge.path への距離 <
  edge.width/2 + 1.4)、広場(縁 + 1.0)、建物 footprint(縁 + 1.0)、
  `centerPlan.footprint`(+ 1.5)、結界環(ringPath への距離 < 2.2)、
  聖域(3.5 未満)・魔導塔(4.0 未満)と衝突しない。
  grassPatch は多角形半径ぶんクリアランスへ上乗せして判定する
- **上限(性能配慮)**: 木 2000 / 低木 1200 / 草むら 320。超過時は
  候補ごとに引いた間引きキー(採択後に 1 値消費)の昇順・同点は id 順で
  保持する決定論的な間引き(保持後も配列は走査順のまま)
- **個体差**: trees の `form` は森リングで conifer 選好(0.6)・他は
  broadleaf 選好(conifer 0.35)。`scale` 0.8〜1.25(森リングは × 1.15)、
  `rotation` 0〜2π、`colorVar` 0〜1(樹冠色の補間係数)。
  shrubs の `scale` 0.7〜1.3。grassPatches の `polygon` は候補点まわり
  半径 1.6〜3.0 の不整形 6 角形(時計回り)
- パイプライン内アサーション: 衝突ゼロ・上限維持を検証し、違反は
  throw せず件数を console に出す

**植生の立体化(メッシュビルダー `src/mesh/vegetation.ts`)**:
Part 語彙は使わず、植生専用の InstancedMesh 2 + マージ 1 で描く
(draw call +3。art-direction 5.3節・6節):

- `vegetation-trunks`: 幹の 6 角円錐台の InstancedMesh
  (castShadow: false。幹は樹冠の影の中)。色 `#55452f` × ±8% 個体ムラ
- `vegetation-canopy`: 不整形な塊(頂部・赤道をずらした多面体)の
  InstancedMesh。**樹冠(木ごとに 2〜3 個)と低木(1 個)を同じ
  プールへ合流**させる。主要 InstancedMesh として castShadow: true。
  樹形: broadleaf = 主塊+側塊 1〜2(頂部横並び・大ぶり)/
  conifer = 縦積み 3 塊の先細り。塊の個数・オフセットは tree フィールド+
  位置ハッシュ由来(乱数ストリーム非消費)。
  instanceColor = 樹冠 `#5f7a4a`〜`#45603c` の colorVar 補間
  (低木は `#6b7f52`)× ±8% ムラ。**塊ジオメトリの頂点カラーで下面を
  一段暗く焼き込む**(下端 0.66 → 上端 1.0。art-direction 3節の
  頂点カラーAO。instanceColor と頂点カラーは乗算で合成される)
- `vegetation-grass`: 草むらの低いドーム(polygon の扇形分割。
  縁 y=0.03 / 中心 y=0.16)のマージ 1 メッシュ。色は低木と同域
  `#6b7f52` × 明度ムラ(castShadow: false)

### Summary(PHASE 7 commit 21 で確定。中間PHASEでは部分的に埋まる)

WorldModel から機械的に算出し、生成物と乖離させない。
表示する情報種別は `design.md`「UI とサマリー」を正とする。

```ts
interface Summary {
  buildingCounts: Record<string, number>;  // 役割別内訳(下記)
  centerDescription: string;               // 軸スコアから生成する短い記述文(下記)
  waterOverview: { lakes: number; ponds: number; canals: number; bridges: number };
  wardOverview: { level: number; ringLength: number; towers: number;
                  gates: number; shrines: number; floaters: number };
  scale: { worldSize: number; roadLength: number };
  hash: string;                            // 正規化ハッシュ(pipeline.md)
}
```

`summary` は段15「サマリー」(`pipeline/summary.ts`)が全フィールドを
**最終確定**する(中間PHASEの各段は同名フィールドを部分的に先埋めしてよいが、
段15 が最終状態の WorldModel から機械的に再算出して上書きするため、
中間の先埋めと最終値の乖離は起こらない)。段15 は乱数サブストリームを
消費しない(モデル状態からの決定的な集計)。表示名は段15「箱庭を書き留めています…」。

各フィールドの算出規則:

- `buildingCounts`: `buildings` の `role` 別集計(`Record<role, count>`)。
  キーは出現した役割のみ(0 件の役割はキーを持たない)。中心建築
  (role "center")も 1 件として数える。値の合計 = `buildings.length`
- `centerDescription`: `centerPlan.axes` の支配軸(最大軸。同点は
  arcane > authority > waterside > rustic の固定順)と生成物の特徴から
  組み立てる短い日本語記述文。決定論的(乱数不使用、規則のみ)。構成:
  - **主文**(支配軸 → 都市の性格。水路 `water.canals` が非空なら
    「水路の交わる」を接頭する): arcane→「魔法都市」、authority→
    「城塞都市」、waterside→「水辺の街」、rustic→「素朴な集落」。
    例「水路の交わる魔法都市。」
  - **特徴節**(あるものだけを「、」で連ね、無ければ省略。日本語の
    数量詞は 1〜9 を漢数字+助数詞、10 以上は算用数字+助数詞。
    ただし助数詞「つ」は 10 以上に付かないため省き「10の結界門」の形にする):
    魔導塔(`wards.towers`。「三基の魔導塔」)、結界環
    (`wards.wardLevel ≥ 1` かつ `ringPath` 非空 →「結界環」。level 3 は
    「完全な結界環」)、結界門(`wards.gates`。「二つの結界門」)、
    橋(`water.bridges`。「橋」)、浮遊要素(`wards.floaters` 非空 →
    「浮遊する魔法」)。特徴が 1 つも無い(結界 0・塔 0・水路 0・橋 0)
    ときは「静かなたたずまい」を置く。末尾は「〜を持つ。」で結ぶ。
    例「三基の魔導塔と結界環を持つ。」
  - 全体例:「水路の交わる魔法都市。三基の魔導塔と結界環を持つ。」
- `waterOverview` / `wardOverview` / `scale`: 最終状態の WorldModel から
  再算出する(lakes/ponds/canals は各配列長、bridges は
  `water.bridges.length`、ward 系は `wards` の各配列長と `ringPath` 周長、
  worldSize は `ground.size`、roadLength は `network.edges` の
  `path` 長の総和 = 小道込みの最終総延長)

**複雑度(頂点数・インスタンス数・draw call)は WorldModel に持たない
(設計判断)**: これらはレンダラーの実測値(`renderer.info`)であり、
描画プリセット・LOD(PHASE 7 commit 22)で変わる**表示依存の量**である。
WorldModel に入れると正規化ハッシュがレンダラー依存になり決定性が壊れる。
よって `Summary` からは除外し、UI が**表示時に** `renderer.info`
(draw call・triangle・InstancedMesh 由来のインスタンス数)から埋める
(design.md「描画負荷または複雑度の目安」の表示要件は UI が満たす)。
これは PHASE 7 commit 22 でデバッグ表示の「複雑度の目安」へ統合される
のと同じ量であり、サマリー表示側と重複した WorldModel フィールドは持たない。

`hash` は `pipeline.md` の正規化ハッシュ。`runPipeline` が全段完了後
(= 段15 の後)に格納する(PHASE 2 で導入し、以降の全PHASEで常時有効)。
`hash` 自身はハッシュ計算から除外するため、格納後もハッシュ値は変わらない。
