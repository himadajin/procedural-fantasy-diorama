# WorldModel スキーマ契約 — 地面と水系(Ground・Water)

WorldModel スキーマ契約の一部(2026-07-07 に worldmodel.md から分割)。
本書は Ground(ZoneMask を含む)と Water(Shoreline / Canal / BridgeSite・
水系の保証を含む)の正である。
スキーマの変更はコードより先に本書を更新する。
索引と節→ファイルの対応表は [README.md](README.md) を参照。
関連: 地面の舗装色・材質は [materials.md](materials.md) の materialId 語彙と
art-direction を、道路網・水路の交差は [network-plaza.md](network-plaza.md) を参照。

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

