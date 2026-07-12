# WorldModel スキーマ契約 — 道路網と広場(Density・Network・Plaza・CenterPlan)

WorldModel スキーマ契約の一部(2026-07-07 に worldmodel.md から分割)。
本書は Density(FieldGrid)・Network(小道を含む)・Plaza・CenterPlan の正である。
スキーマの変更はコードより先に本書を更新する。
索引と節→ファイルの対応表は [README.md](README.md) を参照。
関連: CenterPlan の立体化(中心建築)は [buildings.md](buildings.md)、
水路との橋・水域回避は [ground-water.md](ground-water.md) を参照。

### Density(PHASE 3 で primary、PHASE 4a で final。zoning は Phase B)

> **Phase B 註記**(`plans/2026-07-12-worldgen-rework-roads.md`): 本節の
> 道路近接ブースト表への street 行の追加、および「zoning(市街度)」項は
> Phase B の決定であり、実装はタスク B3(street ブースト)・B5(zoning)で
> 追いつく。それまでコードは旧仕様(street ブーストなし、
> `model.zoning` なし)のまま動作する。

```ts
interface Density {
  primary: FieldGrid | null;     // 中心距離+道路近接+Settlement。結界に依存しない
  final: FieldGrid | null;       // primary+結界内ブースト。区画選別に使う(PHASE 4a)
}
interface FieldGrid {
  resolution: number;   // 一辺セル数
  cellSize: number;     // セル一辺の実寸。グリッド全体は原点中心の正方
                        // [-resolution×cellSize/2, +resolution×cellSize/2]²
  values: number[];     // 長さ resolution²。セルは行優先(z 外側 → x 内側)。0〜1
}
```

- `FieldGrid` は zoneMask と同様のフラットなグリッド(プレーンで JSON
  シリアライズ可能)。サンプリングの正は `src/model/fieldgrid.ts` の
  `sampleFieldGrid`(セル中心基準のバイリニア補間。範囲外は端のセルへ
  クランプ)。結界計画の等値線抽出(`marchPositiveRegion` へサンプラーを
  渡す)と後段の区画選別が同じサンプラーを使う
- `primary` は段7「一次密度場」が埋める(それまでは null)。構成は
  中心からの距離の指数減衰(`densityPeak` を最大値、`densityFalloff ×
  worldSize` を半減距離とする)+道路近接ブースト(main > connector >
  street。下記の表)+外縁フェード(境界外は 0)。結界には依存しない。
  水域では 0 に**しない**(等値線が水域で歪まないようにする。水域回避は
  結界計画・区画の担当)
- 道路近接ブーストの届く距離・強さ(class ごと。数値は
  `src/pipeline/density.ts` の定数が正。street 行は**提案値**。Phase B。
  B7 で調整しうる):

  | class | 届く距離 | 強さ |
  |---|---|---|
  | main | 18 | 0.32 |
  | connector | 12 | 0.2 |
  | street | 10 | 0.16 |

  (`"lane"` は近接ブーストの対象外のまま — lane は段13 追加のため
  段7 の時点では存在しない)
- `primary` の解像度は 64 固定、`cellSize = ground.size × 1.1 / 64`
  (waterfield と同じ張り)
- `final` は段11「区画」が埋める(それまでは null)。解像度・セル寸・張りは
  `primary` と同一。値は `final = clamp(primary + 結界内ブースト, 0, 1)`。
  結界内ブーストは `wards.ringPath` が非空のとき、ringPath の閉多角形の
  内側で最大 +0.15 とし、環の縁は幅 8(実寸)の smoothstep で 0 へ滑らかに
  減衰させる(環の外は一次と同値。外縁への減衰は primary の外縁フェードを
  そのまま引き継ぐ)。ringPath が空(wardLevel 0)のとき final は primary と
  同値のコピー(別インスタンス)。乱数サブストリームは消費しない
  (モデル状態からの決定論的な場)。区画・建物の選別は final を使う

#### zoning(市街度。段7。Phase B)

`model.zoning: FieldGrid`(WorldModel 直下のフィールド。スキーマは
worldmodel-core.md「WorldModel」が正)は、市街/農村の 2 ゾーンを表す
0〜1 の**市街度(urbanity)**を持つ 64² の FieldGrid。段7「一次密度場」が
`density.primary` と同じタイミングで算出し書き込む(それまでは null)。
解像度・セル寸・張りは `density.primary` と同一(64 固定、
`cellSize = ground.size × 1.1 / 64`)。

