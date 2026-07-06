# WorldModel スキーマ契約

WorldModel は生成パイプラインの出力であり、メッシュビルダー・サマリーの唯一の入力である。
本書がスキーマの正であり、`src/model/` の TypeScript 型定義は本書と同期させる。
スキーマの変更はコードより先に本書を更新する。

概要と設計意図は `../specs/implementation-spec.md` 1.5節、
各フィールドを埋める手順は同 1.3節と `pipeline.md` を参照。

## 全体規約

- WorldModel はプレーンなデータ構造(JSONシリアライズ可能)とする。
  関数、クラスインスタンス、Three.jsオブジェクト、`Map`/`Set` を含めない。
- 時間・表示状態を持ち込まない。浮遊要素の上下動、発光の明滅などの
  表示演出はビューワー側の時間関数で行い、WorldModel には基準値のみを持つ。
- すべての配列は決定論的な順序を持つ(生成手順が順序を定義する)。
  環境依存の順序(`Object.keys` 等)に由来する順序を露出させない。
- 各要素の `id` は生成内容から安定に導出し(座標や親IDのハッシュ等)、
  乱数サブストリームのラベル(`pipeline.md`)として使えるようにする。
- 座標系: y-up。地面は y=0 の平面。水面は y=-0.6、岸スカート下端は
  水面より 1.0 低い y=-1.6(implementation-spec 1.8節。実装定数は
  `src/model/worldmodel.ts` の `WATER_SURFACE_Y` / `SHORE_SKIRT_BOTTOM_Y`)。
  平面計画の座標は xz 平面上の `{x, z}` で表す。
- 未確定と記した詳細は担当PHASEの実装時に確定し、本書を先に更新する。

## 基本型

```ts
type Vec2 = { x: number; z: number };          // xz平面上の点
type Polygon = Vec2[];                          // 閉多面形。時計回り。自己交差なし
type Spline = { points: Vec2[]; width: number } // 中心線+幅(川・水路・道路リボンの元)
```

## WorldModel

```ts
interface WorldModel {
  meta: Meta;
  ground: Ground;
  water: Water;
  density: Density;
  network: Network;
  plazas: Plaza[];
  centerPlan: CenterPlan;
  wards: Wards;
  parcels: Parcel[];
  buildings: Building[];
  vegetation: Vegetation;
  summary: Summary;
}
```

### Meta(導出設定。PHASE 2〜)

```ts
interface Meta {
  seed: string;                  // ユーザー入力のseed文字列
  params: Params;                // 6パラメータ(0〜100)。名前と既定値は design.md が正
  derived: Derived;              // パラメータ→内部変数(implementation-spec 1.6節)
}
interface Params {
  worldScale: number; settlement: number; prosperity: number;
  water: number; arcana: number; monumentality: number;
}
```

`Derived` は implementation-spec 1.6節の全マッピングを表す。
各フィールドは駆動パラメータに対して単調な写像とし、seed 揺らぎは
`entryPointCount`・`riverCount` の丸め閾値にのみ使う
(`makeRng(seed, "derive")`。消費数・消費順は入力に依らず固定)。
後続PHASEが消費する値も含め、導出は PHASE 2 で完成させる。
draw call 予算等の描画側の規律は導出設定ではなく描画側の定数とする。

