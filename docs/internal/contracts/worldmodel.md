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
// Derived の主要フィールド(詳細は 1.6節。実装時に確定し本書へ反映):
// worldSize(240〜560)、entryPointCount(2〜4)、roadBudget、marginWidth、
// densityPeak/densityFalloff、parcelRate/parcelSize、
// riverCount(0〜2)/riverWidth/lakeChance、canalScore、waterAreaCap(0.35)、
// wardLevel(0〜3)/wallClosure(閉じ率0〜1)、glowBudget(発光面積上限)、
// centerFootprint/centerHeight、skylineRatio(1.8〜3.5)、renderBudget など
```

### Ground(PHASE 2)

```ts
interface Ground {
  size: number;                  // ワールド一辺の実寸
  boundary: Polygon;             // 有機的な外縁形状
  edgeStyle: "fog" | "water";    // 外周の閉じ方(Water 0付近は "fog" 固定)
  zoneMask: ZoneMask;            // 材質ゾーン(草地/土/砂洲/湿地/舗装)のグリッド
}
// ZoneMask はグリッド解像度+セル値(ゾーン種別のブレンド重み)。表現は PHASE 2 で確定
```

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
