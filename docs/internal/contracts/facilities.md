# WorldModel スキーマ契約 — 施設(Facility)

Phase D(施設。`../plans/2026-07-14-worldgen-rework-facilities.md`)で新設する
契約。本書は `model.facilities`(Facility 配列)のスキーマ・kind ごとの
配置条件・衝突/帯検証則・順序非依存の走査順・RNG ラベル体系・造形の純関数
分離の正である。スキーマの変更はコードより先に本書を更新する。
索引と節→ファイルの対応表は [README.md](README.md) を参照。

**本書が確定するのは構造(どこに・いくつ・どの検証を通るか)のみ**。
造形(部品構成・プロポーション・寸法・色・素材の具体値)は
`../plans/2026-07-14-worldgen-rework-facilities.md` タスク D1b で
`art-direction.md` と本書「kind ごとの造形の性質」節に確定する。
本書内で「D1b で確定」と明記した箇所は、D1a 時点では見出しと項目立て
だけを用意した空欄であり、D2a〜D6 の実装判断には使わない。

関連: `Parcel.kind` は [buildings.md](buildings.md)「Parcel / Building」節が
正(本書は配置条件の入力として参照するのみ)。`model.zoning`(urbanity)は
[network-plaza.md](network-plaza.md)「zoning」節、`Plaza` は同書「Plaza」節、
`Shoreline` は [ground-water.md](ground-water.md)「Shoreline」節を参照。
`model.facilities` 自体のトップレベルスキーマ宣言は
[worldmodel-core.md](worldmodel-core.md)「WorldModel」節を参照(定義は
本書に 1 箇所だけ置く方針。索引冒頭の規約に従う)。

## Facility スキーマ

```ts
interface Facility {
  id: string;                    // 由来から安定(下記 kind 別 id 体系)
  kind: "field" | "pasture" | "well" | "stall"
      | "windmill" | "watermill" | "pier";
  footprint: Polygon;             // 施設の外形。時計回り・自己交差なし
  facing: number;                 // 正面方位(xz 偏角。kind ごとの規約は下記)
  parts: Part[];                  // 造形の純関数(下記「造形の純関数分離」)の出力
  origin: FacilityOrigin;         // 由来メタ(下記)
}
type FacilityOrigin =
  | { type: "parcel"; parcelId: string }                  // field / pasture
  | { type: "plaza"; plazaId: string }                    // well(市街)/ stall
  | { type: "node"; nodeId: string }                      // well(農村)
  | { type: "site"; cellId: string }                      // windmill(候補格子セル)
  | { type: "canal"; canalId: string }                    // watermill(水路沿い)
  | { type: "shore"; shoreLoopId: string; index: number }; // watermill(湖岸沿い)・pier
```

- `footprint` は `Part` の変換規約(buildings.md「Part の変換規約」)と同じ
  座標系(y-up、xz 平面上の多角形)を使う。既存の Building.footprint と
  同じ扱い(親区画・親広場からのはみ出し判定に使う)。
- `facing` の既定規約(kind ごとの上書きは下記「kind 一覧」節):
  施設が単一の帰属領域(区画・広場)を持つ場合は、その領域の代表方向
  (区画は `Parcel.facing`、広場は施設位置から広場 `position` へ向かう方向)
  を既定とする。汀線に接する施設(watermill の湖岸配置・pier)は
  `ShoreLoop.normals` から補間した水域→陸側の法線の**逆向き**(陸→水域)を
  facing とする(桟橋・水車が水面へ向く向き)。水路沿いの watermill は
  水路の中心線に直交する方向(水路→施設側)を facing とする。
- `origin` は施設 1 件の生成根拠を一意に記録する由来メタで、RNG ラベルの
  安定化と衝突検証の「帰属領域」特定に使う(下記「衝突・帯検証則」)。
  `origin.type` は `id` の生成元プレフィックス(下記表)と 1:1 対応する。
- `model.facilities` の配列順序は、下記「順序非依存の走査順」で定めた
  走査順そのもの(kind ごとに固定した順で連結する。field/pasture →
  well → stall → windmill → watermill → pier の順に、各 kind 内は
  下記の走査順)。