```ts
interface Derived {
  // --- World Scale 駆動 ---
  worldSize: number;         // ワールド一辺の実寸。240〜560
  entryPointCount: number;   // 外縁の進入点の数。2〜4(整数。閾値に seed 揺らぎ)
  roadBudget: number;        // 道路網の総延長予算(実寸)。worldSize × 2.2〜4.0
  marginWidth: number;       // 外縁余白(森・草地帯)の厚み。18〜48
  parcelCountMax: number;    // 区画数の上限。60〜260(整数)

  // --- Settlement Pressure 駆動 ---
  densityPeak: number;       // 密度場の中心ピーク値。0.55〜1.0
  densityFalloff: number;    // 密度の半減距離(worldSize 比)。0.20〜0.45(高いほど外縁まで広がる)
  parcelRate: number;        // 区画の採択確率。0.35〜0.9
  parcelSize: number;        // 平均敷地間口。16〜7(高いほど狭小・高密)
  laneAmount: number;        // 小道(建物間の細い道)の生成量。0〜1
  floorsBias: number;        // 建物の平均階数への弱い正の寄与。0〜0.6

  // --- Prosperity 駆動 ---
  wallTier: number;          // 壁材の階層(掘立→木組み漆喰→石造→切石)。0〜3 連続
  roofTier: number;          // 屋根パレットの階層(茅→木羽→瓦→スレート)。0〜3 連続
  roadGrade: number;         // 道の等級(土→砂利→石畳)。0〜2 連続。広場舗装・護岸の整いも共有
  detailAmount: number;      // 窓・扉・梁のディテール量と整列度。0〜1
  tidiness: number;          // 整い(建物の傾き・沈み込みノイズの逆数)。0〜1

  // --- Water Presence 駆動 ---
  riverCount: number;        // 主河川の本数。0〜2(整数。閾値に seed 揺らぎ。Water 0 で必ず 0)
  riverWidth: number;        // 川幅。5〜16(本数 0 でも連続値として保持し、閾値付近の連続変化に使う)
  lakeChance: number;        // 湖の生成確率。0〜1(Water 0 で 0)
  lakeArea: number;          // 湖の目標面積(箱庭面積比)。0.04〜0.18
  waterAreaCap: number;      // 水域合計面積の上限(箱庭面積比)。0.35 固定
  canalScore: number;        // 水路発火スコア = Water×(0.5+0.5×Settlement)。0〜1。0.35 以上で発火
  marshAmount: number;       // 湿地マスクの広さ。0〜1
  sandbarAmount: number;     // 砂洲の広さ。0〜1
  watersideRate: number;     // 水辺建築・橋詰め建築・杭基礎の採択確率。0〜1
  shoreVegetation: number;   // 岸辺植生の密度。0〜1

  // --- Arcana 駆動 ---
  wardLevel: 0 | 1 | 2 | 3;  // 結界段階。閾値 15/45/75(1.6節。seed 揺らぎなし)
  wallClosure: number;       // 結界壁の閉じ率。0〜1 連続(段階を跨いで連続に閉じていく)
  towerScale: number;        // 魔導塔の数・高さのスケール。0〜1
  gateScale: number;         // 結界門の数・規模のスケール。0〜1
  lampDensity: number;       // 魔法灯・発光紋様の密度。0〜1
  floaterAmount: number;     // 浮遊要素の量。0〜1(Arcana 30 以下では 0)
  shrineRate: number;        // 聖域・祠の出現率。0〜0.8
  glowIntensity: number;     // 発光強度のスケール。0〜1(基準値は art-direction 5.4節)
  glowAreaCap: number;       // 発光合計投影面積の上限(箱庭平面比)。0.005 固定(art-direction 5.4節)
  centerArcaneBias: number;  // 中心建築が魔導型に寄るバイアス。0〜1(1.7節の魔導軸に作用)

  // --- Monumentality 駆動 ---
  centerFootprint: number;   // 中心建築 footprint 一辺の目安。14〜44
  centerHeight: number;      // 中心建築の高さ目安。12〜56
  centerPlazaRadius: number; // 中心前広場の半径。10〜32
  upgradeRadius: number;     // 中心周辺の建物格上げ半径。20〜100
  parcelReserve: number;     // 中心周辺の区画予約半径(centerFootprint 比)。1.2〜2.4
  skylineRatio: number;      // スカイライン倍率。1.8〜3.5(PHASE 5a のアサーション基準)
}
```

### Ground(PHASE 2)

```ts
interface Ground {
  size: number;                  // ワールド一辺の実寸(= derived.worldSize)
  boundary: Polygon;             // 有機的な外縁形状
  edgeStyle: "fog" | "water";    // 外周の閉じ方(水系段が確定。選択確率は Water Presence
                                 // 連動で、params.water < 15 は "fog" 固定)
  zoneMask: ZoneMask;            // 材質ゾーン(草地/土/砂洲/湿地)のグリッド
}
```

