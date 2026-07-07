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
type ZoneKind = "grass" | "dirt" | "sandbar" | "marsh" | "paved";
                                                        // 草地/土/砂洲/湿地/舗装
const ZONE_KINDS: readonly ZoneKind[];                  // チャネル順の正(この並び)
interface ZoneMask {
  resolution: number;   // 一辺セル数
  cellSize: number;     // セル一辺の実寸。グリッド全体は原点中心の正方
                        // [-resolution×cellSize/2, +resolution×cellSize/2]²(≒ ground.size)
  weights: number[];    // 長さ resolution²×ZONE_KINDS.length(現在5)。セルは行優先
                        // (z 外側 → x 内側)、セル内は ZONE_KINDS 順。
                        // 各セルの重みは非負・合計 1
  brightness: number[]; // 長さ resolution²。明度ムラ係数(1±0.08。art-direction 5.2節)
}
```

- 地面段は「草地ベース+土の斑・むら」の下地を書く。砂洲・湿地チャネルは
  水系段が水域近傍へ書き込む(地面段の時点では 0)。
- 舗装チャネル("paved")は段10「舗装」(PHASE 3)が道路・広場・水路の
  footprint で上書きする(それまで 0)。各セルの舗装被覆度 p(0〜1)を
  道路(edge.path への距離 − width/2)・広場(polygon の符号付き距離)・
  水路(スプラインへの距離 − width/2 − 護岸幅)の最大被覆から求め、
  縁は短いブレンド帯(基準 1.6〜2.2 実寸。ただしグリッドの粗さで道が
  途切れないよう、下限をセル寸の 0.9 倍とする)で滑らかに落とす。既存チャネルを
  (1 − p) 倍へ縮めて paved に p を置くことで「非負・合計 1」の規約を保つ。
  段5/6/9 の各段は zoneMask に触れず、上書きは段10 に集約する
  (`pipeline.md` の段契約表)。段10 は乱数サブストリームを消費しない
  (入力データのみから決まる決定的なラスタライズ)。
  例外として、段10 より後に lane を追加する段13「小道」(PHASE 4b)は、
  小道の被覆(edge.path への距離 − width/2、ブレンド帯は道路と同基準)を
  段10 と同じ流儀(段内 max 合成 → 既存チャネルを (1 − p) 倍)で追記する。
  段をまたぐ追記のため被覆の重なりは p1 + p2 − p1·p2 となるが、
  舗装どうしの重なりに限られ絵は変わらない。段13 の上書きも乱数を
  消費しない(Network 節「小道の性質」)。
- 舗装チャネルの色はメッシュビルダーが決める: `derived.roadGrade` による
  土 → 砂利 → 石畳(art-direction 5.2節)の補間色を paved の基準色とし、
  道路リボン自身の頂点カラー(edge.grade による同じ補間)と写像を共有する。
- 建物 footprint による上書きは段12「建物」の担当とし、部品リスト展開と
  同時に行う(PHASE 4a commit 13)。骨格データのみの段階(commit 12)では
  建物は zoneMask に触れない(地面の絵を変えない)。上書きの流儀は
  段10 と同じ(ポリゴンスタンプの max 合成 → 既存チャネルを (1 − p) 倍):
  各建物の footprint を、壁材が石造系(materials.wall が stone / ashlar)
  なら舗装("paved")チャネル、それ以外は土("dirt")チャネルへ
  スタンプする(縁のブレンド帯は基準 1.2、下限セル寸 × 0.9)。
  dirt → paved の順で適用し、乱数サブストリームは消費しない
  (materials 確定後のモデル状態からの決定的なラスタライズ)。
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
  towpathSide: 1 | -1;           // 岸沿い道フック(段13「小道」がこの側に
                                 // 岸沿い道を通す。Network 節「小道の性質」)。
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
- 始端・終端の接続部を除き、点列は原則として既存水域(rivers / lakes)の
  外を通る(2026-07-07 追記。川・湖が中心域にかかる配置では経路が水中へ
  沈み、護岸付きの「街の水路」として描画できない=水路が現れないため。
  implementation-spec PHASE 3 完了条件):
  - 経由点は水中にある場合、水域の勾配で陸側へ押し出してから使う
  - 中間点は「中心線の waterSdf ≥ 幅/2 + 1」を目安に、水中の連続区間
    ごとに同じ側の岸へ押し出す(点ごとの最近岸では川筋を挟んで互い違いの
    岸へ跳ねてジグザグになるため)。始端・終端の接続窓(弧長 幅×2+4)と
    深い横断部(waterSdf < −(幅/2+6)。川・湖をまたぐ接続)は対象外
  - 押し出し後も中間部(接続窓を除く)の陸上率が 0.7 未満の経路は
    交差超過と同様に棄却してリトライする。全試行が陸上率を満たさない
    場合は、交差上限を満たす試行のうち陸上率最大のものを受理する
    (水域が広い設定では岸辺が限られるため、良路の全滅で本数の単調性を
    壊すより部分的に沈む水路を許す)。交差上限を満たす試行が無ければ
    棄却し、全水路棄却時は従来どおりフォールバックの堀留へ縮退する
    (リトライの乱数消費は従来どおり試行ごとに固定)
- 中心域・密集予定域を通る: 経由点を中心から footprint 半径〜中心前広場
  半径程度の距離に置き、主道どうしの角度間隙へ向ける(道路交差=
  BridgeSite の増加を抑える)
- 水路 1 本が生む BridgeSite は最大 3。超える場合は経路と蛇行を縮めて
  交差が減る方向へ再サンプルし、3 回のリトライで収まらなければその水路を
  棄却する(リトライ回数も乱数ストリーム `"canals/canal/<i>"` から消費して
  決定性を保つ。implementation-spec 9節)。棄却があっても他の水路の
  id(生成インデックス由来)は変わらない
- **水路は waterfield・岸線・zoneMask の自然地物に影響させない(設計判断)**:
  `model/waterfield.ts` の水域場は rivers / lakes のみから作り、
  `shoreline` の再抽出も行わない。水路は護岸(縁石・石積み)で縁取られた
  「掘り込みチャネル」であり、自然の岸辺(砂洲・湿地・岸スカート)を
  持たないため(zoneMask への影響は段10「舗装」による護岸縁までの
  舗装チャネル上書きのみ。ZoneMask 節)。地面メッシュも水路でクリップせず、
  描画(PHASE 3 commit 11)は地面の上に重ねる水路メッシュ(水面+護岸)で
  水際の段差を護岸で見せる(クリップとの整合問題を持たない)。
  地面をクリップしない以上、水面を地面(y=0)より下へ置くと地面に隠れる
  ため、水路の水面は地面よりわずかに上(+0.04 前後)に置き、護岸の
  立ち上がり(縁石天端 ≒ 水面 +0.4)との段差で「掘り込み」を読ませる。
  川へ注ぐ端部では waterfield の岸距離に応じて水面高を川の水面
  (y=-0.6)へ連続に降ろす。水面の材質・色は川と共通(art-direction 5.3節)
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
  導出し直す)。bridges の最終状態は段8の出力を正とする。
  段13「小道」が追加する lane は水域を渡らない(Network 節「小道の性質」の
  設計判断)ため、小道の追加後も bridges の再抽出は不要で段8の出力のまま
  変わらない

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
  位置は水域を避け(waterSdf ≥ 0)、主河川がある場合は進入点が川の両岸に
  分かれるよう配置して橋の必然性を作る
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
- 衝突制約: 小道の経路点は 境界(内側 2 以上)、河川・湖
  (waterSdf ≥ 幅/2 + 0.4)、水路(中心線距離 − 幅/2 ≥ 幅/2 + 0.3)、
  建物 footprint(クリアランス 幅/2 + 0.3)、広場(同 幅/2 + 0.5)、
  centerPlan.footprint(+1)、結界環(ringPath への距離 ≥ 2.0)、
  既採択の小道(中心線間隔 ≥ 幅 + 0.6)と衝突しない。
  衝突区間はトリムし、残った連続区間(最小長 towpath 10 / 裏手 12)を
  それぞれ独立の lane edge として採択する
- **小道は水域(河川・湖・水路)を渡らない**(上記の衝突制約で回避・分断
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

#### 結界構造の立体化(PHASE 5b commit 17)

結界壁・魔導塔・結界門・聖域の立体は、**メッシュ層の純関数**
`src/mesh/wardparts.ts` の `expandWardParts(model)` が Wards 計画+
`derived` から Part 列(「型+パラメータ」。Part の変換規約に従う)へ
展開し、`src/mesh/buildings.ts` の既存の束(躯体/屋根/発光/インスタンス
プール)へ合流させる(設計判断)。パイプラインには置かない:

- 展開は Wards 計画と derived から一意に決まる**表示写像**であり、
  新しい計画内容を持たない。WorldModel には部品を書き戻さないため、
  正規化ハッシュ(pipeline.md)は PHASE 5a から不変
- `wardparts.ts` は three 非依存(WorldModel のみを入力とする純関数)とし、
  接地・門通過・縮退・発光面積のテストが three を経由せず機械検証できる
- 乱数ストリームは消費しない。個体差(壁高・立石の寸法・頂部の選択)は
  すべて位置ハッシュ由来(メッシュ層の既存流儀)
- 発光面積の正は `src/pipeline/center.ts` の `glowPartArea` を共用する
  (面積定義を中心建築と二重化しない)

造形の文法(implementation-spec 6章 PHASE 5b、art-direction 2.2 / 5.4 / 6節):

- **結界壁**(`ward-wall`): ringSegments の kind "wall" の辺ごとに
  基部+壁体+頂縁のセグメントを置く(胸壁・狭間は作らない=非軍事)。
  壁高は `wallClosure` の連続関数(1.7 + 2.3 × closure。±4% の位置ハッシュ
  揺らぎ)で、段階内・段階間とも連続に変化する。継ぎ目は長さ +0.35 の
  重なりで隠す。材は `stone`。壁外面・内面には**間隔規則**
  (5.5 + 6 × (1 − glowIntensity) の弧長間隔)で縦の発光紋様ライン
  (`sigil`。小面積)を刻む
- **縮退(wardLevel 1 / 2。同一文法・別実装にしない)**: 壁セグメントの
  展開は「wall 弧に沿った歩行器」1 つで行い、wardLevel 1 では壁体の
  代わりに境界標(`ward-stone`。発光紋様 `sigil` を1本持つ立石)の点列
  (間隔 7 − 2 × closure)を落とす。2 以上では同じ歩行器が連続壁を出す。
  弧の途切れ方(閉じ率)は計画側 ringSegments が持つ(1.6節)
- **水上結界**(kind "overwater"): 壁体を持たない。水面上
  (y ≈ −0.45 起点、高さ 0.34)の発光ラインの弧を `sigil`(外面+内面)で
  張る。壁の接地検証から除外される区間の別部品表現
- **魔導塔**(wards.towers): `plinth` + `tower`(taper 0.8。幅 =
  clamp(height × 0.16, 1.8, 2.9) で一般建物より明確に細長い)+頂部は
  水晶(`crystal`。位置ハッシュ < 0.25 + 0.75 × towerScale で採択、
  発光予算不足時は尖屋根へフォールバック)または尖屋根(`spire`、
  材 `slate`)。塔身に `sigil` のリング(glowIntensity ≥ 0.25 で 2 段、
  未満で 1 段 × 4 面)。躯体材は `stone`(art-direction 5.1節)
- **結界門**(wards.gates): `arch`(アーチ開口の門躯体)+両脇の
  小塔(`tower` + 頂部)+発光門紋(`sigil` の菱形紋+脚の縦帯。両面)。
  開口幅 = 道路幅 + 1.8、開口天端 = 3.4 + 1.2 × gateScale
  (道路は必ず開口をくぐれる)。門開口の "gap" 弧(段8)が壁を開けるため、
  門前広場・道路との接続を壊さない
- **聖域**(wards.shrines): kind "shrine" = 基壇+躯体+石の切妻+
  `door` +門前紋様の小さな祠 / "stones" = 立石の環(`ward-stone` × 6。
  紋様は内向き)/ "crystals" = 岩座+水晶クラスタ(`crystal` × 4。
  中央大+周囲小)
- **発光の規律**: 発光は既存の `buildings-glow` 束へ合流する
  (マテリアル規範・明滅・reduced-motion は PHASE 5a の束の規範のまま。
  draw call は増えない)。結界要素の発光面積合計は
  `glowAreaCap × 箱庭面積 × 0.65`(結界の取り分。中心建築の 0.35 の残り)
  以下とし、予算順(塔頂 → 門紋 → 聖域 → 境界標 → **魔法灯 → 浮遊水晶** →
  壁紋様 → 水上弧)に採択して超過分を打ち切る(commit 18 改定:
  魔法灯・浮遊水晶も同じ取り分・同じ累積予算に含め、Arcana 連動の主要
  シグナルである点在の灯を、反復帯である壁紋様・水上弧より優先する)。
  `glowIntensity` は紋様の間隔(密度)へ効く
- **デバッグ描画の置換範囲**: `src/mesh/planmarks.ts` から結界環ライン・
  塔/門/聖域マーカーを撤去する。魔法灯・浮遊要素・BridgeSite のマーカーは
  commit 18 が立体へ置換し、planmarks はファイルごと撤去する(下記
  「魔法灯・浮遊要素・橋の立体化」)

#### 魔法灯・浮遊要素・橋の立体化(PHASE 5b commit 18)

commit 17 と同じ流儀の**表示写像**として立体化する。パイプライン・
WorldModel には一切書き戻さず、正規化ハッシュ(pipeline.md)は
PHASE 5a から不変のまま。乱数ストリームは消費しない
(個体差・採択はすべて位置ハッシュまたは安定 id のハッシュ由来)。
これで計画デバッグ描画は全廃となり、`src/mesh/planmarks.ts` は
ファイルごと削除する。

**魔法灯**(wards.lamps。採択は段8で完了済み):

- 立体 = 柱(`lamp-post`)+火屋(発光 InstancedMesh のインスタンス)。
  柱は柱身+天板の箱ピースへ分解して既存の `building-trim` プールへ
  合流する(draw call 不変)。柱材は `derived.roadGrade ≥ 1.4` で
  `stone`、未満で `wood`(art-direction 5.4節「柱は木部または石」)
- 火屋は柱天板の少し上に**浮く**小さな八面体の発光コア
  (#5fd4c0。crystal と同形)。共有 InstancedMesh
  `ward-glow-crystals`(浮遊水晶と共用。下記)のインスタンスとし、
  上下動の振幅は 0(静止)。明滅は発光束と同じ規範
  (±15%・周期約5.5秒、位相は lamp.id の文字列ハッシュ由来)
- 発光予算: 火屋の面積(crystal と同じ glowPartArea 換算)は結界の
  取り分の累積予算に含める(予算順は上記の改定どおり)。予算不足で
  火屋を置けない灯は柱ごと置かない(灯らない柱を残さない)
- **足元の照り返し**: 灯の足元(半径 2.6)の地面・舗装の頂点カラーへ
  彩度控えめの青緑(#3f7f74、最大ブレンド 0.22、smoothstep 減衰)を
  焼き込む(art-direction 3節)。設計判断: zoneMask は WorldModel の
  データ(正規化ハッシュの対象)であり、照り返しは表示写像の一部の
  ため、zoneMask のチャネルではなく**メッシュ側の頂点カラー処理**
  (地面・舗装の両バッファへの後処理)とする。純関数
  `createLampTint` / `applyLampTint`(`src/mesh/wardparts.ts`)を
  地面(mesh/build.ts)と舗装(mesh/paving.ts)が共有する

**浮遊要素**(wards.floaters。基準位置のみ WorldModel):

- 浮遊水晶(発光)と浮石(非発光)の 2 種。割合は基準位置の
  位置ハッシュで決め、**水晶 0.35 / 浮石 0.65** とする(発光は
  面積と数を絞る。art-direction 2.2節)。水晶が発光予算に収まらない
  場合はその個体を浮石へフォールバックする(クラスタの個数は保つ)
- 浮遊水晶は `ward-glow-crystals`(発光 InstancedMesh 1 つ。
  魔法灯の火屋と共用)、浮石は `ward-floatstones`
  (石色の InstancedMesh 1 つ)へ集約する(draw call +2。
  どちらも castShadow: false)
- 上下動はビューワーの時間 uniform(水面・発光束と共有の
  `userData.waterTime`)による頂点シェーダーオフセット
  `y += amp × sin(t × 0.75 + phase)`。振幅はワールドで 0.14〜0.30
  (位置ハッシュ由来。ゆっくり・小さく)、**位相は floater.id の
  文字列ハッシュ由来**(インスタンス属性 aPhase / aAmp)。
  prefers-reduced-motion では uniform が更新されず静止する。
  基準位置 basePosition は浮遊の中心(立体の底 = y − 高さ/2)
- 魔法灯・浮遊要素の展開は `expandWardParts`(mesh/wardparts.ts)が
  担い、発光予算の累積を結界構造と共有する

**橋**(water.bridges):

- 展開はメッシュ層の純関数 `src/mesh/bridgeparts.ts` の
  `expandBridgeParts(model)`(three 非依存)。Part 列は
  mesh/buildings.ts の既存の束へ合流する(躯体/屋根マージ・
  building-trim・building-piles。draw call は増えない)
- **型の対応表**(over / roadClass / Prosperity):

  | over | 条件 | 型 |
  |---|---|---|
  | river / lake | roadClass "main" かつ roadGrade ≥ 0.9 | 石造アーチ橋 |
  | river / lake | 上記以外(connector・低 Prosperity) | 木橋(桁+杭橋脚) |
  | canal | roadGrade ≥ 0.9 | 水路の小橋(石。桁+欄干+袂の石座) |
  | canal | roadGrade < 0.9 | 水路の小橋(木。同上、木部) |

- **河川・湖の橋**: 道路リボンが岸で止めた渡り区間を橋が受け持つ。
  渡り区間の標本化は道路リボン(mesh/paving.ts)と**同一**の
  `waterCrossings(edge.path, field.waterSdf, 2.0)`(model/geometry.ts。
  rivers/lakes の waterfield、標本間隔 2.0)を共用し、取り付きに
  隙間を出さない。橋床は渡り区間の両端から 0.9 だけ陸へ延長した
  区間を弧長 2.4 でリサンプルした箱セグメント列(`plinth` 再利用。
  継ぎ目は +0.35 の重なり)。**橋床天端 = roadBaseY(edgeId) +
  ROAD_CROWN + 0.02**(道路リボンの中央盛り上げと同じ高さ関数を
  bridgeparts が正として持ち、paving が共用する。+0.02 は接合部の
  Z ファイティング回避で、段差としては読めない)
- 石造アーチ橋: 渡り区間を等分(目標支間 8、1〜6 連)した `arch`
  部品列(commit 17 の共用形状)。脚 = 橋脚として position.y = −1.6
  (岸スカート下端)から橋床下端まで立ち上げる(水底到達)。
  欄干は低い石の胸壁ならぬ**笠付き低欄**(`fence` 再利用)を両縁に。
  袂に石の取り付き座(`plinth`)
- 木橋: 橋床(木)+両縁の桁(`plinth`(木)。**桁下端は水面
  (y=−0.6)より上**に保つ)+杭橋脚(`pile` 再利用。y=−1.6 から
  橋床下端まで。支間約 5.5 ごとに 2 本組)+欄干(`beam` 再利用の
  柱+手すり)
- **水路の小橋**: 道路リボン自身が水路上を持ち上がって渡る
  (mesh/paving.ts の既存 lift)ため橋床は作らず、リボンの下縁を
  受ける桁(両縁。下端 y = 0.12 > 水路水面 0.04)+欄干+両袂の
  取り付き座(`plinth`)を BridgeSite(over "canal")の
  position / angle / length から置く。リボンの lift 形状の正は
  bridgeparts の純関数 `canalLiftAt` とし、paving が共用する
- **橋上小建築**: 石造アーチ橋 × 渡り長 ≥ 14 × `canalScore ≥ 0.45`
  のとき、位置ハッシュ < clamp((canalScore − 0.3) × 1.2, 0, 0.8) で
  採択し、橋央の橋脚上・片側張り出しに小屋(`wall` + `gable` +
  `window`)を 1 棟置く(運河都市の気配。確率的)
- 検証契約(テストが機械検証する): (1) 取り付き端点は陸上
  (waterSdf ≥ −0.2)かつ接道 edge.path 上、(2) 橋床天端 =
  roadBaseY + ROAD_CROWN + 0.02(道路と段差なし)、(3) 桁下端 >
  水面(河川・湖 −0.6 / 水路 +0.04)、(4) 橋脚(pile・arch)の
  下端 = −1.6、(5) 同一入力の 2 回展開が完全一致(決定性)

PHASE 5b commit 18 の追加語彙:

| type | 経路 | 形状 | scale の意味 | params |
|---|---|---|---|---|
| `lamp-post` | インスタンス(building-trim 共有プールへのピース分解: 柱身+天板) | 魔法灯の柱。火屋(発光)は部品ではなく `ward-glow-crystals` のインスタンス | 柱幅×柱高×柱幅 | なし |

- 再利用する既存語彙(橋): `plinth`(橋床・桁・取り付き座)/
  `arch`(石造アーチ)/ `pile`(杭橋脚)/ `fence`(石の低欄)/
  `beam`(欄干の柱・手すり)/ `wall` / `gable` / `window`(橋上小建築)
- 専用 InstancedMesh(部品語彙外): `ward-glow-crystals`(発光
  八面体。火屋+浮遊水晶。glow マテリアル+明滅+上下動)、
  `ward-floatstones`(浮石。石色+個体ムラ+上下動)

### Parcel / Building(PHASE 4a、部品の拡張は PHASE 4b・5a)

```ts
interface Parcel {
  id: string;                    // "parcel/<roadEdgeId>/<L|R>/<slot>"。位置・edge 由来で安定
  roadEdgeId: string;            // 接道する道路 edge の id
  polygon: Polygon;              // 敷地(間口×奥行きの矩形)。時計回り・自己交差なし
  frontEdge: [Vec2, Vec2];       // 接道辺(接道 edge 側の2頂点。接線方向昇順)
  facing: number;                // 正面方位(xz 偏角。敷地から接道 edge の中心線へ向かう方向)
  waterside: boolean;            // 河川・湖の岸沿い(下記の判定基準)
  canalside: boolean;            // 水路沿い(同)
}
interface Building {
  id: string;                    // "building/<parcelId の parcel/ 以降>"。区画由来で安定
  parcelId: string | null;       // 中心建築は null(centerPlan に立地。PHASE 5a)
  role: "house" | "waterside" | "bridgehead" | "hall"
      | "warehouse" | "outskirt" | "center";
  footprint: Polygon;            // 矩形/L字/T字。セットバック込み。時計回り・自己交差なし
                                 // (中心建築は主棟+翼棟の外形。矩形/L/U。下記「中心建築」)
  facing: number;                // 正面方位(xz 偏角。広場 > 道路 > 水面の優先+揺らぎ込み)
  floors: number;                // 階数。1〜3 の整数(中心建築の主棟のみ 1〜5)
  roof: { type: "gable" | "hip" | "compound"; pitch: number };
                                 // pitch は度数(50〜58。art-direction 6節)
  foundation: Foundation;        // 接地(基壇・杭・石基礎)。段12の骨格データ(commit 12)
  materials: { wall: string; roof: string; trim: string }; // 素材ID(パレットはart-direction 5節)
  parts: Part[];                 // 建築部品の展開結果
}
interface Foundation {
  kind: "plinth" | "piles" | "stonebase"; // 基壇 / 杭 / 石基礎
  plinthHeight: number;          // 基壇の立ち上がり高(y=0 から。Prosperity・役割駆動)
  overWater: boolean;            // footprint が水面(河川・湖)上に張り出すか
  bottomY: number;               // 基礎下端の y。陸上は 0、水上張り出しは
                                 // SHORE_SKIRT_BOTTOM_Y(-1.6。岸スカート下端)
}
interface Part {
  type: string;                  // 部品型(下記の型語彙。PHASEごとに追加)
  transform: { position: [number, number, number];
               rotation: number; scale: [number, number, number] };
  materialId: string;
  params?: Record<string, number>; // 型固有パラメータ
}
```

部品は必ず「型+パラメータ」で表現し、メッシュビルダーが型ごとに
一括マージ/インスタンス化する(implementation-spec 1.8節・9節)。

#### Part の変換規約(PHASE 4a commit 13 で確定)

- `position`: 部品原点のワールド座標 `[x, y, z]`。原点は部品の**底面中心**
- `rotation`: Y 軸まわりの回転(rad。three.js の `rotateY` と同義)。
  部品ローカルの +x 軸はワールド `(cos rotation, 0, −sin rotation)` へ写る
- `scale`: 部品ローカルの単位形状 `[-0.5, 0.5] × [0, 1] × [-0.5, 0.5]`
  (x=長手、y=高さ、z=短手)の各軸の実寸

#### Part の型語彙

メッシュビルダー(`src/mesh/buildings.ts`)は部品を型ごとに2経路で
一括処理する(implementation-spec 1.8節・9節。後付けの最適化にしない):

- **マージ型**: 頂点カラー付きジオメトリへマテリアル束(下記)別に集約する
- **インスタンス型**: 反復部品を InstancedMesh にする。型ごとのハンドラが
  部品を共有プールのピースへ分解する(下記「インスタンス経路のピース分解」)

PHASE 4b 以降の部品型は、この2経路のどちらかへ型ハンドラの
追加登録のみで加える(本書の語彙表へ先に追記する)。経路の切替は
型キー単位の登録表の移動だけで行える。未知の型は
メッシュビルダーが warn を出して読み飛ばす(生成は壊さない)。
PHASE 5 以降の部品型(deck / spire / crystal など)も同じ流儀で加える。

#### インスタンス経路のピース分解(PHASE 4b commit 15 で確定)

反復部品(window / door / beam / chimney)は型ごとの専用ジオメトリではなく、
**軸平行の箱ピース**と **+z 向きの面ピース**へ分解し、型横断の共有
InstancedMesh 2 つへ集約する(型ごとに 1 mesh を立てるより draw call が
少なく、枠の見付け 0.13 などの実寸固定ディテールを部品寸法から
ピース生成時に計算できるため、マージ経路と同一のワールド形状を保てる):

- `building-trim`(単位箱 `[-0.5,0.5]×[0,1]×[-0.5,0.5]` の InstancedMesh。
  castShadow: true = 主要 InstancedMesh として影を落とす):
  窓枠 4 箱(左右縦枠+上枠+窓台)、扉枠 3 箱(左右+上)、
  梁 1 箱、煙突の胴・笠 2 箱+頂部の暗色薄箱
- `building-openings`(+z 向き単位面 `[-0.5,0.5]×[0,1]` の InstancedMesh。
  castShadow: false): 窓の暗色奥面(`#352c22`)、扉板(木部 × 0.55)
