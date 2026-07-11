# WorldModel スキーマ契約 — コア(正宣言・全体規約・基本型・Meta)

WorldModel スキーマ契約の一部(2026-07-07 に worldmodel.md から分割)。
本書は正宣言・全体規約(座標系・ID規則・プレーンデータ規約)・基本型
(Vec2/Polygon/Spline)・WorldModel interface・Meta(Params/Derived)の正である。
スキーマの変更はコードより先に本書を更新する。
索引と節→ファイルの対応表は [README.md](README.md) を参照。

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
type Spline = { points: Vec2[]; width: number } // 中心線+幅(水路・道路リボンの元)
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
`entryPointCount`・`pondCount` の丸め閾値にのみ使う
(`makeRng(seed, "derive")`。消費数 2(entryJitter・pondJitter)・
消費順は入力に依らず固定)。
後続PHASEが消費する値も含め、導出は PHASE 2 で完成させる。
draw call 予算等の描画側の規律は導出設定ではなく描画側の定数とする。

> **Phase A 註記**(`plans/2026-07-11-worldgen-rework-water.md`): 下記の
> Water Presence 駆動群(旧 `riverCount` / `riverWidth` → `pondCount` /
> `pondArea` の追加、`lakeChance` / `lakeArea` の数式改訂)は Phase A の
> 決定であり、実装はタスク A3 で追いつく。それまでコードは旧仕様
> (`riverCount` / `riverWidth` と旧数式、seed 揺らぎ名 `riverJitter`)の
> まま動作する(`riverJitter` は `pondJitter` に読み替える)。

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
  pondCount: number;         // 池の数。0〜4(整数。閾値に seed 揺らぎ。Water 0 で必ず 0)
                            // = clamp(round(3.4×water − 0.25 + pondJitter), 0, 4)
  pondArea: number;          // 池1個あたりの目標面積(箱庭面積比)。= lakeArea × 0.18
  lakeChance: number;        // 湖の生成確率。0〜1(Water 0 で 0)。= clamp(1.5×water − 0.2, 0, 1)
  lakeArea: number;          // 湖の目標面積(箱庭面積比)。0.05〜0.21。= 0.05 + 0.16×water
  waterAreaCap: number;      // 水域合計面積の上限(箱庭面積比)。0.35 固定
  canalScore: number;        // 水路発火スコア = Water×(0.5+0.5×Settlement)。0〜1。0.35 以上で発火
  canalWidth: number;        // 水路の幅。= clamp(1.75 + 3.85×water, 2.2, 5)。
                            // 旧仕様(河川の最終幅 × 0.35)と全パラメータ 50 で等価。
                            // 面積クリップとは連動しない
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