`boundary` の性質(地面段が保証し、後段・メッシュビルダーが前提としてよい):

- 閉多角形(頂点列は環。先頭点を末尾に重複させない)、自己交差なし、時計回り。
  時計回りの定義: shoelace 符号 `Σ(x_i·z_{i+1} − x_{i+1}·z_i) < 0`
- 原点まわりの星形(全頂点が偏角順に並び、中心からの半径関数として一意)。
  半径は `0.3×size 〜 0.5×size` の範囲に収まる

`ZoneMask` は材質ゾーンのブレンドを持つグリッド。プレーンで JSON シリアライズ可能。

```ts
type ZoneKind = "grass" | "dirt" | "sandbar" | "marsh"; // 草地/土/砂洲/湿地
const ZONE_KINDS: readonly ZoneKind[];                  // チャネル順の正(この並び)
interface ZoneMask {
  resolution: number;   // 一辺セル数
  cellSize: number;     // セル一辺の実寸。グリッド全体は原点中心の正方
                        // [-resolution×cellSize/2, +resolution×cellSize/2]²(≒ ground.size)
  weights: number[];    // 長さ resolution²×4。セルは行優先(z 外側 → x 内側)、
                        // セル内は ZONE_KINDS 順。各セルの重みは非負・合計 1
  brightness: number[]; // 長さ resolution²。明度ムラ係数(1±0.08。art-direction 5.2節)
}
```

- 地面段は「草地ベース+土の斑・むら」の下地を書く。砂洲・湿地チャネルは
  水系段が水域近傍へ書き込む(地面段の時点では 0)。
- 道路・広場・水路・建物 footprint による上書きは PHASE 3 / 4a の担当。
  舗装チャネルの追加が必要になった時点で、コードより先に本書へ追記する。
- サンプリングの正は `src/model/zonemask.ts` の `sampleZoneMask`
  (セル中心基準のバイリニア補間。範囲外は端のセルへクランプ)。
  メッシュビルダーはこれで頂点カラーへ変換する
  (基準色は art-direction 5.2節、ブレンドは重みの線形結合×brightness)。

### Water(PHASE 2、canals と橋の追加は PHASE 3)

```ts
interface Water {
  rivers: Spline[];              // 主河川(0〜2本)。外縁から外縁(または湖)へ
  lakes: Polygon[];              // 湖。川との流入・流出接続を持つ
  canals: Canal[];               // 街中の水路。段6「水路」が計画(それまでは空)
  bridges: BridgeSite[];         // 道路×水域の交差区間。PHASE 3 で抽出
  shoreline: Shoreline;          // 岸線(岸スカート・湿地/砂洲マスクの元)
}
interface Canal extends Spline {
  id: string;                    // "canal/<i>"。生成インデックス由来で安定
                                 // (フォールバックの堀留のみ "canal/fallback")
  towpathSide: 1 | -1;           // 岸沿い道フック(小道は PHASE 4b)。
                                 // 進行方向に対して +1=左岸 / -1=右岸
}
interface BridgeSite {
  id: string;
  position: Vec2; angle: number; // 交差中心と道路方向
  width: number; length: number; // 道路幅と渡り長
  over: "river" | "lake" | "canal";
  roadClass: RoadClass;          // 石造/木橋の選択に使う(PHASE 5b)
}
```

水系の性質(水系段が保証し、後段・メッシュビルダーが前提としてよい):

- `rivers` は 0〜2本。各スプラインの点列は境界の外側の一点から境界を横断して
  外側の別点へ抜ける(両端点は `ground.boundary` の外)。湖がある場合は
  経路が湖を貫通する。隣接点間隔は川幅の 1.5 倍以下(川は途切れない)。
  `width` は `derived.riverWidth` を面積クリップで縮小した最終値