## kind 一覧・配置条件

各 kind の「どこに・何が・どの検証を通るか」を確定する。数量・採択率の式は
すべて**提案値**であり、D2a〜D6 の実装・D7 の実測スイープ(C7/T4 方式)で
調整しうる(調整時は本節を同一 commit で更新する。他の提案値と同じ運用)。

### field(畑)・pasture(牧草地)

- **どこに**: 農村ゾーン(`zoning` の urbanity < 0.45)の道路沿いに切られた
  `Parcel.kind === "farmland"` の区画(下記「農地区画」)。1 農地区画につき
  施設 1 件(区画からの単射。residential 区画と異なり、農地区画は
  常に施設を 1 件持つ — buildings.md の全単射契約が residential 限定に
  改訂されるのと対になる規約)。
- **何が**: 区画ごとに `makeRng(seed, "facility/farmland/<parcelId>")` から
  1 回 `chance` で kind を決める(field 既定 0.68、pasture 0.32 — 提案値。
  パラメータには連動させない: 畑と牧草地の**量**の総和は下記の農地区画
  採択率が担い、個々の区画がどちらになるかは局所的な多様性のための
  コイン抽選とする)。
  - field: 畝(平行な低いボックス列)+外周の低い柵(部品構成は D1b)。
  - pasture: 柵+草色の地面パッチ(部品構成は D1b)。
- **量**: 農地区画そのものの採択率(区画を切り出す段階。段11「区画」の
  拡張)を `farmlandRate = clamp(0.25 + 0.55 × (1 − settle), 0.25, 0.8)`
  とする(郊外〈settle 低〉ほど農地が広く、市街化〈settle 高〉が進むほど
  農地は縮小する。計画書 3.3 節「畑の量は (1 − settle) と Scale に駆動」を
  具体化)。World Scale への連動は `derived.parcelCountMax` を介した
  既存の量産式(worldSize が大きいほど農村帯の道路延長・区画候補数が増える)
  で自然に反映されるため、`farmlandRate` 自体に scale 項は持たない。
- **農地区画の寸法帯(提案値)**: 間口 `clamp(2.0 × derived.parcelSize, 24, 55)`、
  奥行き比 1.6(既存 residential の 1.25 より深い畝地)。衝突時の縮小段階
  (`DEPTH_SHRINK_STEPS` 相当)・下限は residential 区画と同じ機構を流用する
  (寸法の帯のみ異なる)。
- **どの検証を通るか**: 農地区画自体は residential 区画と**同一**の衝突検証
  (広場・水域・道路・結界環バッファ・centerPlan 予約・既採択区画・境界外
  マージンとの非重なり。buildings.md「区画の性質」を kind によらず適用)を
  通る。施設 footprint は区画 `polygon` に一致させる(区画 = 施設の帰属
  領域そのもの)。畝・柵の parts は下記「衝突・帯検証則」の帯内。

### well(井戸)

- **どこに**: (a) 市街の広場(`Plaza.kind` が `"center"` または
  `"crossing"`。courtyard・gate・bridgehead は対象外 — 生活の核は表の
  広場のみという 3.4 節の設計判断を井戸にも適用する)に最大 1 基。
  (b) 農村の道路ノード(`network.nodes` のうち urbanity < 0.45 の位置、
  degree ≤ 2 かつ広場・区画前面帯と重ならないノード)近傍に散発。
- **何が**: 石環+柱+小屋根の小構造(部品構成は D1b)。
- **量**:
  - 広場: `wellRate = clamp(0.3 + 0.6 × settle, 0.3, 0.9)`(市街化が進むほど
    広場に井戸が生活の核として定着しやすい)。対象広場ごとに独立抽選。
  - 農村ノード: 候補ノードごとに `ruralWellRate = clamp(0.05 + 0.35 × settle, 0.05, 0.4)`
    で抽選し、採択総数は `ruralWellCountMax = ceil(2 + 4 × settle)` を上限とする
    (上限到達後の候補は棄却。区画の `parcelCountMax` 打ち切りと同じ流儀)。