- ピースの色は instanceColor = 基準色 × ±8% の個体ムラ
  (ピース中心の位置ハッシュ由来。乱数ストリーム非消費)。
  マージ経路の面ごとのムラがピースごとのムラになる以外、
  形状・色・寸法は commit 14 のマージ展開と同一(経路変更で絵を変えない)
- 杭(pile)は従来どおり専用の `building-piles` InstancedMesh
  (castShadow: false)のまま

PHASE 4a commit 13 の語彙:

| type | 経路 | 形状 | scale の意味 | params |
|---|---|---|---|---|
| `plinth` | マージ | 基壇・石基礎の直方体 | 間口×立ち上がり×奥行き。overWater の石基礎(kind "stonebase")は position.y = `foundation.bottomY`(-1.6)から立ち上げ、水面下到達を部品として表す | なし |
| `pile` | インスタンス | 杭の角柱(kind "piles" の建物の翼外周) | 杭幅×長さ×杭幅。position.y = `foundation.bottomY`(-1.6)、上端は基壇天端(床下)に一致 | なし |
| `wall` | マージ | 壁体(1 階ぶんの直方体)。翼(wing)ごと×階ごとに 1 部品 | 間口×階高(3.0 固定)×奥行き | `floor`: 階番号(0 起点。4b のジェッティ・開口配置のフック) |
| `gable` | マージ | 切妻屋根の閉プリズム(勾配面 2+妻三角 2+軒裏)。棟はローカル +x 軸、y=1 が棟高 | 棟長(妻側の張り出し込み)×棟高×スパン(軒の張り出し込み)。棟高 = tan(pitch) × スパン / 2 | `pitch`: 勾配(度。50〜58) |
| `hip` | マージ | 寄棟屋根(台形勾配面 2+三角勾配面 2+軒裏)。棟は両端からスパン/2 ずつ縮み、妻側も同じ勾配で流れる | gable と同じ | 同上 |