- `lakes` は 0〜1個の閉多角形(基本型 `Polygon` の規約に従い時計回り・
  自己交差なし)。川がある場合、湖は主河川の経路上に置かれ、
  川のスプラインが湖ポリゴンを貫通することで流入・流出接続を持つ
- 水域の合計面積(境界内。`src/model/waterfield.ts` の `estimateWaterArea`
  で測る)は ground 面積 × `derived.waterAreaCap` 以下。超過する入力では
  水系段が湖面積・川幅を縮小してクリップ済みであり、後段はこの上限を
  前提としてよい
- 水が完全に消える入力(riverCount=0 かつ湖なし)では `rivers` / `lakes` /
  `shoreline.loops` は空で、`ground.edgeStyle` は `"fog"`。
  乾いた土地として後段が成立すること
- `canals` は段6「水路」の担当(それまでは空配列。性質は下記)。`bridges` は
  段5「道路網」が抽出する(性質は下記)

水路の性質(段6「水路」が保証し、後段・メッシュビルダーが前提としてよい):

- 発火条件: `derived.canalScore ≥ 0.35` かつ既存水域(rivers / lakes)が
  存在すること。本数は canalScore に単調(1〜3本)。
  デフォルト(全パラメータ 50)では canalScore = 0.375 で発火し、
  必ず 1 本以上を計画する(下記フォールバック込み)
- 各水路は既存水系と接続する: 始端は必ず既存水域(rivers / lakes の
  waterSdf < 0 の点)にあり、終端も原則として既存水域へ戻る。
  例外はフォールバックの堀留(全水路が交差上限で棄却された場合にのみ
  計画する短い水路。始端のみ接続し、終端は街区内で止まる)
- `width` は川より細い(既存河川の最終幅 × 0.35 を基準に 2.2〜5 へ
  クランプし、さらに最小河川幅の 0.8 倍を上限とする)。隣接点間隔は
  幅の 1.5 倍以下(川と同じ連続性)。点列は `ground.boundary` の内側に
  収まり、`centerPlan.footprint`(+マージン)を通らない
- 中心域・密集予定域を通る: 経由点を中心から footprint 半径〜中心前広場
  半径程度の距離に置き、主道どうしの角度間隙へ向ける(道路交差=
  BridgeSite の増加を抑える)
- 水路 1 本が生む BridgeSite は最大 3。超える場合は経路と蛇行を縮めて
  交差が減る方向へ再サンプルし、3 回のリトライで収まらなければその水路を
  棄却する(リトライ回数も乱数ストリーム `"canals/canal/<i>"` から消費して
  決定性を保つ。implementation-spec 9節)。棄却があっても他の水路の
  id(生成インデックス由来)は変わらない
- **水路は waterfield・岸線・zoneMask に影響させない(設計判断)**:
  `model/waterfield.ts` の水域場は rivers / lakes のみから作り、
  `shoreline` の再抽出も行わない。水路は護岸(縁石・石積み)で縁取られた
  「掘り込みチャネル」であり、自然の岸辺(砂洲・湿地・岸スカート)を
  持たないため。地面メッシュも水路でクリップせず、描画(PHASE 3
  commit 11)は地面の上に彫り込む水路メッシュ(水面+護岸)を重ねて
  水際の段差を護岸で見せる(クリップとの整合問題を持たない)。
  後段の水辺判定(`Parcel.canalside` 等)・結界の水域回避・広場の水域衝突は
  canal スプラインへの距離(中心線距離 − 幅/2)を水域として併用する

`bridges` の性質(段5「道路網」が抽出し、段6「水路」が追加、
段8「結界計画」が再抽出する):

- 抽出保証: 水域(waterfield の waterSdf < 0)を渡る道路 edge は、渡る区間
  ごとに必ず対応する BridgeSite を持つ(段5のパイプライン内アサーション。
  違反は throw せず件数を console に出す)。渡り区間は edge.path 沿いの
  waterSdf 標本化で検出し、水際は隣接標本間の線形補間で確定する