- 算出式(**提案値**。B7 で調整しうる。調整時は本節を同一 commit 更新):
  `urbanity = smoothstep(0.10, 0.45, protoDensity + 0.5 × roadBoost)`。
  `protoDensity` は後述「Network」節「二次街路(street)の有機成長」の
  proto-density(中心の指数減衰 × 外縁フェード。道路近接ブーストを
  含まない生値)、
  `roadBoost` は道路近接ブースト(上記の表。main/connector/street 合成)。
  `density.primary = protoDensity + roadBoost`(外縁フェード等を含めた
  実際の合成は density.ts の実装が正)なので、urbanity は実質
  「density.primary を smoothstep 正規化したもの」に等しい
- **閾値 0.45 以上が市街ゾーン**、未満が農村ゾーンとする(提案値)
- **street 成長閾値(0.22。proto-density の生値)との対応関係**: 段5
  (street の成長判定)は段7 より前に走るため roadBoost を持たず、
  urbanity ではなく protoDensity の生値のみで市街限定を判定する。
  したがって「段5 は roadBoost を持たないため `protoDensity ≥ 0.22` を
  市街近似として扱う」。0.22(protoDensity)と 0.45(urbanity)は
  スケールが異なる 2 つの数値だが、**同一の意図(市街限定)の 2 つの表現**
  であり、両者は B7 の検収で同時に調整する(どちらか一方だけを動かして
  乖離させない)
- 消費者: Phase D(施設。畑・牧草地の配置は農村ゾーンに置く)。Phase B
  内では street の成長判定(市街限定)と B7 検収の可視化にのみ使う。
  vegetation(段14)の農村ゾーンでの内地散布量調整は B6 の裁量に含めてよい
  (任意)

### Network(PHASE 3、street の追加は段5 後半サブフェーズ= Phase B、lane の追加は段13「小道」= PHASE 4b)

> **Phase B 註記**(`plans/2026-07-12-worldgen-rework-roads.md`): 本節の
> street(二次街路)・street の有機成長規則・進入点数の新式(2〜5)・
> street 近接ブースト・zoning との対応は Phase B の決定であり、実装は
> タスク B2(進入点数)・B3(street 本体)・B5(zoning 一本化)で追いつく。
> それまでコードは旧仕様(RoadClass に street なし、entryPointCount
> 上限 4)のまま動作する。

```ts
type RoadClass = "main" | "connector" | "street" | "lane"; // 主道/接続路/二次街路/小道
interface Network {
  nodes: { id: string; position: Vec2 }[];
  edges: { id: string; from: string; to: string;
           class: RoadClass; width: number;
           path: Vec2[];         // 経路の折れ線(A*の結果を間引き・平滑化)
           grade: number }[];    // 等級。0〜2 連続(0=土、1=砂利、2=石畳)
  entryPoints: { id: string; position: Vec2 }[]; // 外縁の進入点(2〜5。Phase B)
}
```

道路網の性質(段4「立地評価」・段5「道路網」が保証し、後段・メッシュビルダーが
前提としてよい):

- `entryPoints` は段4が外縁(`ground.boundary` 上)に
  `derived.entryPointCount` 点(2〜5。新式は worldmodel-core.md「Derived」が
  正。Phase B で 2〜4 から拡張)置く。id は `"entry/<n>"`(生成順で安定)。
  位置は水域(湖・池)を避けて配置する(waterSdf ≥ 0)。道路(段5)は
  湖・池を渡らないため(下記「道路は湖・池を渡らない」)、対岸へ振り分けて
  橋の必然性を作る規則は持たない(Phase A で撤廃。
  `plans/2026-07-11-worldgen-rework-water.md` 3.2節(5))
- **道路(段5)は湖・池を渡らない**: 経路探索のコストは水域(waterSdf < 0)
  を一律高コストとし、事実上の通行禁止にする(3.2節(5)の設計判断。
  水域は閉領域であり境界内で迂回できるため)。したがって段5 自体は
  BridgeSite を抽出しない(bridges の性質は
  [ground-water.md](ground-water.md)「bridges の性質」を参照。橋は
  段6「水路」と段8「結界計画」由来のみになる)。ただし経路探索グリッドの
  量子化と平滑化(Douglas–Peucker・Chaikin)により、経路点が岸際の浅い
  水面を `waterSdf ≥ -1.5` の範囲でかすめることがある。これは横断とは
  見なさず許容する(横断とは、この閾値を超えて水域へ侵入すること)。
  段5 のパイプライン内アサーションと `test/network.test.ts` の検証は
  いずれもこの `-1.5` を閾値として用いる(A* コストは水域一律高コストの
  ため、この程度の浅いかすりまでは完全には防げない。A6 目視検収で確認
  済み)