- 複合屋根(`roof.type: "compound"`)は専用型を持たず、翼ごとの `gable`
  の組で表現する(交差部はジオメトリの貫通で処理する)

PHASE 4b commit 14 の追加語彙(開口・木組み・煙突・付属):

| type | 経路 | 形状 | scale の意味 | params |
|---|---|---|---|---|
| `window` | インスタンス(commit 15。ピース分解は上記) | 窓。壁面上の枠+枠より奥まった暗色面(壁に穴は開けない。art-direction 6節のセットバック表現) | 開口幅×開口高×枠の突出(0.16)。開口部品の変換規約(下記) | なし |
| `door` | 同上 | 扉。三方枠+暗色に沈めた扉板 | 扉幅×扉高×枠の突出(0.18)。同上 | なし |
| `beam` | 同上 | 木組みの梁・柱(壁面上に浮かせた直方体ストリップ) | 長さ×太さ×壁面からの厚み。ローカル +x=梁方向。position は壁面から厚み/2 外へ出した底面中心 | なし |
| `chimney` | インスタンス(commit 15。ピース分解は上記) | 煙突(胴+笠。頂面は開口の暗色)。実寸比 15% 過大(art-direction 6節): 胴幅 = 基準 0.72 × 1.15 | 胴幅×全高×胴幅。position は胴下端中心(壁天端 −0.3 から棟越えまで) | なし |
| `jetty` | マージ | ジェッティ(上階張り出し)の床帯。張り出した上階壁の下端を受ける横木 | 正面幅×帯高×奥行き | なし |
| `fence` | マージ | 低い石垣のセグメント(敷地前面帯。footprint の外に置かれる) | 長さ×高さ×厚み | なし |
| `stair` | マージ | 外階段(踏面の直方体の段列)。ローカル −z が壁側、+z へ降りる | 幅×全高(=基壇天端)×全奥行き | `steps`: 段数(2〜4) |
| `dormer` | マージ | 屋根の小窓(小さな切妻箱+暗色開口面)。屋根勾配面に背面を埋めて置く | 幅×全高×奥行き。rotation は開口の外向き法線(開口部品の変換規約) | なし |