- `position` は渡り区間の中点。`angle` は同地点の道路方向(xz 平面の偏角
  `atan2(dz, dx)`。ラジアン)。`width` は道路幅(= edge.width)。
  `length` は渡り長(水際から水際までの経路長)
- `over` は渡る水域の種別(中点に最も近い水域要素で判定)。`roadClass` は
  渡る edge の種別(石造/木橋の選択に使う。PHASE 5b)
- `id` は中点座標由来 `"bridge/<x>_<z>"`(座標は小数1桁へ丸め)で安定。
  同一キーの衝突時は抽出順の連番を後置する
- 段6「水路」は各水路×全道路 edge の交差区間を BridgeSite
  (over: "canal")として同じ id 体系で仮追加する。段8「結界計画」は
  結界門スナップによる道路修正の後、結界の有無に依らず全道路 edge を
  「河川・湖・水路を合成した水域」で標本化し直して bridges 全体を
  置き換える(over は中点で最も深い水域要素、id は再抽出の中点から
  導出し直す)。bridges の最終状態は段8の出力を正とする

`Shoreline` は岸線(境界内の陸地と水域の境界)の実体表現:

```ts
interface Shoreline {
  cellSize: number;        // 岸線抽出グリッドのセル寸(≒ ground.size×1.1 / セル数)
  loops: ShoreLoop[];      // 岸線の点列。水域が無ければ空
}
interface ShoreLoop {
  id: string;              // "shore/<n>"。抽出順で安定
  closed: boolean;         // true=閉環(湖岸・中州)。false=外縁で切れる開いた岸線(川岸)
  points: Vec2[];          // 岸線の点列(水際 y=0 のライン。隣接間隔はセル寸程度)
  normals: Vec2[];         // points と同数。水域から陸側を向く単位法線
}
```

- 岸線は「boundary 内の陸地」と水域の境界の等値線であり、地面メッシュの
  水際エッジ・岸スカート・水面メッシュの外周と同一のグリッド等値線から
  導出する。水域判定・岸距離(shoreDist)・陸地クリップのサンプリングの正は
  `src/model/waterfield.ts`(`createWaterField` / `marchPositiveRegion`)。
  pipeline(岸線データ)と mesh(三角形分割)が同じ純関数を共有することで、
  絵とデータの岸線を一致させる
- 水面メッシュの岸距離属性は waterfield の shoreDist(= −landSdf)を正とする
- 後PHASE の水辺判定(水辺建築・岸沿い道・杭基礎)は `loops` への近接、
  または waterfield の `waterSdf` で行ってよい

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
- `final` は PHASE 4a(段10)の担当(それまでは null)

### Network(PHASE 3、小道の追加は PHASE 4b)

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
  位置は水域を避け(waterSdf ≥ 0)、主河川がある場合は進入点が川の両岸に
  分かれるよう配置して橋の必然性を作る
- `nodes` は道路グラフの交差点・端点。id は経路探索グリッドのセル座標由来
  `"node/<ix>_<iz>"` で安定。進入点セルのノードは進入点と同一座標を、
  中心セルのノードは `centerPlan.position` と同一座標を持つ
- `edges` の `path` は A* のグリッド経路を間引き(Douglas–Peucker)・
  平滑化(Chaikin 1回)した点列。両端点は from / to ノードの position に
  一致する(座標値も同一)
- `class` は本PHASEでは `"main"`(進入点→中心の主道)と `"connector"`
  (進入点間の補完路)のみ。`"lane"`(小道)は PHASE 4b が追加する。
  小道の追加は nodes / edges への追記のみで行い、既存 edge の id を壊さない
- `width` は種別ごとの実寸(main 3.6 / connector 2.6。lane は PHASE 4b で確定)
- `grade` は道の等級 0〜2 の連続値(0=土、1=砂利、2=石畳)。
  `derived.roadGrade` を基準に main は +0.3 の格上げ(上限 2)。
  メッシュビルダーは頂点カラーの補間に使う(描画は PHASE 3 commit 11)
