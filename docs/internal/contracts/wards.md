# WorldModel スキーマ契約 — 結界(Wards・立体化)

WorldModel スキーマ契約の一部(2026-07-07 に worldmodel.md から分割)。
本書は Wards(結界計画)と、結界構造の立体化(PHASE 5b commit 17)・
魔法灯・浮遊要素・橋の立体化(commit 18)の正である。
スキーマの変更はコードより先に本書を更新する。
索引と節→ファイルの対応表は [README.md](README.md) を参照。
関連: 立体化が用いる Part の型語彙・変換規約は [buildings.md](buildings.md)、
発光部品の materialId は [materials.md](materials.md) を参照。

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
  「境界−外縁マージン」以下にクランプする。水域(湖・池・水路)は
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
  | lake / pond | roadClass "main" かつ roadGrade ≥ 0.9 | 石造アーチ橋 |
  | lake / pond | 上記以外(connector・低 Prosperity) | 木橋(桁+杭橋脚) |
  | canal | roadGrade ≥ 0.9 | 水路の小橋(石。桁+欄干+袂の石座) |
  | canal | roadGrade < 0.9 | 水路の小橋(木。同上、木部) |

- **湖・池の橋**: 道路リボンが岸で止めた渡り区間を橋が受け持つ。
  渡り区間の標本化は道路リボン(mesh/paving.ts)と**同一**の
  `waterCrossings(edge.path, field.waterSdf, 2.0)`(model/geometry.ts。
  lakes/ponds の waterfield、標本間隔 2.0)を共用し、取り付きに
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
  水面(湖・池 −0.6 / 水路 +0.04)、(4) 橋脚(pile・arch)の
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