開口部品(`window` / `door` / `dormer`)の変換規約:

- `position` は取り付く壁面(勾配面)上の開口下端中心。ローカル +z が
  外向き法線となる(基本の変換規約から +z はワールド
  `(sin rotation, 0, cos rotation)` へ写る)
- 枠はローカル z −0.2〜+0.5(壁へ半ば埋まり、壁面から突出する)、
  暗色の奥面は枠より低い +z に置く(枠との段差でセットバックを読ませる)。
  奥面の色は art-direction 5.1節の開口暗色 `#352c22` 固定
  (発光させない。窓明かりの emissive は使わない)

PHASE 5a commit 16 の追加語彙(中心建築の拡張文法):

| type | 経路 | 形状 | scale の意味 | params |
|---|---|---|---|---|
| `tower` | マージ(躯体) | 塔身(先細りの角柱+天端面。上端の辺長 = 底辺 × taper) | 幅×高さ×奥行き | `taper`: 先細り率(0.3〜1) |
| `spire` | マージ(屋根束) | 尖塔屋根(四角錐+軒裏。魔導塔の尖り屋根・物見塔の屋根と共用の文法) | 底辺×高さ×底辺 | なし |
| `crystal` | マージ(発光束) | 頂部水晶(八面体。全面が発光コア `#5fd4c0`。細身に保つ=発光面の幅を絞る) | 幅×全高×奥行き | なし |
| `glow-window` | マージ(枠は躯体、発光面は発光束) | 発光開口(枠+枠より奥の発光面。開口部品の変換規約に従う) | 開口幅×開口高×枠の突出 | なし |
| `sigil` | マージ(発光束) | 結界紋様の発光帯(壁・塔面上の薄い面。position は帯下端中心、ローカル z=0 の面。取り付け面から浮かせる量は position 側で持つ) | 帯長×帯幅×(未使用 1) | `tilt`: 面内回転(rad。菱形紋の合成用) |
| `rose-window` | マージ(躯体) | 薔薇窓風の円形大開口(16角形の枠+スポーク+暗色奥面 `#352c22`。非発光。開口部品の変換規約) | 直径×直径×枠の突出 | なし |
| `arch-window` | マージ(躯体) | 尖頭窓風の大開口(五角形の枠+暗色奥面 `#352c22`。非発光。開口部品の変換規約) | 開口幅×開口高(頂点まで)×枠の突出 | なし |
| `courtyard-wall` | マージ(躯体) | 中庭壁のセグメント(壁体+笠。胸壁・狭間は作らない) | 長さ×高さ×厚み | なし |