- 到達性: すべての進入点ノードは中心ノードへ `edges` のグラフ上で到達できる
  (段5のパイプライン内アサーションで検証し、違反件数を console に出す)

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
  主道どうしの交差ノード(確率的)。`"courtyard"` は PHASE 5a の担当
  (本PHASEでは生成しない)
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

### Wards(PHASE 3 で計画、立体化は PHASE 5b)

```ts
interface Wards {
  wardLevel: 0 | 1 | 2 | 3;      // Arcana駆動(1.6節)
  ringPath: Vec2[];              // 結界環の閉ループ。wardLevel 0 では空
  ringSegments: { start: number; end: number;   // ringPath 上の区間
                  kind: "wall" | "overwater" | "gap" }[];
                                 // 壁体/水上結界(発光弧)/開口。閉じ率を反映
  towers: { id: string; position: Vec2; height: number; onRing: boolean }[];
  gates: { id: string; position: Vec2; angle: number;
           roadEdgeId: string }[];              // 道路との交点に発生
  shrines: { id: string; position: Vec2; kind: "shrine" | "stones" | "crystals" }[];
  lamps: { id: string; position: Vec2 }[];      // 魔法灯(採択済み)
  floaters: { id: string; anchorId: string;     // 所属する塔/門/聖域のid
              basePosition: { x: number; y: number; z: number };
              size: number }[];                 // 基準位置のみ。上下動はビューワー側
}
```

結界計画の性質(段8「結界計画」が保証し、後段・メッシュビルダーが
前提としてよい):

- `wardLevel` は `derived.wardLevel` と一致する。0 のとき ringPath と
  各配列はすべて空
- `ringPath` は wardLevel ≥ 1 で非空の閉ループ(先頭点を末尾に重複させ
  ない)。自己交差なし・中心(`centerPlan.position`)を囲む星形(中心
  まわりの偏角に対して半径が一意)。生成手順: 一次密度場の等値線を初期
  形状とし、中心まわりの偏角リサンプル+循環平滑化で平滑にし、星形化に
  より自己交差を除去する。半径は「footprint 対角半径+マージン」以上、
  「境界−外縁マージン」以下にクランプする。水域(河川・湖・水路)は
  半径の径方向調整で回避し、回避できない区間は ringSegments の
  kind "overwater"(水上結界)として分離する(壁の接地検証から除外)。
  失敗時は等値線レベルを引き上げ(=囲い半径を縮小して)リトライする
  (リトライ回数も乱数ストリーム `"wards/ring"` から消費)。全リトライ
  失敗時は境界と footprint に収まる円環へフォールバックする
- `ringSegments` は `[start, end)`(ringPath のインデックス区間。
  end ≤ 点数。区間 k は点 k〜k+1 の辺を指す)の互いに素な区間で全周を
  被覆し、start 昇順。環の継ぎ目(インデックス 0)では同種でも分割され
  うる。kind の決め方: 水中(waterSdf < 0。水路を含む)にかかる辺は
  "overwater"、結界門の開口と閉じ率ぶんの開口は "gap"、残りが "wall"。
  wall の弧長は「全周 − overwater − 門開口」の約 `derived.wallClosure` 倍
  (立体化では level 1 の wall は境界標の点列に縮退、2 は部分壁、
  3 は門開口以外がほぼ wall の完全環。PHASE 5b)
- `gates` は wardLevel ≥ 2 のとき、結界環と道路 edge の全交点に生成する
  (`roadEdgeId` は交差 edge の id、`angle` は交点での道路方向)。
  道路側の補正は門位置の点を edge.path へ挿入する局所スナップのみで、
  道路の大規模な引き直しはしない。よって「結界環を横切る道路は必ず
  門位置を通る」(門位置と edge.path の距離は 0)。wardLevel 1 では
  gates は空(壁が無く、境界標の列は道を遮らない)。gate の直近の
  ringSegments は門開口の "gap" になる