- **どの検証を通るか**: 広場井戸は広場 `polygon` の内側かつ下記「衝突・帯
  検証則」の広場縁帯・通行帯を満たす位置(屋台と同じ帯の外側 = 広場中心寄り
  1 点)。農村井戸は道路・区画・水域・広場・結界環バッファと非重なり
  (下記の汎用クリアランス)。

### stall(市場屋台)

- **どこに**: 市街の広場のうち `Plaza.kind` が `"center"` または
  `"crossing"` のみ(courtyard・gate・bridgehead は対象外。3.4 節)。
  広場の**縁に沿って**列で配置し、広場の中央と道路接続の通り道は空ける。
- **何が**: 木組みの小構造(柱+天幕屋根+台。部品構成は D1b)を 1 広場に
  複数(列)。
- **量**: 対象広場ごとに `stallCount = round(clamp(3 + 9 × prosper, 3, 12))`
  (提案値。繁栄度が屋台の数を直接駆動する 3.4 節の規定を具体化)。
- **どの検証を通るか**: 下記「衝突・帯検証則」の広場縁帯・通行帯(中央円+
  接続方向セクター除外)。列は縁帯を等間隔で走査し、通行帯に当たる候補は
  スキップする(決定論。乱数は個々の屋台の向き・部品バリエーションにのみ
  使い、配置スロットの採否には使わない — 屋台は「列を敷き詰める」設計で
  数量式が総数を決めるため、抽選による棄却は行わない)。

### windmill(風車)

- **どこに**: 農村ゾーン(urbanity < 0.45)の外縁寄りの空白(区画・道路・
  水域・広場から下記の汎用クリアランス以上離れた地点)。丘のない平坦地形の
  前提により、地形条件での絞り込みは不要。
- **何が**: 塔+羽根の構造(部品構成は D1b)。
- **量**: `windmillCount = round(clamp((0.4 + 0.6 × prosper) × (0.5 + 0.5 × scale) × 2, 0, 2))`
  (提案値。0〜2 基。繁栄度・World Scale の両方が数を弱く押し上げる
  3.5 節の規定を具体化)。
- **候補地**: 農村ゾーンの外縁帯(`marginWidth × 0.3 ≤ boundarySdf < marginWidth × 1.8`
  かつ urbanity < 0.45)に一辺 `WINDMILL_CELL`(提案値: `marginWidth`)の
  粗い格子を張り、下記「順序非依存の走査順」の順でセルを走査して
  クリアランスを満たす最初の `windmillCount` 個を採択する(乱数は
  採否そのものには使わず、格子内ジッターと造形にのみ使う — 数量式が
  既に総数を決めるため)。
- **どの検証を通るか**: 下記「衝突・帯検証則」の汎用クリアランス。加えて
  水域からのクリアランスは通常の 1.0 帯ではなく `NEAR_WATER` 相当の 4.5
  (parcels.md 同名定数と同じ値。水辺は watermill の担当であり windmill は
  避ける)。

### watermill(水車)

- **どこに**: 水路(`water.canals`)の中心線沿い、または湖・池の岸線
  (`water.shoreline.loops`)に接する位置。水域横断はしない。
- **何が**: 小屋+水輪の構造(部品構成は D1b)。
- **量**: `watermillCount = round(clamp((0.3 + 0.7 × water) × 2, 0, 2))`
  (提案値。0〜2 基。Water Presence が数を駆動する 3.5 節の規定を具体化)。
  水路沿い・湖岸沿いのどちらに何基配分するかは、両方の候補を下記の走査順で
  連結した 1 つの候補列から先頭 `watermillCount` 件を採るため、水路の有無・
  岸線長に応じて自然に配分される(乱数消費なし)。
- **どの検証を通るか**: 下記「衝突・帯検証則」の汎用クリアランス。水域との
  関係は例外(接する側の 1 辺は水域に接してよい。水面上に本体は置かない —
  footprint 頂点はすべて陸上〈waterSdf ≥ 0〉、水路は中心線距離 − 幅/2 ≥ 0)。

### pier(桟橋)