- 再利用する既存語彙: `plinth` / `wall` / `gable` / `hip` / `window` /
  `door` / `chimney` / `stair`。`stair` の `steps` は一般建物 2〜4、
  中心建築の前庭階段では 2〜10 に拡張する
- 発光束(メッシュビルダーの第3のマージ束): `crystal` / `sigil` /
  `glow-window` の発光面を 1 つの統合ジオメトリ `buildings-glow` に
  集約する(draw call +1 のみ)。マテリアルは
  ベース(拡散)`#2a3a38` 固定 + emissive `#5fd4c0` +
  emissiveIntensity 2.0(art-direction 5.4節)。頂点カラーは発光の
  重み(コア 1.0 / 紋様・縁 0.35 → 実効 0.7 = 同節の 0.6〜0.8 帯)として
  拡散と emissive の両方に乗る。明滅はビューワーの時間 uniform
  (水面と共有の `userData.waterTime`)で ±15%(= 2.0 ± 0.3)、
  周期約 5.5 秒、位相は位置ハッシュ由来(乱数ストリーム非消費)。
  prefers-reduced-motion では uniform が更新されず静止する。
  Bloom・動的光源は使わない。castShadow は false

PHASE 5b commit 17 の追加語彙(結界構造。部品の出所は Building.parts では
なく `src/mesh/wardparts.ts` の展開結果 — Wards 節「結界構造の立体化」):

| type | 経路 | 形状 | scale の意味 | params |
|---|---|---|---|---|
| `ward-wall` | マージ(躯体) | 結界壁セグメント(基部+壁体+頂縁。胸壁・狭間なし)。基部・頂縁の張り出しと基部高(0.42)・頂縁高(0.3)は実寸固定でピース生成時に scale から逆算する | 長さ×高さ×厚み(壁体) | なし |
| `arch` | マージ(躯体) | アーチ開口を持つ門躯体(両脚+アーチ頭+開口ソフィット)。開口はローカル z 方向へ貫通し、アーチはワールドで半円に近づくよう縦半径を scale から決める。橋(PHASE 5b commit 18)と共用できる汎用形状 | スパン×全高×厚み | `open`: 開口幅/スパン(0〜1)、`rise`: 開口天端高/全高(0〜1) |
| `ward-stone` | インスタンス(専用プール `ward-stones`) | 境界標・立石(先細り・頂部が前傾した立石)。ワールド形状は部品 1 つ = 1 インスタンス | 幅×高さ×奥行き | なし |

- 再利用する既存語彙: `plinth` / `tower` / `spire` / `crystal` / `sigil` /
  `gable` / `door`
- `ward-stones` は建物の共有プール(building-trim 等)とは独立の
  InstancedMesh 1 つ(draw call +1)。境界標は wardLevel 1 の主要な結界
  表現のため、主要 InstancedMesh として castShadow: true とする。
  instanceColor は石の基準色 × ±8% の個体ムラ(位置ハッシュ由来)

#### materialId の語彙(基準色は art-direction 5.1節)

