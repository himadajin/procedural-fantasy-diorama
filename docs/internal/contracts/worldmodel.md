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
- 座標系: y-up。地面は y=0 の平面。水面は y=-0.6(implementation-spec 1.8節)。
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
  edgeStyle: "fog" | "water";    // 外周の閉じ方(水系段が確定。Water 0付近は "fog" 固定)
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
  canals: Spline[];              // 街中の水路。PHASE 3 で計画(PHASE 2 では空)
  bridges: BridgeSite[];         // 道路×水域の交差区間。PHASE 3 で抽出
  shoreline: Shoreline;          // 岸線(岸スカート・湿地/砂洲マスクの元)
}
interface BridgeSite {
  id: string;
  position: Vec2; angle: number; // 交差中心と道路方向
  width: number; length: number; // 道路幅と渡り長
  over: "river" | "lake" | "canal";
  roadClass: RoadClass;          // 石造/木橋の選択に使う(PHASE 5b)
}
```

### Density(PHASE 3 で primary、PHASE 4a で final)

```ts
interface Density {
  primary: FieldGrid;            // 中心距離+道路近接+Settlement。結界に依存しない
  final: FieldGrid;              // primary+結界内ブースト。区画選別に使う
}
// FieldGrid はグリッド解像度+float値。表現は PHASE 3 で確定
```

### Network(PHASE 3、小道の追加は PHASE 4b)

```ts
type RoadClass = "main" | "connector" | "lane"; // 主道/接続路/小道
interface Network {
  nodes: { id: string; position: Vec2 }[];
  edges: { id: string; from: string; to: string;
           class: RoadClass; width: number;
           path: Vec2[];         // 経路の折れ線(A*の結果を平滑化)
           grade: number }[];    // 等級(土/砂利/石畳。Prosperity駆動)
  entryPoints: { id: string; position: Vec2 }[]; // 外縁の進入点(2〜4)
}
```

### Plaza(PHASE 3)

```ts
interface Plaza {
  id: string;
  kind: "center" | "gate" | "bridgehead" | "crossing" | "courtyard";
  position: Vec2; radius: number;
  polygon: Polygon;              // 舗装領域
}
```

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