- **どこに**: `water.shoreline.loops` に沿い、waterside 建物の近傍または
  市街に近い岸(urbanity が相対的に高い側)。
- **何が**: 杭+板(既存 `pile` / `deck` 部品の流用。D1b で寸法確定)。
- **量**: `pierCount = round(clamp(1 + 3 × water, 0, 4))`(提案値。0〜4 基)。
- **どの検証を通るか**: 桟橋は水辺拡張(waterfront デッキ・張り出し部屋)の
  `claimed` 領域検査に**参加する**(下記「waterfront claimed 検査への参加」)。
  橋(bridges)・水路とも重ならない(bridgeSite からのクリアランス、
  水路中心線からのクリアランス)。他の桟橋とも `PIER_SPACING`(提案値 8.0。
  実寸)以上離す(岸沿いに桟橋が密集しない)。

## 衝突・帯検証則

SITE_PART_TYPES(buildings.md「建物部品の性質」。`fence` / `stair` 等の
footprint 外・親区画近傍に置かれる部品の 1.2 帯検証)を施設版へ一般化する:

- **施設 parts の footprint 帯**: 施設の全 `parts` は、その施設の
  `footprint` から **0.9** を超えてはみ出さない(建物の一般部品と同じ
  上限をそのまま流用)。
- **施設 footprint の帰属領域帯**: 施設が単一の帰属領域(farmland 区画・
  広場)を持つ kind(field / pasture / well〈広場〉/ stall)は、
  `footprint` の全コーナーがその帰属領域(区画 `polygon` / 広場
  `polygon`)から **1.2** 帯内に収まる(SITE_PART_TYPES の親区画 1.2 帯の
  一般化)。field / pasture は帰属領域 = footprint そのものであるため
  自明に満たす。well(広場)/ stall は広場 polygon の内側かつこの帯内。
- **広場縁帯・通行帯**(well〈広場〉/ stall 専用。3.4 節「屋台は広場の縁に
  沿い、中央と道路接続の通り道は空ける」の契約化): 広場 `polygon` の
  内側を、(1) 広場縁からの距離が `PLAZA_EDGE_BAND`(提案値 1.0)〜
  `PLAZA_EDGE_BAND × 2.5` の「縁帯」、(2) 広場 `position` 中心の半径
  `radius × 0.45`(提案値)の「中央円」、(3) 広場に接続する道路 edge の
  各流入方位を中心に ±20°(提案値)の「通行帯セクター」の 3 領域に分ける。
  stall は縁帯かつ通行帯セクター外にのみ置ける。well(広場)は縁帯より
  内側(中央円の外・通行帯セクター外)の 1 点に置く(屋台の列と重ならず、
  かつ広場の生活の核として中央寄りに立つ)。
- **帰属領域を持たない kind(windmill / watermill / pier)の汎用
  クリアランス**: footprint の全プローブ点(建物・区画の衝突検査と同じ
  頂点+辺中点+中心のサンプリング)が、次のいずれとも重ならない:
  (1) 他の区画(farmland 含む)= `FRONT_GAP` 相当 1.0、(2) 道路 = 全 edge
  の path から `edge.width/2 + 1.0`、(3) 広場 polygon から 1.0、
  (4) 既採択の他施設の footprint から 1.0(施設どうしの重なり回避。
  同一走査内で先に採択された施設も対象)、(5) 結界環バッファ
  (`ringPath` への近接・交差。wardLevel ≥ 1)、(6) `centerPlan.footprint`
  から 1.5、(7) `ground.boundary` の外(マージン 2。区画の境界外マージンと
  同値)。水域とのクリアランスは kind ごとの例外(windmill は 4.5 で回避、
  watermill/pier は隣接が前提のため対象外 — 上記「kind 一覧」節の該当項)。