| materialId | 基準色 | 用途 |
|---|---|---|
| `stone` | `#8e8a84` | 石(基壇・石造壁・石のトリム) |
| `ashlar` | `#a8a49b` | 切石(高 Prosperity の基壇・壁) |
| `plaster` | `#d9cfbc` | 漆喰壁 |
| `rough-wood` | `#6e5a44` | 粗い木の壁(最下層 Prosperity) |
| `wood` | `#5d4a38` | 木部(杭・梁・窓枠・扉・ジェッティ。5b で欄干) |
| `thatch` | `#97855a` | 茅屋根 |
| `shingle` | `#7a6a52` | 木羽屋根 |
| `tile` | `#a0563c` | 瓦屋根 |
| `slate` | `#5c6b7a` | スレート屋根 |
| `glow` | (art-direction 5.4節) | 発光部品(`crystal` / `sigil`)。基準色表は使わず、発光束のマテリアル規範(上記)に従う |

- 色の正はメッシュビルダーの基準色表(`src/mesh/buildings.ts`)とし、
  art-direction 5.1節と同期させる。頂点カラーは基準色 × 面ごとの
  ±8% 明度ムラ(位置ハッシュ由来。乱数ストリーム非消費)×
  壁足元・基壇下端・軒裏の焼き込みAO(art-direction 3節)で決める
- マテリアル束(マージ先): 屋根系(`thatch` / `shingle` / `tile` /
  `slate`)は「屋根」束、それ以外は「躯体」束。束ごとに 1 つの
  統合ジオメトリ+ MeshStandardMaterial(頂点カラー)となる

`Building.materials` の決め方(段12。commit 13 で基準色を選定、
PHASE 4b commit 14 で素材階層の移行規約として確定):

- 壁材階層と屋根パレットの対応(色は art-direction 5.1節):

  | tier(添字) | wall | roof |
  |---|---|---|
  | 0 | `rough-wood`(掘立・粗い木) | `thatch`(茅) |
  | 1 | `plaster`(木組み漆喰。`beam` 部品の木組みを伴う) | `shingle`(木羽) |
  | 2 | `stone`(石造) | `tile`(瓦) |
  | 3 | `ashlar`(切石) | `slate`(スレート) |

- 移行は**離散選択**(階層間の色ブレンドはしない):
  添字 = clamp(round(tier + 役割補正 + seed 揺らぎ ±0.6), 0, 3)。
  `derived.wallTier` / `roofTier`(0〜3 連続)の小数部は、揺らぎとの和の
  丸めによって階層境界の**混在比**として連続に現れる(Prosperity を上げると
  低階層→高階層へ分布が滑らかに移行する)
- 役割補正: hall +0.6 / bridgehead +0.2 / waterside −0.2 /
  warehouse −0.5 / outskirt −0.7 / house 0(wall / roof 同係数)
- `trim` ∈ { `wood`, `stone` }。壁が石造系(`stone` / `ashlar`)なら
  `stone`、それ以外は `wood`。木部色は `wood`(art-direction 5.1節)
- 素材階層と部品の連動(PHASE 4b): 木組み梁・ジェッティは
  `wall = "plaster"`(tier 1。中 Prosperity 帯)の建物にのみ付く。
  基壇・煙突・外階段の材は壁が `ashlar` なら `ashlar`、それ以外は `stone`
- 乱数は部品用の派生サブストリーム `"building/<id>/parts"` のみ消費する
  (消費数は建物あたり固定。commit 12 の骨格データの乱数消費を変えない)

PHASE 4a 内の分担(commit 12 = 計画データ、commit 13 = 骨格文法とメッシュ):

- 段11「区画」(commit 12)が `density.final` と `parcels` を埋める
- 段12「建物」のうち、`id` / `parcelId` / `role` / `footprint` / `facing` /
  `floors` / `roof` / `foundation` は commit 12 が埋める。
  `materials` / `parts` の展開と zoneMask の建物 footprint 上書きは
  commit 13 の担当で、それまで materials は空文字列、parts は空配列とする
  (仮実装ではなくスコープ分割。implementation-spec 1.9節)

区画の性質(段11「区画」が保証し、後段・メッシュビルダーが前提としてよい):

- 道路 edge(main / connector)の両側に、中心線から
  `edge.width/2 + 1.0`(前面帯)だけオフセットした帯を取り、道路に沿って
  間口×奥行きの矩形敷地へ分割する。間口は `derived.parcelSize` を基準に
  最終密度場 `density.final` で変調する(高密度ほど狭小)。奥行きは間口比
  約 1.25(敷地ごとの ±10% 揺らぎ込み)。衝突する候補は奥行きを
  決定論的に縮小して再試行する(×0.72 → ×0.5、下限 4.5。岸沿いなど
  狭い帯にも敷地を通す。縮小は乱数を消費しない)
- 採択確率は `derived.parcelRate` × 密度係数(final に単調)。
  岸沿い(waterside)・水路沿い(canalside)の候補は
  `derived.watersideRate` で採択率を押し上げる。総数は
  `derived.parcelCountMax` を上限とし、超過後の候補は棄却する
- 衝突棄却の対象(いずれかに当たる候補は棄却): (1) 広場ポリゴン、
  (2) 水面 = 河川・湖(waterfield の waterSdf)+水路(中心線距離 − 幅/2)、
  (3) 道路 = 全 edge の path(クリアランス edge.width/2 + 0.3)、
  (4) 結界環バッファ(ringPath への近接・交差。wardLevel ≥ 1)、
  (5) centerPlan の予約 = 中心からの半径
  `derived.parcelReserve × derived.centerFootprint / 2` の円と
  `centerPlan.footprint` ポリゴン、(6) 既採択の区画、
  (7) `ground.boundary` の外(マージン 2)
- 岸線の建築占有率の上限(40%): 占有率 =「`shoreline.loops` の全点のうち、
  採択済み waterside 区画のポリゴンから 6(実寸)以内にある点」の割合。
  採択のたびに更新し、上限 0.40 を超える waterside 候補は棄却する
  (水辺を建物で埋め尽くさない。PHASE 6 はこのロジックに手を入れない)
- `id` は `"parcel/<roadEdgeId>/<L|R>/<slot>"`(L/R は進行方向左右、
  slot は edge 沿いの候補スロット連番)。スロット連番は採択結果に
  依存しない(棄却された候補も番号を消費する)ため、位置・edge 由来で安定
- `frontEdge` は接道辺(道路側の2頂点)。その中点から接道 edge の path への
  距離は `edge.width/2 + 2.0` 以下(接道保証。テストはこれを機械検証する)。
  `facing` は frontEdge の中点から接道 edge の中心線へ向かう方向の偏角
- waterside / canalside の判定基準: 敷地のプローブ(頂点4+辺中点4+
  中心1+内部4 の 13 点。衝突棄却と共通)の最小距離で、河川・湖の
  waterSdf < 4.5 なら waterside、水路の(中心線距離 − 幅/2)< 4.5 なら
  canalside
- 乱数は区画ごとの独立サブストリーム `"parcel/<id>"` のみ消費する
  (奥行き揺らぎ・採択ロール。生成順序の変更が他区画へ波及しない)

建物骨格の性質(段12「建物」の commit 12 分が保証する):

- 建物は区画と 1:1(採択済み区画ごとに 1 棟)。`id` は
  `"building/<parcelId の parcel/ 以降>"` で区画由来で安定。
  乱数は `"building/<id>"` サブストリームのみ消費する
- 役割(UI選択なし・文脈から決定): 広場に面する(区画と広場ポリゴンの
  距離 < 3)× Prosperity → hall、BridgeSite 近傍(渡り長/2 + 10 以内)
  × watersideRate → bridgehead、waterside/canalside 区画 × watersideRate →
  waterside、final 密度の裾(< 0.14)→ outskirt、低密度(< 0.24)×
  低 Prosperity → warehouse、それ以外 → house。優先順は
  hall > bridgehead > waterside > outskirt > warehouse > house