- `nodes` は道路グラフの交差点・端点。id は経路探索グリッドのセル座標由来
  `"node/<ix>_<iz>"` で安定。進入点セルのノードは進入点と同一座標を、
  中心セルのノードは `centerPlan.position` と同一座標を持つ
- `edges` の `path` は A* のグリッド経路を間引き(Douglas–Peucker)・
  平滑化(Chaikin 1回)した点列。両端点は from / to ノードの position に
  一致する(座標値も同一)
- `class` は段5では `"main"`(進入点→中心の主道)・`"connector"`
  (進入点間の補完路)・`"street"`(二次街路。段5 後半サブフェーズが
  幹線から発芽・成長させる。Phase B。下記「二次街路(street)の有機成長」)
  の3種。`"lane"`(小道)は段13「小道」(PHASE 4b)が追加する。
  小道の追加は nodes / edges への追記のみで行い、既存の node / edge の
  id・内容を一切変更しない
- `width` は種別ごとの実寸(main 3.6 / connector 2.6 / street 2.2
  (提案値。Phase B) / lane 1.6)
- `grade` は道の等級 0〜2 の連続値(0=土、1=砂利、2=石畳)。
  `derived.roadGrade` を基準に main は +0.3 の格上げ(上限 2)、
  street は `max(0, roadGrade − 0.2)`(提案値。Phase B。main/connector より
  一段低い格とする)、lane は −0.5 の格下げ(下限 0。小道は道路より
  低い等級 = 石畳の街でも土〜砂利の踏み分け道に読ませる)。
  メッシュビルダーは頂点カラーの補間に使う(描画は PHASE 3 commit 11)
- 到達性: すべての進入点ノードは中心ノードへ `edges` のグラフ上で到達できる
  (段5のパイプライン内アサーションで検証し、違反件数を console に出す)

#### 二次街路(street)の有機成長(段5 後半サブフェーズ。Phase B)

新モジュール `src/pipeline/streets.ts`(`runNetwork` から呼ぶ。段の総数・
段番号は変えない)が、幹線(main / connector)から発芽して局所規則で
伸びる街路(class `"street"`)を成長させ、`network.nodes` / `network.edges`
へ追記する。数値はすべて**提案値**(B7 検収で調整しうる。調整時は本節と
`plans/2026-07-12-worldgen-rework-roads.md` を同一 commit で更新する)。

- **発芽点**: 幹線(main / connector)edge の弧長に沿った等間隔点
  (間隔 24)+ 中心前広場予定方向の 1 点。乱数は各発芽点ごとに
  `makeRng(seed, "streets/sprout/<edgeId>/<k>")` の独立サブストリームを
  使い、発芽点ごとに固定数を引き切る(成長が早期に打ち切られて未使用に
  なっても、消費数・消費順は入力に依らず固定する。RNG API 節の規約に従う)
- **成長**: 決定論的な優先度キュー(優先度 = 成長優先度場の値、同値は
  発芽点 id 昇順でタイブレーク)で先端を伸ばす。1 セグメントの長さは
  12〜20、方向は親方向 ± 25° の範囲で揺らぐ。分岐確率は成長優先度場の
  値に比例する
- **成長優先度場 = proto-density**: `density.primary`(段7)は段5より後に
  埋まるため使えない。proto-density は `density.primary` と同じ式から
  道路近接ブーストを除いた「中心の指数減衰 × 外縁フェード」で、
  `src/pipeline/density.ts` と `src/pipeline/streets.ts` が同じ純関数を
  共有する(乱数非消費。streets は評価のみで消費しない)。
  proto-density が**閾値 0.22 未満**のセルへは街路を伸ばさない(市街限定。
  Density 節「zoning」の urbanity 閾値 0.45 との対応関係も同節で定義する)