- **waterfront claimed 検査への参加(pier)**: 段12「建物」の水辺拡張
  (buildings.md「水辺建築の拡張」)は、建物ごとの水面側拡張領域を
  `claimedRegions`(領域+所有者インデックス)へ登録し、後続の拡張候補が
  既存の claimed 領域と重なる場合は拡張を諦める調停を行う。facilities 段は
  buildings 段より後に走るため(下記「順序非依存の走査順」・pipeline.md
  段順)、この時点で `claimedRegions` は建物側について確定済みである。
  pier は自分の footprint(杭+板の外形)を、確定済みの `claimedRegions` の
  全領域(所有者を問わず全件。pier どうしの調停は上記「他の施設の footprint
  から 1.0」で別途行う)と重ならないことを検証してから採択する
  (buildings 側の `claimedRegions` 配列自体には追記しない — 桟橋の追加が
  建物側の生成結果に影響を与えない決定論的な片方向参照とする)。

## 順序非依存の走査順

生成順序が採択結果に依存しないよう、各 kind は次の安定順で候補を走査する
(乱数消費順もこの走査順に従う。`Object.keys` などの環境依存順序は
使わない。RNG API 節の規約と同じ):

- **field / pasture**: 農地区画の `parcels` 配列内での出現順
  (= `Parcel.id` の生成順。段11 の既存走査順をそのまま継承)。
- **well(広場)/ stall**: `plazas` 配列内での出現順(= `Plaza.id` の
  生成順。段9 の既存走査順をそのまま継承。「広場 id 順」)。
- **well(農村ノード)**: `network.nodes` 配列内での出現順(id 生成順)。
- **windmill**: 候補格子セルを z 外側 → x 内側の順で走査する
  (vegetation の格子走査 `VEG_CELL` と同じ規約。`id` はセル由来で安定
  `facility/windmill/<ix>_<iz>`)。
- **watermill**: 水路候補(`water.canals` 配列順)→ 湖岸候補
  (`water.shoreline.loops` 配列順、各ループ内は `points` の点列順)の順に
  連結した 1 本の候補列を走査する(「汀線ループ順」)。
- **pier**: `water.shoreline.loops` 配列順、各ループ内は `points` の点列順
  (「汀線ループ順」)。

各 kind 内の走査順で候補を評価し、棄却された候補も(区画のスロット連番と
同じ思想で)走査位置を消費する。ただし施設の候補走査は乱数を消費しない
決定論的な地理条件(帰属領域・グリッド・ループ順)のみで駆動されるため、
区画のような「棄却候補もスロット番号を消費する」ための特別な配慮は
不要(走査順そのものが候補データの配列順から一意に定まる)。

## RNG ラベル体系

新設ストリーム `"facility/<...>"` のみを消費する。既存段・既存ストリーム
(`"parcel/<id>"`・`"building/<id>"`・`"vegetation/<ix>_<iz>"` 等)の
消費列は変えない。

| kind | ストリームラベル | 消費内容 |
|---|---|---|
| field / pasture | `facility/farmland/<parcelId>` | kind 抽選(chance) 1 回 + 造形(D1b) |
| well(広場) | `facility/well/<plazaId>` | 採否抽選(chance) + 位置ジッター + 造形 |
| well(農村) | `facility/well/<nodeId>` | 採否抽選(chance) + 造形 |
| stall | `facility/stall/<plazaId>` | 列内の各屋台の造形バリエーション(連番消費。個別屋台の独立ストリームは持たない — 列全体が 1 施設群として同一広場に属するため) |
| windmill | `facility/windmill/<ix>_<iz>` | 格子内ジッター + 造形 |
| watermill | `facility/watermill/<canalId>` または `facility/watermill/shore/<shoreLoopId>/<index>` | 位置ジッター + 造形 |
| pier | `facility/pier/<shoreLoopId>/<index>` | 位置ジッター + 造形 |

- `id` は `origin` から一意に導出する(表は上記「Facility スキーマ」の
  `FacilityOrigin` と対応): `facility/field/<parcelId>` /
  `facility/pasture/<parcelId>` / `facility/well/<plazaId>` /
  `facility/well/<nodeId>` / `facility/stall/<plazaId>/<n>`(列内連番 n。
  0 起点) / `facility/windmill/<ix>_<iz>` /
  `facility/watermill/<canalId>` または `facility/watermill/shore/<shoreLoopId>/<index>` /
  `facility/pier/<shoreLoopId>/<index>`。