- footprint は矩形基本。広い敷地の hall は T 字、広い敷地の house は
  確率的に L 字。waterside は矩形固定(張り出しの合成を単純に保つ)。
  区画からのセットバック(前面 0.5 / 側面 0.7 / 背面 0.7 目安)込みで、
  時計回り・自己交差なし
- 向き: `facing` は区画の接道方位を初期値とし、広場に面する場合は
  footprint の 4 軸(接道方位 ± k×90°)のうち広場方向に最も近い軸へ
  スナップする(広場 > 道路 > 水面/水路/橋 の優先)。最後に footprint を
  重心まわりに ±4° × (1 − tidiness) の範囲で揺らす(乱数は
  building サブストリーム。tidiness 高で揺らぎ減)
- floors は Settlement(floorsBias)・Prosperity・役割から 1〜3 の整数。
  roof.pitch は 50〜58 度の連続値。roof.type は L/T footprint で
  "compound"、大型・hall で確率的に "hip"、基本 "gable"
- 接地: 陸上の建物は `foundation.kind = "plinth"`、`bottomY = 0`、
  `plinthHeight` は Prosperity・役割駆動(0.15〜0.9 目安)。
  waterside 建物は背面・左右の3辺(正面=接道側を除く)の中点から 6.0 以内に
  水面(河川・湖)があれば、最も水面に近い辺を水面側へ延長して張り出す
  (水際から 1.6、延長は 7.0 を上限)。張り出した建物は
  `overWater = true`、kind は "piles"(低 Prosperity)または
  "stonebase"(高 Prosperity)、`bottomY = -1.6`(岸スカート下端)とする。
  張り出し延長が他の区画・道路・水路・広場・結界環と衝突する場合は
  張り出さない。水路の上への張り出しは行わない(護岸付きチャネルのため)
- 機械判定可能な接地契約: `overWater = true` ⇔ footprint の頂点の
  いずれかが水面上(河川・湖の waterSdf < 0)。overWater の建物は
  kind ∈ {"piles", "stonebase"} かつ `bottomY = -1.6`(水上に張り出す
  部品は杭または基礎を介して水面下・岸スカート下端まで到達する)。
  overWater でない建物の footprint 頂点はすべて陸上(waterSdf ≥ 0)で、
  水路(中心線距離 − 幅/2)にも重ならない
- パイプライン内アサーション(違反は throw せず件数を console に出す):
  (1) 全建物が接道正面を持つ(親区画の frontEdge と接道 edge の距離)、
  (2) 水上張り出しの杭到達(上記の接地契約)、(3) 建物どうし・水域・
  道路・広場との重なりゼロ(waterside の張り出しは杭前提で水域のみ許容)

建物部品の性質(段12「建物」の commit 13 / PHASE 4b commit 14 分が保証し、
メッシュビルダー・テストが前提としてよい):

- footprint は矩形の翼(wing)へ分解する: 矩形 = 1 翼、T 字 = 前面棟+
  背面中央翼、L 字 = 前面棟+背面隅の翼。翼は footprint のローカル軸
  (接道方位)に整列した軸平行矩形で、揺らぎ回転込みの最終 footprint と
  同じ変換を共有する。従属翼は主翼側へ 0.06 だけ食い込ませ、
  共平面の Z ファイティングを避ける
- 部品の展開は翼ごとに 基壇(plinth。kind "piles" では pile 列)→
  壁体(階数 × 翼)→ 屋根(gable。roof.type "hip" は hip、"compound" は
  翼ごとの gable)の順で、配列順もこの順とする
- 壁体の階高は 3.0 固定(水面の低さ 0.6 = 壁 1 階高の 1/5。
  art-direction 7節)。壁体部品の高さの合計 = floors × 3.0
- 屋根の勾配は `roof.pitch`(50〜58度)を params.pitch にそのまま持ち、
  scale.y = tan(pitch) × scale.z / 2 を満たす。軒の張り出しは
  スパン側 0.65・妻側 0.4(深い軒。art-direction 6節)で、
  建物に付く部品(石垣・外階段を除く)は footprint から 0.9 を超えて
  はみ出さない。ジェッティのある建物では上階壁・屋根・開口が張り出し
  (0.32)ぶんさらに出るため、上限は 1.2 とする
- kind "piles" の杭部品は position.y = -1.6(SHORE_SKIRT_BOTTOM_Y)、
  上端 = 基壇天端。kind "stonebase" は plinth 部品が y = -1.6 から
  立ち上がる(接地契約の部品表現)

PHASE 4b commit 14 の詳細部品の性質(開口・木組み・煙突・付属):

- 部品配列は骨格(翼ごとの 基壇→壁体→屋根)に続けて、
  扉 → 窓 → 梁 → ジェッティ床帯 → 煙突 → 屋根小窓 → 石垣 → 外階段 の順
- 乱数は派生サブストリーム `"building/<id>/details"` のみ消費する
  (骨格・materials の乱数消費は commit 13 から不変。建物ごとの独立
  ストリームのため、建物内の消費数は部品の採否に応じて可変でよい)
- **扉**: 全建物が正面翼(wing 0)の正面面(frontEdge 側、v=0 の面)の
  1階に必ず 1 つ持つ。外向き法線は親区画の facing(±揺らぎ数度)と一致する。
  扉高は役割で差を付ける(warehouse 2.5 / それ以外 2.15。荷入れ口の表現)。
  扉幅は役割帯(house 1.05〜1.25 / hall 1.35〜1.55 / warehouse 1.8〜2.1 等。
  正面幅 −1.0 でクランプ)
- **窓**: 「少なく大きく」(art-direction 6節)。数は面ごとの収容数 ×
  (0.35 + 0.6 × detailAmount) × 役割係数(warehouse 0.35 / outskirt 0.55 /
  hall 1.15 / 他 1.0)。整列は等間隔を基準に ±(1 − detailAmount) × 0.5 の
  揺らぎ(Prosperity 高で整列)。窓高は役割で差を付ける(hall × 1.3 /
  warehouse × 0.8)。位置は壁体部品の側面(壁面)上で、1階正面の扉近傍は
  空ける。翼が 2 つの建物では、正面翼の背面・従属翼の正面(翼どうしの
  接合面)には開口・梁を置かない
- **木組み梁**: `wall = "plaster"` の建物のみ(確率 0.88)。外壁面ごと・
  階ごとに下端横架材+上端横架材+両隅の柱(計 4 本)。材は `wood`
- **ジェッティ**: 木組み建物(梁あり)× 2階以上 × warehouse 以外で
  確率 0.55。正面翼の上階(floor ≥ 1)の壁体 scale/position が正面へ
  0.32 張り出し、屋根も張り出し後の上階寸法に架かる。張り出しの下端に
  `jetty` 床帯を置く
- **煙突**: Prosperity 駆動(採択率 = 役割基礎 + 0.55 × detailAmount。
  hall 高め / warehouse・outskirt 稀)。正面翼の棟線上・棟端から
  引き込んだ位置に置き、胴幅は 0.72 × 1.15(15% 過大)で固定、
  頂部は棟より 0.7〜1.2 高い。材は基壇と同じ(stone / ashlar)
- **屋根の小窓(dormer)**: house / hall / waterside / bridgehead ×
  スパンの広い屋根(軒込みスパン ≥ 4.6)× 確率(0.1 + 0.35 ×
  detailAmount)。正面側の勾配面に 1 つ、材は屋根と同じ