- **停止・接続規則(ループ形成)**: 先端が既存道路(幹線・確定済み
  street)の 6 以内に達したらスナップ接続し、交差点ノードを作る
  (袋小路ではなくループを作るのが主経路)。以下に当たる成長は停止する:
  水域(waterSdf < 幅/2 + 1)、境界マージン、`centerPlan.footprint`
  +予約領域、下記形状健全性 4 項への抵触
- **予算**: `derived.streetBudget = worldSize × (0.35 + 2.35×settle) ×
  (0.55 + 0.9×scale)`(worldmodel-core.md「Derived」が正。Phase B(B6)で
  Settlement=0 の基礎係数を 0.5→0.35 へ引き下げ、寒村の街路過多を是正
  した提案値。B7 検収で再調整しうる)。成長した street の総弧長がこの
  予算を超えたら成長を終了する
- **形状健全性(4 項。A7 の教訓により最初から契約化する)**:
  1. 交差角の下限: 新しい交差(スナップ接続を含む)の最小交差角 ≥ 30°。
  2. 並走間隔の下限: 既存道路(全 class)と 10 未満の距離で 16 以上
     並走するセグメントは生成しない(先端がその状態になったら停止または
     接続へ切り替える)。
  3. 袋小路率の上限: street の端点のうち他道路に接続しない端点の割合
     ≤ 0.35。超過時は末端(短い袋小路)から決定論的に間引く。
  4. 自己交差の禁止: セグメント追加時に既存 street セグメントと交差する
     場合はスナップ接続(ノード化)として扱い、ノード無しの立体交差は
     作らない。

  この 4 項の閾値は、段5のパイプライン内アサーション・
  `test/network.test.ts`・B7 検収メトリクスの三者が同じ値を共有する
  (A6 で発生した「アサーションとテストの閾値不整合」の再発防止)
- **id 規約**: 発芽点 id は `sproutId = "<edgeId>#<k>"`(k は edge の
  始点からの弧長順の連番、0 起点。中心前広場予定方向の発芽点は
  `k` の続き番号を使う)。発芽点から伸びる street edge の id は
  `"street/<sproutId>/<segmentIndex>"`(segmentIndex はその発芽点からの
  成長で採択したセグメント順の連番、0 起点。分岐した枝も同じ発芽点の
  続き番号を共有し、id が衝突する場合は既存の道路 id 慣例(段5の
  `/2` 連番)に倣って添字を振り直す)。新規ノードの id は
  `"node/street/<sproutId>/<segmentIndex>"`。スナップ接続で既存ノードへ
  つなぐ場合は既存ノードの id をそのまま使い、新規 id は発行しない
- **裏手小道の対象外**: street の裏には lane/back を張らない(下記
  「小道の性質」に明記)
- **収束方向への不参加**: `roadConvergenceAngle`(CenterPlan 節)の重みは
  street 0(収束方向の計算に含めない)

小道の性質(段13「小道」= PHASE 4b commit 15 が保証し、後段・
メッシュビルダーが前提としてよい):

- 生成タイミングの設計判断: 段13 は段12「建物」の後に走る専用段とする。
  建物裏手の小道は区画の列と建物 footprint(水上張り出し込み)を、
  岸沿い道は建物・広場の最終配置を衝突判定に使うため、段5(道路網)への
  同居や段10 以前への挿入はしない。既存の段5〜12 の出力は一切変更しない
- 2 種類の小道を生成する(いずれも `class: "lane"`):
  - **裏手の小道**: 道路 edge(main / connector に限定。**street は対象外**
    — 提案値。Phase B。street 自身が路地であり、路地の裏へさらに細道を
    張ると過密になるため)の片側に区画が 2 つ以上並ぶ「列」ごとの候補。
    経路は接道 edge に沿い、区画の奥(裏手)を通る帯(区画ごとの奥行き+
    後方あき 1.0+小道半幅)を弧長方向に補間・平滑化した折れ線。採択は
    laneAmount 駆動の確率(clamp(1.15 × laneAmount, 0, 0.95)。
    Settlement に単調)
  - **岸沿い道(towpath)**: 各水路の `towpathSide` 側、護岸縁石の外
    (中心線から 幅/2 + 1.35。縁石 0.12+0.42 と小道半幅 0.8 ぶん)を
    水路に沿って通る。採択は laneAmount 駆動の確率
    (clamp(0.3 + 0.9 × laneAmount, 0, 0.98))