- `towers` は wardLevel ≥ 2。結界環上の屈曲点を優先し、間隔規則
  (towerScale 駆動の目標本数と最小弧間隔)と水辺・門・橋詰めへの近接で
  採点して選ぶ(広場は段9確定のため、「広場近傍」の選好は広場が置かれる
  位置=門前・橋詰めへの近接で代替する)。towerScale が高いとき
  (wardLevel 3)は結界環外の水辺に独立塔(onRing: false)を 0〜2 基置く
- `shrines` は wardLevel ≥ 1 で 1〜2 箇所(shrineRate 駆動)。道路・
  水域から離れた静かな場所へ決定論的な局所探索で置く。kind の重みは
  Arcana 連動(高いほど crystals 寄り)
- `lamps` は主道沿いの等間隔候補・橋詰め・結界門前・中心 footprint 前
  (=中心前広場の位置)の候補から `lampDensity` で採択する(候補ごとの
  独立サブストリームにより lampDensity に対して単調)。位置は陸上
  (水路を含む水域の外)
- `floaters` は towers / gates / shrines を anchor とする近傍クラスタ
  (floaterAmount 駆動。Arcana 30 以下では 0)。basePosition は anchor
  近傍の空中の基準位置(y > 0)で、上下動はビューワー側の時間関数
- 段8は結界門スナップ後に bridges を全道路について再抽出し(Water 節)、
  summary.wardOverview(level / ringLength / towers / gates / shrines /
  floaters)を部分的に埋める

### Parcel / Building(PHASE 4a、部品の拡張は PHASE 4b・5a)

```ts
interface Parcel {
  id: string;
  polygon: Polygon;
  frontEdge: [Vec2, Vec2];       // 接道辺
  facing: number;                // 正面方向
  waterside: boolean; canalside: boolean;
}
interface Building {
  id: string;
  parcelId: string | null;       // 中心建築は null(centerPlan に立地)
  role: "house" | "waterside" | "bridgehead" | "hall"
      | "warehouse" | "outskirt" | "center";
  footprint: Polygon;
  floors: number;
  roof: { type: "gable" | "hip" | "compound"; pitch: number };
  materials: { wall: string; roof: string; trim: string }; // 素材ID(パレットはart-direction 5節)
  parts: Part[];                 // 建築部品の展開結果
}
interface Part {
  type: string;                  // 部品型(plinth/wall/roof/window/door/beam/chimney/
                                 //   pile/deck/stair/dormer/spire/crystal など。PHASEごとに追加)
  transform: { position: [number, number, number];
               rotation: number; scale: [number, number, number] };
  materialId: string;
  params?: Record<string, number>; // 型固有パラメータ
}
```

部品は必ず「型+パラメータ」で表現し、メッシュビルダーが型ごとに
一括マージ/インスタンス化する(implementation-spec 1.8節・9節)。

### Vegetation(PHASE 6)

```ts
interface Vegetation {
  trees: { id: string; position: Vec2; form: "conifer" | "broadleaf";
           scale: number; rotation: number; colorVar: number }[];
  shrubs: { id: string; position: Vec2; scale: number }[];
  grassPatches: { id: string; polygon: Polygon }[];
}
```

### Summary(PHASE 7。中間PHASEでは部分的に埋まる)

WorldModel から機械的に算出し、生成物と乖離させない。
表示する情報種別は `design.md`「UI とサマリー」を正とする。

```ts
interface Summary {
  buildingCounts: Record<string, number>;  // 役割別内訳
  centerDescription: string;               // 軸スコアから生成する短い記述文
  waterOverview: { rivers: number; lakes: number; canals: number; bridges: number };
  wardOverview: { level: number; ringLength: number; towers: number;
                  gates: number; shrines: number; floaters: number };
  scale: { worldSize: number; roadLength: number };
  complexity: { vertices: number; instances: number; drawCalls: number };
  hash: string;                            // 正規化ハッシュ(pipeline.md)
}
```

`hash` は `pipeline.md` の正規化ハッシュ。`runPipeline` が全段完了後に格納する
(PHASE 2 で導入し、以降の全PHASEで常時有効)。`hash` 自身はハッシュ計算から
除外するため、格納後もハッシュ値は変わらない。
