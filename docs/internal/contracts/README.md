# contracts/ 索引

`contracts/` はモジュール間インターフェース(WorldModel スキーマと生成
パイプラインの規律)の正である。WorldModel スキーマの正は、2026-07-07 に
ドメイン別へ分割した以下のファイル群が持つ(旧 `worldmodel.md` はスタブ)。

定義(数値・規則本文)は各契約ファイルに1箇所だけ置く。本索引には定義を
書かない。分割前の変更履歴は `git log` の旧パス(`worldmodel.md`)を参照する。

## 契約ファイルと正の範囲

| ファイル | 正の範囲 |
|---|---|
| [worldmodel-core.md](worldmodel-core.md) | WorldModel の正宣言・全体規約(座標系・ID規則・プレーンデータ規約)・基本型(Vec2/Polygon/Spline)・WorldModel interface・Meta(Params/Derived) |
| [ground-water.md](ground-water.md) | Ground(ZoneMask を含む)・Water(Shoreline / Canal / BridgeSite・水系の保証を含む) |
| [network-plaza.md](network-plaza.md) | Density(FieldGrid)・zoning(市街度。Phase B)・Network(street の有機成長・小道を含む)・Plaza・CenterPlan |
| [wards.md](wards.md) | Wards(結界計画)・結界構造の立体化(commit 17)・魔法灯・浮遊要素・橋の立体化(commit 18) |
| [buildings.md](buildings.md) | Parcel・Building・Part の変換規約・Part の型語彙(全 commit 分)・インスタンス経路のピース分解・中心建築・水辺建築の拡張 |
| [materials.md](materials.md) | Part の `materialId` の語彙(基準色。art-direction 5.1節と同期) |
| [vegetation-summary.md](vegetation-summary.md) | Vegetation・Summary |
| [pipeline.md](pipeline.md) | 生成パイプラインの段構成・段契約・乱数サブストリーム・正規化ハッシュ |
| [worldmodel.md](worldmodel.md) | スタブ(分割済み。恒久保持。定義を持たない) |

## 旧 worldmodel.md の節 → 新ファイルの対応表

| 旧 worldmodel.md の節 | 移動先 |
|---|---|
| 冒頭の正宣言 | worldmodel-core.md |
| `## 全体規約` | worldmodel-core.md |
| `## 基本型` | worldmodel-core.md |
| `## WorldModel` | worldmodel-core.md |
| `### Meta(導出設定。PHASE 2〜)` | worldmodel-core.md |
| `### Ground(PHASE 2)`(ZoneMask を含む) | ground-water.md |
| `### Water(PHASE 2、canals と橋の追加は PHASE 3)`(Shoreline / Canal / BridgeSite・水系の保証を含む) | ground-water.md |
| `### Density(PHASE 3 で primary、PHASE 4a で final)` | network-plaza.md |
| `### Network(PHASE 3、小道の追加は段13「小道」= PHASE 4b)` | network-plaza.md |
| `### Plaza(PHASE 3)` | network-plaza.md |
| `### CenterPlan(PHASE 3 で2段階確定、立体化は PHASE 5a)` | network-plaza.md |
| `### Wards(PHASE 3 で計画、立体化は PHASE 5b)` | wards.md |
| `#### 結界構造の立体化(PHASE 5b commit 17)` | wards.md |
| `#### 魔法灯・浮遊要素・橋の立体化(PHASE 5b commit 18)` | wards.md |
| `### Parcel / Building(PHASE 4a、部品の拡張は PHASE 4b・5a)` | buildings.md |
| `#### Part の変換規約(PHASE 4a commit 13 で確定)` | buildings.md |
| `#### Part の型語彙` | buildings.md |
| `#### インスタンス経路のピース分解(PHASE 4b commit 15 で確定)` | buildings.md |
| `#### materialId の語彙(基準色は art-direction 5.1節)` | materials.md |
| `#### 中心建築(PHASE 5a commit 16)` | buildings.md |
| `#### 水辺建築の拡張(PHASE 6 commit 19)` | buildings.md |
| `### Vegetation(PHASE 6 commit 20)` | vegetation-summary.md |
| `### Summary(PHASE 7 commit 21 で確定。中間PHASEでは部分的に埋まる)` | vegetation-summary.md |
