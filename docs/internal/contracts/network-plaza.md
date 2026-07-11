# WorldModel スキーマ契約 — 道路網と広場(Density・Network・Plaza・CenterPlan)

WorldModel スキーマ契約の一部(2026-07-07 に worldmodel.md から分割)。
本書は Density(FieldGrid)・Network(小道を含む)・Plaza・CenterPlan の正である。
スキーマの変更はコードより先に本書を更新する。
索引と節→ファイルの対応表は [README.md](README.md) を参照。
関連: CenterPlan の立体化(中心建築)は [buildings.md](buildings.md)、
水路との橋・水域回避は [ground-water.md](ground-water.md) を参照。

### Density(PHASE 3 で primary、PHASE 4a で final)

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
  worldSize` を半減距離とする)+道路近接ブースト(main > connector)
  +外縁フェード(境界外は 0)。結界には依存しない。水域では 0 に
  **しない**(等値線が水域で歪まないようにする。水域回避は結界計画・
  区画の担当)
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

### Network(PHASE 3、小道の追加は段13「小道」= PHASE 4b)

```ts
type RoadClass = "main" | "connector" | "lane"; // 主道/接続路/小道
interface Network {
  nodes: { id: string; position: Vec2 }[];
  edges: { id: string; from: string; to: string;
           class: RoadClass; width: number;
           path: Vec2[];         // 経路の折れ線(A*の結果を間引き・平滑化)
           grade: number }[];    // 等級。0〜2 連続(0=土、1=砂利、2=石畳)
  entryPoints: { id: string; position: Vec2 }[]; // 外縁の進入点(2〜4)
}
```

道路網の性質(段4「立地評価」・段5「道路網」が保証し、後段・メッシュビルダーが
前提としてよい):

- `entryPoints` は段4が外縁(`ground.boundary` 上)に
  `derived.entryPointCount` 点(2〜4)置く。id は `"entry/<n>"`(生成順で安定)。
  位置は水域(湖・池)を避けて配置する(waterSdf ≥ 0)。道路(段5)は
  湖・池を渡らないため(下記「道路は湖・池を渡らない」)、対岸へ振り分けて
  橋の必然性を作る規則は持たない(Phase A で撤廃。
  `plans/2026-07-11-worldgen-rework-water.md` 3.2節(5))
- **道路(段5)は湖・池を渡らない**: 経路探索のコストは水域(waterSdf < 0)
  を一律高コストとし、事実上の通行禁止にする(3.2節(5)の設計判断。
  水域は閉領域であり境界内で迂回できるため)。したがって段5 自体は
  BridgeSite を抽出しない(bridges の性質は
  [ground-water.md](ground-water.md)「bridges の性質」を参照。橋は
  段6「水路」と段8「結界計画」由来のみになる)
- `nodes` は道路グラフの交差点・端点。id は経路探索グリッドのセル座標由来
  `"node/<ix>_<iz>"` で安定。進入点セルのノードは進入点と同一座標を、
  中心セルのノードは `centerPlan.position` と同一座標を持つ
- `edges` の `path` は A* のグリッド経路を間引き(Douglas–Peucker)・
  平滑化(Chaikin 1回)した点列。両端点は from / to ノードの position に
  一致する(座標値も同一)
- `class` は段5では `"main"`(進入点→中心の主道)と `"connector"`
  (進入点間の補完路)のみ。`"lane"`(小道)は段13「小道」(PHASE 4b)が
  追加する。小道の追加は nodes / edges への追記のみで行い、
  既存の node / edge の id・内容を一切変更しない
- `width` は種別ごとの実寸(main 3.6 / connector 2.6 / lane 1.6)
- `grade` は道の等級 0〜2 の連続値(0=土、1=砂利、2=石畳)。
  `derived.roadGrade` を基準に main は +0.3 の格上げ(上限 2)、
  lane は −0.5 の格下げ(下限 0。小道は道路より低い等級 =
  石畳の街でも土〜砂利の踏み分け道に読ませる)。
  メッシュビルダーは頂点カラーの補間に使う(描画は PHASE 3 commit 11)
- 到達性: すべての進入点ノードは中心ノードへ `edges` のグラフ上で到達できる
  (段5のパイプライン内アサーションで検証し、違反件数を console に出す)

小道の性質(段13「小道」= PHASE 4b commit 15 が保証し、後段・
メッシュビルダーが前提としてよい):

- 生成タイミングの設計判断: 段13 は段12「建物」の後に走る専用段とする。
  建物裏手の小道は区画の列と建物 footprint(水上張り出し込み)を、
  岸沿い道は建物・広場の最終配置を衝突判定に使うため、段5(道路網)への
  同居や段10 以前への挿入はしない。既存の段5〜12 の出力は一切変更しない
- 2 種類の小道を生成する(いずれも `class: "lane"`):
  - **裏手の小道**: 道路 edge(main / connector)の片側に区画が 2 つ以上
    並ぶ「列」ごとの候補。経路は接道 edge に沿い、区画の奥(裏手)を
    通る帯(区画ごとの奥行き+後方あき 1.0+小道半幅)を弧長方向に
    補間・平滑化した折れ線。採択は laneAmount 駆動の確率
    (clamp(1.15 × laneAmount, 0, 0.95)。Settlement に単調)
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

### Plaza(PHASE 3)

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
  重み付き平均(main 1.0 / connector 0.5)を初期値とし、中心前広場が
  水域・footprint 回避で回転した場合は採択した広場の方位(中心→広場中心)
  へ一致させる。道路が中心に接続しない縮退時は最寄りの進入点方向
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