- **低い石垣(fence)**: house / hall × 正面幅 ≥ 3.4 × 確率(0.18 +
  0.4 × detailAmount)。敷地前面帯(建物正面から 0.4 前)に、
  扉前を開けた 2 セグメントで置く。footprint の外・親区画の近傍
  (前面帯)に収まる。材は `stone`
- **外階段(stair)**: 基壇が高い建物(plinthHeight ≥ 0.32。Prosperity・
  役割駆動)× 確率 0.85 で、扉前に地面から基壇天端までの段列を置く。
  正面へ最大 1.2 まで敷地前面帯へ出てよい。材は基壇と同じ
- 小道(lane)の追加(Network 節「小道の性質」)と window / door /
  beam / chimney の InstancedMesh 化(「インスタンス経路のピース分解」)は
  commit 15 で完了。小道は段13 の担当で、建物の部品リスト・乱数消費は
  commit 14 から変わらない

#### 中心建築(PHASE 5a commit 16)

段12「建物」が、一般建物(区画 1:1)の展開後に中心建築 1 棟を
専用の拡張文法で展開し、`buildings` の末尾に追加する。専用段は設けない
(スカイライン検証が「周辺一般建物の最高点」を入力とするため、
一般建物の後・同一段内で生成する)。立体化は PHASE 5a で完成品質
(浮遊要素クラスタの立体化のみ PHASE 5b の担当。中心建築は
towers / gates / shrines と同様に floaters の anchor にはならない=
接続は既存の wards.floaters 計画のまま変更しない)。

- **入力**: `centerPlan`(position / footprint / axes / facing / heightHint)
  と `derived`(centerFootprint / centerHeight / skylineRatio /
  glowAreaCap 等)。部品の配置は centerPlan.footprint(軸平行正方形)に
  内接する facing 向きの正方形 = 使用領域
  (一辺 = centerFootprint × 1/(|cos δ|+|sin δ|) − マージン 1.2。
  δ = facing の 90° 剰余)の中で行い、前庭階段を含む全部品が
  centerPlan.footprint 内に収まる
- **Building フィールド**: id `"building/center"`、parcelId null、
  role `"center"`、facing = centerPlan.facing、floors = 主棟の階数
  (1〜5。一般建物の 1〜3 の例外)、roof = 主棟の屋根
  (翼棟・塔を伴うため合成時は "compound")、materials は支配軸から
  (下表)、foundation は kind "plinth"・bottomY 0
  (footprint 頂点が水面(河川・湖)にかかる場合は接地契約に従い
  kind "stonebase"・bottomY −1.6・overWater true)
- **footprint**: 主棟+翼棟の外形(矩形 4 / L字 6 / U字 8 頂点。
  時計回り・自己交差なし)。中庭・前庭・中庭壁・塔の張り出しは
  footprint に含めない(塔は主棟に接して立つ)。zoneMask の建物上書きは
  一般建物と同じ流儀(石造系 → paved)
- **4軸 → 骨格・装飾**(implementation-spec 1.7節。axes の最大軸が骨格、
  2位軸が装飾傾向。同点は arcane > authority > waterside > rustic の
  固定順で解決):
  - 骨格(最大軸):
    - arcane: 主棟+大魔導塔(細長い塔身 taper 0.8+頂部水晶。
      様式言語 6節の高さの誇張。塔身幅は高さの 1/5 以下)+
      発光開口の列+結界紋様。Monumentality ≥ 0.65 で中庭奥の隅に
      小塔(頂部水晶)2 基
    - authority: 主棟+正面両脇の双塔(尖塔屋根)+正面の薔薇窓+
      整列した尖頭窓(大聖堂・宮殿風)
    - waterside: 主棟(館)+最も水面に近い背面隅の塔(尖塔屋根)。
      屋根は瓦(湖畔の館・川沿いの塔)
    - rustic: 大農家の主棟(茅/木羽・煙突・低層)+物見塔
      (木造・尖り屋根)+低い中庭壁(宿場・物見塔の趣)
  - 装飾(2位軸。スコア ≥ 0.15 のときのみ付加し、微小スコアの
    seed 揺らぎで装飾が跳ばないようにする): arcane → 結界紋様(sigil)と
    発光開口を付加、authority → 薔薇窓・尖頭窓を付加(例:「装飾的な窓と
    大屋根を持つ魔導城」)。waterside / rustic が2位のときは
    付加装飾なし(素の骨格)
  - 共通: 翼棟(Monumentality と敷地規模で 0〜2。U字の中庭を作る)、
    大屋根(勾配 50〜58 度・深い軒)、正面の大扉+前庭階段
    (stair。steps 2〜10)、中庭壁(courtyard-wall)
- **materials**(支配軸 → 基準素材。trim は一般建物と同じ規則
  (石造系 → stone、他 → wood)):

  | 支配軸 | wall | roof |
  |---|---|---|
  | arcane | `stone`(wallTier ≥ 2.2 で `ashlar`) | `slate` |
  | authority | `ashlar` | `slate` |
  | waterside | `stone` | `tile` |
  | rustic | `rough-wood`(wallTier ≥ 0.8 で `plaster`) | `thatch`(roofTier ≥ 1.0 で `shingle`) |

- **中庭**: 中庭壁の内側に kind `"courtyard"` の Plaza を段12 が追加する
  (中庭の奥行きが 6 以上のときのみ。id `"plaza/courtyard"`、polygon は
  壁・主棟から 0.8 内側の矩形、radius は外接円半径。Plaza 節の
  「position 中心の不整形 n 角形」の例外)。描画は既存の広場描画を共用し、
  zoneMask には触れない(段10 は変更しない)
- **スカイライン契約**: 周辺最高点 P = 一般建物の全部品の最高点
  (`position.y + scale.y` の最大。一般建物が無い場合は 0)。
  中心建築の最高点(同じ定義)は `P × derived.skylineRatio` 以上で
  なければならない。生成時に主塔(最も高い塔)の塔身高を
  `max(centerPlan.heightHint, P × skylineRatio × 1.03)` の頂部高まで
  引き上げてこれを満たし、段12 のパイプライン内アサーションが
  事後検証する(違反は throw せず件数を console に出す)
- **発光の規律**(art-direction 5.4節): 発光部品は `crystal` /
  `sigil` / `glow-window` の発光面のみ(発光は青緑=魔法のみ。
  窓明かりの琥珀 emissive は存在しない)。発光開口の開口寸法は
  1 階高(3.0)の 1/3 以下、水晶は幅 1.0 以下の細身。
  発光面積(発光ジオメトリの面積合計。`src/pipeline/center.ts` の
  `glowPartArea` が正)は `glowAreaCap × 箱庭面積(boundary の面積)×
  0.35`(中心建築の取り分。残りは PHASE 5b の結界要素)以下とし、
  超えないよう発光開口・紋様の追加を打ち切る。段12 のアサーションで検証
- **乱数**: 骨格は `"building/center"`、開口・窓の詳細は
  `"building/center/details"` のみ消費する(一般建物のストリームに
  波及しない)。骨格ストリームの消費数は入力に依らず固定
- **一般建物アサーションの例外**: 中心建築は接道正面(親区画なし)と
  道路・広場の重なり検査の対象外(主道は中心へ収束して footprint 下で
  終端し、前庭・基壇の下へ潜る設計判断)。建物どうしの重なり・
  接地契約(overWater ⇔ 頂点の水上)は一般建物と同様に対象

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