- リトライを含む処理があれば(現時点の設計では想定していない)、
  RNG API 節の規約どおりリトライ回数も同一サブストリームから消費する。

## 造形の純関数分離(ギャラリー対応の前提)

施設 kind ごとの造形(部品合成)は、**「入力(寸法・素材・当該施設の rng
サブストリーム)→ `Part[]`」の純関数**として実装し、配置ロジック(どこに・
いくつ置くか。上記「kind 一覧・配置条件」)から分離する。

- 各 kind に対応する 1 つの純関数を `src/pipeline/facilities.ts`(または
  同モジュール配下)に持つ(例: `buildFieldParts(input) => Part[]`、
  `buildWindmillParts(input) => Part[]` 等。関数名・ファイル分割の具体は
  D2b 以降の実装判断とし、本契約は「配置と造形が別関数である」ことのみを
  固定する)。
- 純関数の入力は、当該施設の footprint 寸法・向き・素材選択に必要な
  導出値(`Derived` 由来の階層値等)・当該施設専用の rng サブストリーム
  (上記「RNG ラベル体系」)に限る。他の施設・建物・区画の実データを
  直接参照しない(独立性は buildings.md の `"building/<id>"` 単位の
  独立性と同じ設計)。
- 配置ロジック(下記の走査・衝突検証・数量式)は、この純関数を呼ぶ**前**に
  位置・footprint・facing を確定し、造形関数は与えられた footprint に
  収まる parts を返すことだけを担当する(造形関数自身は衝突検証を行わない)。
- **ギャラリーはこの本番の造形関数(と本番の `buildWorld`)だけを呼ぶ**
  (pipeline.md「ギャラリー生成エントリ」節の契約と同一原則)。ギャラリー
  専用の施設造形コード・専用メッシュ生成を新設することを禁止する。
  施設の対象idは `facility/<kind>`(pipeline.md「ギャラリー生成エントリ」
  節「将来の拡張」に記載済み)とし、対象化(ギャラリーの対象一覧・URL
  ルーティングへの追加)自体は D2b 以降の各実装タスクで kind ごとに行う
  (D1a は本契約の確定のみで、ギャラリー側のコード変更は行わない)。

## kind ごとの造形の性質(D1b で確定)

以下は D1b(施設の造形仕様)が埋める枠。D1a 時点では見出しのみを用意し、
寸法・色・素材の具体値は一切書かない。

### field(畑)

- 畝の構成・間隔・高さ(D1b)
- 外周柵の構成・高さ(D1b)
- 素材(D1b。art-direction.md 追記予定)

### pasture(牧草地)

- 柵の構成(D1b。field と共通部分・差分)
- 地面パッチの表現(D1b)

### well(井戸)

- 石環・柱・小屋根の構成・寸法(D1b)
- 素材(D1b)

### stall(屋台)

- 柱・天幕屋根・台の構成・寸法(D1b)
- 天幕の色・素材のバリエーション(D1b。art-direction.md 追記予定)

### windmill(風車)

- 塔・羽根の構成・寸法・taper(D1b)
- 羽根の枚数・配置(D1b)
- 素材(D1b)

### watermill(水車)

- 小屋・水輪の構成・寸法(D1b)
- 水輪の直径・軸位置(D1b)
- 素材(D1b)

### pier(桟橋)

- 杭・板の構成・寸法(D1b。既存 `pile` / `deck` 部品の流用範囲)
- 素材(D1b)

## 表示演出(風車・水車の回転)

風車の羽根・水車の水輪のゆっくりした回転は、viewer 側の表示演出として
許容する(`../specs/design.md`「扱わないもの」節の表示演出許容リストに
明記済み — 水面の揺らぎ・浮遊要素の上下動・魔法光の明滅と同じ扱い)。
WorldModel(`Facility.parts` の `windmill` / `watermill` に対応する新
part type)には回転軸・半径などの**静的ジオメトリのみ**を持ち、回転角度・
位相などの時間依存の値は一切持たない(worldmodel-core.md「全体規約」の
時間・表示状態非持ち込み規約と整合)。回転の速度・振幅などの演出数値は
art-direction.md が正とし、D1b で確定する。