- 衝突制約: 小道の経路点は 境界(内側 2 以上)、湖・池
  (waterSdf ≥ 幅/2 + 0.4)、水路(中心線距離 − 幅/2 ≥ 幅/2 + 0.3)、
  建物 footprint(クリアランス 幅/2 + 0.3)、広場(同 幅/2 + 0.5)、
  centerPlan.footprint(+1)、結界環(ringPath への距離 ≥ 2.0)、
  既採択の小道(中心線間隔 ≥ 幅 + 0.6)と衝突しない。
  衝突区間はトリムし、残った連続区間(最小長 towpath 10 / 裏手 12)を
  それぞれ独立の lane edge として採択する
- **小道は水域(湖・池・水路)を渡らない**(上記の衝突制約で回避・分断
  する設計判断)。よって小道の追加は `water.bridges` を変えず、段8 の
  再抽出契約(Water 節)はそのまま保たれる。小道が結界環を横切らないため
  結界門の追加も不要(gates は段8 確定のまま)
- 小道はグラフの接続を要求しない(裏手の袋小路を許容する。到達性
  アサーションの対象は進入点↔中心のみで、lane は対象外)
- id は由来から安定: 裏手 `"lane/back/<roadEdgeId>/<L|R>/<run>"`、
  岸沿い `"lane/towpath/<canalId>/<run>"`(run はトリム後の連続区間の
  連番)。ノードは各 lane edge の両端に追加し、id は
  `"node/<laneEdgeId>/a"` / `"node/<laneEdgeId>/b"`
- 乱数は要素ごとの独立サブストリーム `"lanes/back/<roadEdgeId>/<L|R>"` /
  `"lanes/towpath/<canalId>"` のみ消費する(候補ごとに消費数固定。
  トリム・区間分割は決定論的で乱数を消費しない)
- 段13 は lane の被覆で zoneMask の舗装チャネルを追記し(ZoneMask 節)、
  `summary.scale.roadLength` へ小道の総延長を加算する

### Plaza(PHASE 3、全広場の道路接続保証と中心前広場の接続路は Phase B)

> **Phase B 註記**(`plans/2026-07-12-worldgen-rework-roads.md`): 本節の
> 「全広場の道路接続保証」「中心前広場の接続路」「roadConvergenceAngle の
> street 重み 0」は Phase B の決定であり、実装はタスク B4 で追いつく。
> それまでコードは旧仕様(中心前広場に接続路の保証が無い)のまま動作する。

```ts
interface Plaza {
  id: string;
  kind: "center" | "gate" | "bridgehead" | "crossing" | "courtyard";
  position: Vec2; radius: number;
  polygon: Polygon;              // 舗装領域
}
```

広場の性質(段9「広場」が保証し、後段・メッシュビルダーが前提としてよい):

- `"center"` は中心前に最大 1 個(半径 = `derived.centerPlazaRadius`)。
  位置は centerPlan.footprint の縁から主道の収束方向へ置き、水域・
  footprint と衝突する場合は方位回転と半径縮小の決定論的な候補探索で
  回避する。`"gate"` は各結界門の内側(中心側)、`"bridgehead"` は橋の袂
  (中心に近い側を優先。採択は watersideRate 駆動の確率)、`"crossing"` は
  主道どうしの交差ノード(確率的)。`"courtyard"` は段12「建物」の
  中心建築展開(PHASE 5a)が中庭壁の内側に追加する
  (Parcel / Building 節「中心建築」)
- `polygon` は `position` 中心の不整形 n 角形(時計回り。radius 基準で
  0.88〜1.0 倍の揺らぎ。頂点は radius の円内)
- 衝突回避: 採択順(center → gate → bridgehead → crossing)で、既採択
  広場との円距離(半径和+マージン)、水域(水路を含む)、
  `centerPlan.footprint`、`ground.boundary` との衝突を検査し、回避
  できない候補は縮小し、それでも収まらなければ棄却する
- `id` は由来から安定(`"plaza/center"`、`"plaza/gate/<gateId>"`、
  `"plaza/bridgehead/<bridgeId>"`、`"plaza/crossing/<nodeId>"`)
- **全広場の道路接続保証(Phase B。courtyard を除く)**: `"courtyard"` を
  除く全ての広場は、少なくとも 1 本の道路 edge が広場 `polygon` の
  周長に接するか、内部を通る。`"gate"`(結界門の内側 = 道路との交点
  近傍)・`"bridgehead"`(橋の袂 = 道路の終端)・`"crossing"`(主道どうしの
  交差ノード上)は原則として構成上これを満たすが、配置後に接触検証を行い、
  外れた場合はアンカー(`"gate"` は門位置、`"bridgehead"` は橋詰めの
  道路端、`"crossing"` は交差ノード)へ向けて広場中心を決定論的に
  段階的に寄せて再検証する(半径比の刻みで最大数回。乱数は消費しない。
  `siteOk` の衝突回避は保つ)。寄せても接しない場合はその広場を棄却する
  (B7 検収で発見した pre-existing コーナーケース: 橋詰め広場が採択位置の
  ままでは道路周長に接しないことがある。`src/pipeline/plazas.ts`
  `resolveTouchingSite`)。段9のパイプライン内アサーションと
  `test/plazas.test.ts` がこの保証を検証する
- **中心前広場の接続路(Phase B)**: `"center"` 広場だけは上記の保証が
  構成上は無い(主道のターゲットは `centerPlan.position` のセルであり
  広場ではないため)。段9は中心前広場を確定した後、最寄りの道路ノードから
  広場縁への短い接続路を `network` へ**追記のみ**で加える(class
  `"street"`、id `"street/plaza/<plazaId>"`。既存の node / edge の id・
  内容は変更しない)。接続路が広場へ流入する方位は `centerPlan.facing`
  と一致させる(中心建築の大扉 → 前庭 → 広場 → 接続路が一直線に読める
  幾何。CenterPlan 節「段9が保証する性質」)

### CenterPlan(PHASE 3 で2段階確定、立体化は PHASE 5a)

```ts
interface CenterPlan {
  position: Vec2;
  footprint: Polygon;            // 占有範囲(区画・道路・広場・結界の予約領域)
  axes: { arcane: number; authority: number;
          waterside: number; rustic: number }; // 4軸スコア(1.7節)
  facing: number;                // 正面方向(広場・主道の収束方向。広場確定後に設定)
  heightHint: number;            // 高さ目安(スカイライン検証の基準)
}
```

CenterPlan は2段階で埋まる。段4「立地評価」が `position` / `footprint` /
`axes` を確定し、`facing` / `heightHint` は段9「広場」(PHASE 3 commit 10)が
中心前広場・主道の収束方向の確定後に埋める。それまでは両者とも 0 のままとする。

段9が保証する性質:

- `facing` は xz 平面の偏角(ラジアン)。中心ノードへ到来する道路の方向の
  重み付き平均(`roadConvergenceAngle`。main 1.0 / connector 0.5 /
  **street 0**(Phase B。収束方向の計算に含めない — 街路は幹線ではなく
  中心の正面性を決めない))を初期値とし、中心前広場が水域・footprint
  回避で回転した場合は採択した広場の方位(中心→広場中心)へ一致させる。
  中心前広場の接続路(Plaza 節「中心前広場の接続路」)の流入方位とも
  一致する。道路が中心に接続しない縮退時は最寄りの進入点方向
- `heightHint` は `derived.centerHeight × 支配軸係数`(axes の最大軸。
  arcane 1.15 / authority 1.0 / waterside 0.85 / rustic 0.7)。必ず正

段4が保証する性質:

- `position` はグリッド各点のスコアリングによる1点。
  スコア = 水辺近接×√Water + 中央寄り + 進入点からのアクセス性 −
  水中ペナルティ(implementation-spec PHASE 3。Water項は平方根で飽和させ、
  Water の微小変化で主中心が跳ばない)。seed はタイブレーク
  (格子ハッシュノイズの微小加点)にのみ使う
- `position` は水中になく(waterSdf > 0)、`footprint` の全頂点は
  `ground.boundary` の内側に収まる
- `footprint` は `position` 中心・一辺 `derived.centerFootprint` の
  軸平行な正方形(時計回り)。正面方向が未確定の段階の予約領域であり、
  向き付けは行わない
- `axes` は implementation-spec 1.7節の4軸(0〜1目安):
  魔導 = Monumentality × `derived.centerArcaneBias`、
  権威 = Monumentality × Prosperity、
  水辺 = Monumentality × Water × 水辺近接度(中心の岸距離の指数減衰)、
  素朴 = (1−Monumentality) × (1−Settlement)。
  seed 揺らぎは同点付近のタイブレーク用の微小量(±0.02)のみ

