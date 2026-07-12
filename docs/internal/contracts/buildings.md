# WorldModel スキーマ契約 — 建築(Parcel・Building・Part)

WorldModel スキーマ契約の一部(2026-07-07 に worldmodel.md から分割)。
本書は Parcel・Building・Part の変換規約・Part の型語彙(全 commit 分)・
インスタンス経路のピース分解・中心建築・水辺建築の拡張の正である。
スキーマの変更はコードより先に本書を更新する。
索引と節→ファイルの対応表は [README.md](README.md) を参照。
関連: Part の `materialId` の語彙(基準色)は [materials.md](materials.md)、
結界・橋の Part 展開は [wards.md](wards.md) を参照。

### Parcel / Building(PHASE 4a、部品の拡張は PHASE 4b・5a)

> **Phase C 註記**(`plans/2026-07-12-worldgen-rework-layout.md`): 下記の
> `Parcel.groupId` / `Building.spanParcelIds`、「区画グループとクラスタ
> パターン」節以降の連棟・中庭型・雁行・裏庭・同型連続の抑制・floors の
> urbanity 項、および「1:1」を「全採択区画はちょうど 1 棟に帰属する」へ
> 改める記述は Phase C の決定であり、実装はタスク C2(groupId)〜
> C6(裏庭)で追いつく。それまでコードは旧仕様(groupId なし、建物は
> 区画と厳密 1:1、floors に urbanity 項なし、クラスタ語彙なし)のまま
> 動作する。

```ts
interface Parcel {
  id: string;                    // "parcel/<roadEdgeId>/<L|R>/<slot>"。位置・edge 由来で安定
  roadEdgeId: string;            // 接道する道路 edge の id
  polygon: Polygon;              // 敷地(間口×奥行きの矩形)。時計回り・自己交差なし
  frontEdge: [Vec2, Vec2];       // 接道辺(接道 edge 側の2頂点。接線方向昇順)
  facing: number;                // 正面方位(xz 偏角。敷地から接道 edge の中心線へ向かう方向)
  waterside: boolean;            // 湖・池の岸沿い(下記の判定基準)
  canalside: boolean;            // 水路沿い(同)
  groupId: string;                // "block/<roadEdgeId>/<L|R>/<runIndex>"。区画グループ
                                 // (Phase C。下記「区画グループとクラスタパターン」)
}
interface Building {
  id: string;                    // "building/<parcelId の parcel/ 以降>"。区画由来で安定
  parcelId: string | null;       // 中心建築は null(centerPlan に立地。PHASE 5a)。
                                 // 一般建物は主区画(連棟は列の先頭。Phase C)
  spanParcelIds: string[];       // 建物が帰属する全区画 id(先頭 = parcelId)。
                                 // 単棟は長さ 1(= [parcelId])、連棟は列の全区画
                                 // (Phase C。下記「連棟(rowhouse)の性質」)
  role: "house" | "waterside" | "bridgehead" | "hall"
      | "warehouse" | "outskirt" | "center";
  footprint: Polygon;            // 矩形/L字/T字。セットバック込み。時計回り・自己交差なし
                                 // (中心建築は主棟+翼棟の外形。矩形/L/U。下記「中心建築」。
                                 // 連棟は区画列を貫く帯状矩形。下記「連棟(rowhouse)の性質」)
  facing: number;                // 正面方位(xz 偏角。広場 > 道路 > 水面の優先+揺らぎ込み)
  floors: number;                // 階数。1〜3 の整数(urbanity ≥ 0.75 の建物のみ 4。
                                 // 中心建築の主棟のみ 1〜5。Phase C 註記は下記「floors の改訂」)
  roof: { type: "gable" | "hip" | "compound"; pitch: number };
                                 // pitch は度数(50〜58。art-direction 6節)
  foundation: Foundation;        // 接地(基壇・杭・石基礎)。段12の骨格データ(commit 12)
  materials: { wall: string; roof: string; trim: string }; // 素材ID(パレットはart-direction 5節)
  parts: Part[];                 // 建築部品の展開結果
}
interface Foundation {
  kind: "plinth" | "piles" | "stonebase"; // 基壇 / 杭 / 石基礎
  plinthHeight: number;          // 基壇の立ち上がり高(y=0 から。Prosperity・役割駆動)
  overWater: boolean;            // footprint が水面(湖・池)上に張り出すか
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

PHASE 6 commit 19 の追加語彙(水辺建築の拡張。詳細は下記
「水辺建築の拡張」):

| type | 経路 | 形状 | scale の意味 | params |
|---|---|---|---|---|
| `deck` | マージ(躯体) | 杭支持デッキの床板(水側へ張り出す木の直方体) | 幅(岸線方向)×床厚(0.22)×奥行き | `waterfront`: 1 |

- 再利用する既存語彙: `pile`(デッキ杭。y = −1.6 からデッキ床下端まで)/
  `beam`(欄干の柱・手すり、杭の繋ぎ梁、張り出し部屋の持ち送り)/
  `wall` + `gable` + `window`(張り出し部屋)/ `door`(デッキへの
  出入り口・水路裏口)/ `stair`(裏口の段)。
  水辺拡張の部品はすべて `params.waterfront = 1` を持ち、
  既存部品の性質(正面扉の一意性、木組み梁の plaster 連動、杭上端 =
  基壇天端、footprint はみ出し上限)の機械判定から区別できる


`materialId` の語彙(基準色表)は [materials.md](materials.md) を正とする。

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
  (Phase C で `Parcel.groupId` を追加。上記「区画グループとクラスタ
  パターン」)
- 段12「建物」のうち、`id` / `parcelId` / `role` / `footprint` / `facing` /
  `floors` / `roof` / `foundation` は commit 12 が埋める
  (Phase C で `Building.spanParcelIds` を追加。上記「連棟(rowhouse)の
  性質」)。
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
  (2) 水面 = 湖・池(waterfield の waterSdf)+水路(中心線距離 − 幅/2)、
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
  中心1+内部4 の 13 点。衝突棄却と共通)の最小距離で、湖・池の
  waterSdf < 4.5 なら waterside、水路の(中心線距離 − 幅/2)< 4.5 なら
  canalside
- 乱数は区画ごとの独立サブストリーム `"parcel/<id>"` のみ消費する
  (奥行き揺らぎ・採択ロール。生成順序の変更が他区画へ波及しない)

#### 区画グループとクラスタパターン(段11 後処理・段12 配置。Phase C)

> **Phase C 註記**(`plans/2026-07-12-worldgen-rework-layout.md`): 本節は
> Phase C の決定であり、実装はタスク C2(`groupId` の導入)・C4(パターン
> 抽選と雁行・中庭型の配置)で追いつく。それまでコードは区画グループを
> 持たず、全区画が単棟パターンとして扱われる。

- **区画グループ(`Parcel.groupId`)**: 同一 `roadEdgeId`・同一側(L/R)で、
  スロット連番が連続して採択された区画の並び(run)を 1 グループとする。
  導出は採択済み区画からの決定論的な後処理であり、区画の採択そのもの
  (上記「区画の性質」の既存ロジック)は変えない。乱数は消費しない。
  `id` は `"block/<roadEdgeId>/<L|R>/<runIndex>"`(`runIndex` はその
  edge・side 内のグループ通し番号。0 起点)。棄却された候補もスロット
  連番は消費するが、グループの連続判定には数えない(採択済みどうしの
  隣接スロットのみを連続と見なす)。前後が非採択の孤立区画も長さ 1 の
  グループになる(クラスタパターン抽選の対象になり、高い確率で単棟に
  採択されるだけで、グループ非適用にはしない)
- **クラスタパターンの抽選**: グループごとに
  `makeRng(seed, "layout/<groupId>")` の独立サブストリームでパターンを
  1 つ抽選する(固定消費)。候補と条件、採択率(提案値。C7 で調整しうる):

  | パターン | 条件 | 採択率(提案値) |
  |---|---|---|
  | 連棟(rowhouse) | グループ長 ≥ 3、urbanity ≥ 0.6、role が house 系に揃う区画列、waterside/canalside 区画を含まない | `clamp(0.2 + 0.6×settle, 0, 0.75)` |
  | 中庭型(courtyard) | グループ長 3〜5、奥行き余裕あり | `0.12 + 0.28×prosper` |
  | 雁行(stagger) | グループ長 ≥ 2 | 上記の条件に外れた残りに `0.45` |
  | 単棟(現行) | 常に可 | 残り全部 |

  条件を満たさないパターンは候補から除外し、残る候補の採択率で正規化して
  抽選する(候補が単棟のみのときは確率 1 で単棟になる)
- **要素独立乱数との両立**: グループ内の各建物は従来どおり
  `"building/<id>"` の独立サブストリームで役割・形状・素材・向き・階数を
  決める(隣接建物の出力を参照しない規約は温存する)。クラスタパターンは
  各建物の生成に「配置パラメータ(セットバック・向き・footprint の
  制約)」として入力されるだけで、要素の乱数消費順・要素独立性は変えない

#### 連棟(rowhouse)の性質(Phase C)

> **Phase C 註記**(`plans/2026-07-12-worldgen-rework-layout.md`): 本節は
> Phase C の決定であり、実装はタスク C5 で追いつく。それまでコードは
> 連棟パターンを生成せず、全区画が単棟である。

- 連棟は「壁を共有する複数棟」ではなく、**k 個の連続区画を貫く 1 つの
  `Building`** として生成する。`footprint` は区画列を貫く帯状矩形
  (区画列の接道方向へ長辺を通す)。`Building.parcelId` は列の先頭区画、
  `Building.spanParcelIds` は列の全区画 id(先頭から順、長さ k)を持つ
- ファサードは住戸ごとに分節する: 住戸ごとに扉 1・窓列・煙突(採択率は
  下記「建物部品の性質」と同じ規約)を配置し、住戸境界には分節縦梁
  (既存 `beam` 部品)を通す
- 屋根は連続 gable(棟通し)とし、妻は列の両端のみに作る(中間の住戸
  境界に妻を作らない)。住戸ごとに屋根材の明度をわずかに変え(個体差の
  既存機構を住戸単位に適用し)、単調な一枚屋根に見せない
- 階数は列で統一する(区画列の代表階数を 1 つ決める)。ただし端部の住戸に
  限り −1 階を確率 0.3(提案値)で許容し、単調な直方体を避ける
- **waterside / canalside 区画を含むグループでは連棟を組まない**(水上
  張り出し・水路裏口の水辺拡張と干渉させない。上記クラスタパターン表の
  連棟の条件に明記済み)
- **「1:1」の改訂**: 本書のこれまでの「建物は区画と 1:1」という記述は、
  「**全採択区画はちょうど 1 棟に帰属する**(単棟 = 1 区画 1 棟、連棟 =
  k 区画 1 棟)」に置き換える。区画から建物への対応は単射ではなく、
  `spanParcelIds` による全単射(区画の集合分割)になる。本書内の「1:1」
  表記はこの定義に統一する(下記「建物骨格の性質」冒頭、「中心建築」節
  冒頭を含む)

#### 中庭型(courtyard)の性質(Phase C)

> **Phase C 註記**(`plans/2026-07-12-worldgen-rework-layout.md`): 本節は
> Phase C の決定であり、実装はタスク C4 で追いつく。それまでコードは
> 中庭型パターンを生成しない(中庭 Plaza は中心建築のみが追加する)。

- グループ(長さ 3〜5)の建物を中庭を囲む向きに再配置する。端の建物は
  90° 内向きスナップ(中心建築の翼棟スナップと同じ発想の一般化)。
  建物は単棟のまま(1:1 維持)・footprint も矩形のまま変えない。変わるのは
  向き・セットバックのみ
- 開いた辺(建物が囲まない辺)は `courtyard-wall` 部品(中心建築の実装の
  一般化)で閉じる。塀部品の帰属はグループ先頭の建物とし、footprint 外
  への配置は既存の SITE_PART_TYPES(`fence` / `stair` 等。親区画 1.2 帯で
  検証する部品区分。下記「建物部品の性質」)の流儀で検証する
- 塀セグメントは配置前に既存の衝突検査(道路・水域・広場・区画)を通し、
  当たる区間は開口として省略する(決定論。乱数は消費しない)
- 囲まれた領域に `kind: "courtyard"` の Plaza を追加する(中心建築が
  courtyard Plaza を追記する既存流儀と同じ。network-plaza.md「Plaza」節の
  courtyard 記述は「段12 の中心建築および一般建物(中庭型クラスタ)が
  追記する」へ改訂する)

#### 雁行(stagger)の性質(Phase C)

> **Phase C 註記**(`plans/2026-07-12-worldgen-rework-layout.md`): 本節は
> Phase C の決定であり、実装はタスク C4 で追いつく。それまでコードは
> 雁行のセットバック・向き変調を行わない。

- グループ内の各建物に、スロット序数(グループ内の位置)に応じた決定論的
  な前面セットバックと向きの変調を与える。新しい部品・スキーマは不要
- 前面セットバック: 序数パリティ(偶奇)で 0.5 / 2.0 を交互に与える
  (提案値)
- 向き: footprint 重心まわりに ±4°(提案値)を序数パリティで振り分ける

#### 裏庭の性質(Phase C)

> **Phase C 註記**(`plans/2026-07-12-worldgen-rework-layout.md`): 本節は
> Phase C の決定であり、実装はタスク C6 で追いつく。それまでコードは
> 区画背面に裏庭部品(塀・付属屋)を配置しない。

- 建物の背面と区画背面の間の帯を裏庭とする。帯判定は「建物背面〜区画
  背面の距離 ≥ 2.5」のときのみ裏庭を成立させる
- 裏庭には区画背面・側面に沿う `fence`(既存部品)列を置き、確率で小さな
  付属屋(shed。1 階・幅 2〜3.2 の矩形。既存 `wall` + `gable` 部品の小型
  構成)を置く
- 採択率(提案値): `backyardRate = 0.35 + 0.35×(1 − settle)`(郊外ほど
  庭が広く残る)。urbanity が高い区画では帯が薄くなるため採択率は自然に
  下がる
- 連棟(rowhouse)は列全体で共有の細長い裏庭を持ち、塀は列全体を囲む
- 部品はすべて親区画内に収める。SITE_PART_TYPES(`fence` / `stair` 等。
  親区画 1.2 帯で検証する部品区分)の帯検証を裏庭部品(fence / shed の
  壁・屋根)にも拡張する
- 畝・菜園などの地面材質表現は Phase D(畑と統一)へ送る。Phase C の
  裏庭は塀・付属屋・余白の配置までとする
- 乱数は既存の `"building/<id>"` ストリームの**末尾への固定追加消費**の
  みで裏庭の採否・shed の抽選を行う(骨格・部品の既存消費順は変えない)

#### 同型連続の抑制の設計原理(Phase C)

> **Phase C 註記**(`plans/2026-07-12-worldgen-rework-layout.md`): 本節は
> Phase C の決定であり、実装はタスク C3 で追いつく。それまでコードは
> 位置由来の変調を持たず、形状・素材・屋根の抽選は完全に独立である。

- **規約**: 同型連続の抑制は**位置由来(スロット序数・`groupId` の
  ハッシュ)の決定論的な変調**で行い、**隣接要素の生成結果(実際に決まった
  形状・素材の値)を参照しない**。隣の出力を読むと生成順依存・要素間結合が
  生まれ、区画独立・順序非依存・決定性の規約が崩れるため
- 変調の具体(提案値。C7 で調整しうる):
  - 形状: house の L 字抽選確率を `0.35 ± 0.25×parity(slotHash)` で
    交互に変調する(隣どうしで L 字が連続しにくくなる)
  - 素材: 壁材・屋根材の階層添字 `idx` の揺らぎに
    `±0.5×parityWave(slot)` を加算する(3 連続同素材の確率を下げる)
  - 屋根: gable/hip の抽選と `pitch` にも同様の序数変調を適用する
- 変調は確率の変調(±)であり、強制的な交互配置にはしない(機械的な
  交互に見えないよう、C7 で目視検収する)

#### floors の改訂(サイズ勾配。Phase C)

> **Phase C 註記**(`plans/2026-07-12-worldgen-rework-layout.md`): 本節は
> Phase C の決定であり、実装はタスク C3 で追いつく。それまでコードの
> `floors` 式に urbanity 項はなく、上限は一律 3 のままである。

- `floors` の算出式に urbanity 項を追加する:
  `floorsBase += 1.1 × smoothstep(0.55, 0.9, urbanity(建物位置))`
  (提案値)。`urbanity` は `model.zoning`(Phase B 導入。段7「一次密度場」が
  書く `FieldGrid`)から建物位置をサンプルする。段12「建物」は段契約上
  `〜parcels`(段1〜11 の累積出力。pipeline.md 段契約表)を読めるため、
  `model.zoning` の追加読み取りは既存の段契約の範囲内であり、
  pipeline.md 側の追記は不要と判断する
- クランプ上限は **urbanity ≥ 0.75 の建物のみ 4**、それ以外は従来どおり
  **3** とする(提案値)。中心建築(1〜5 階)の例外はそのまま維持する
- **スカイライン契約は自動維持される**: 中心建築の「中心最高点 ≥ 周辺
  一般建物の最高点 × `skylineRatio`」は周辺の最高点から目標を都度
  再計算する既存実装(下記「中心建築」節)のため、4 階建物が現れても
  中心の塔が自動的に伸びて契約を満たす

建物骨格の性質(段12「建物」の commit 12 分が保証する):

- 建物は区画に帰属する。**全採択区画はちょうど 1 棟に帰属する**
  (単棟 = 1 区画 1 棟、連棟 = k 区画 1 棟。上記「連棟(rowhouse)の性質」
  「1:1」の改訂)。`id` は `"building/<parcelId の parcel/ 以降>"` で
  区画由来で安定(連棟は列の先頭区画由来)。乱数は `"building/<id>"`
  サブストリームのみ消費する
- 役割(UI選択なし・文脈から決定): 広場に面する(区画と広場ポリゴンの
  距離 < 3)× Prosperity → hall、BridgeSite 近傍(渡り長/2 + 10 以内)
  × watersideRate → bridgehead、waterside/canalside 区画 × watersideRate →
  waterside、final 密度の裾(< 0.14)→ outskirt、低密度(< 0.24)×
  低 Prosperity → warehouse、それ以外 → house。優先順は
  hall > bridgehead > waterside > outskirt > warehouse > house
- footprint は矩形基本。広い敷地の hall は T 字、広い敷地の house は
  確率的に L 字。waterside は矩形固定(張り出しの合成を単純に保つ)。
  連棟は区画列を貫く帯状矩形(上記「連棟(rowhouse)の性質」)。
  区画からのセットバック(前面 0.5 / 側面 0.7 / 背面 0.7 目安)込みで、
  時計回り・自己交差なし
- 向き: `facing` は区画の接道方位を初期値とし、広場に面する場合は
  footprint の 4 軸(接道方位 ± k×90°)のうち広場方向に最も近い軸へ
  スナップする(広場 > 道路 > 水面/水路/橋 の優先)。中庭型クラスタでは
  端の建物が中庭側へ 90° 内向きスナップし、雁行クラスタではセットバックと
  向きがスロット序数で変調される(上記各パターン節)。最後に footprint を
  重心まわりに ±4° × (1 − tidiness) の範囲で揺らす(乱数は
  building サブストリーム。tidiness 高で揺らぎ減)
- floors は Settlement(floorsBias)・Prosperity・役割・urbanity から
  1〜4 の整数(urbanity ≥ 0.75 の建物のみ上限 4、他は上限 3。上記
  「floors の改訂」)。roof.pitch は 50〜58 度の連続値。roof.type は
  L/T footprint で "compound"、大型・hall で確率的に "hip"、基本 "gable"
- 接地: 陸上の建物は `foundation.kind = "plinth"`、`bottomY = 0`、
  `plinthHeight` は Prosperity・役割駆動(0.15〜0.9 目安)。
  waterside 建物は背面・左右の3辺(正面=接道側を除く)の中点から 6.0 以内に
  水面(湖・池)があれば、最も水面に近い辺を水面側へ延長して張り出す
  (水際から 1.6、延長は 7.0 を上限)。張り出した建物は
  `overWater = true`、kind は "piles"(低 Prosperity)または
  "stonebase"(高 Prosperity)、`bottomY = -1.6`(岸スカート下端)とする。
  張り出し延長が他の区画・道路・水路・広場・結界環と衝突する場合は
  張り出さない。水路の上への張り出しは行わない(護岸付きチャネルのため)
- 機械判定可能な接地契約: `overWater = true` ⇔ footprint の頂点の
  いずれかが水面上(湖・池の waterSdf < 0)。overWater の建物は
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
  (0.32)ぶんさらに出るため、上限は 1.2 とする。
  石垣(`fence`)・外階段(`stair`)は footprint の外・親区画の近傍に
  置かれる部品区分(以下「SITE_PART_TYPES」と呼ぶ)で、footprint からの
  はみ出し量ではなく親区画からの近傍(1.2 帯)で検証する。
  Phase C の裏庭 `fence` / shed(上記「裏庭の性質」)と中庭型の
  `courtyard-wall`(上記「中庭型(courtyard)の性質」)も SITE_PART_TYPES と
  同じ流儀(親区画 1.2 帯)で検証する。
  水辺拡張部品(`params.waterfront = 1`。PHASE 6 commit 19)は
  この上限の対象外で、専用の規約(下記「水辺建築の拡張」)に従う
- kind "piles" の杭部品は position.y = -1.6(SHORE_SKIRT_BOTTOM_Y)、
  上端 = 基壇天端。kind "stonebase" は plinth 部品が y = -1.6 から
  立ち上がる(接地契約の部品表現)。
  例外: 水辺デッキの杭(`params.waterfront = 1`)は上端 = デッキ床下端
  (下記「水辺建築の拡張」)

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
  正面幅 −1.0 でクランプ)。
  正面扉の一意性は「`params.waterfront` を持たない door がちょうど 1」で
  判定する(水辺拡張の追加扉 = デッキへの出入り口・水路裏口は
  `params.waterfront = 1` を持ち、外向きは水面・水路側。commit 19)
- **窓**: 「少なく大きく」(art-direction 6節)。数は面ごとの収容数 ×
  (0.35 + 0.6 × detailAmount) × 役割係数(warehouse 0.35 / outskirt 0.55 /
  hall 1.15 / 他 1.0)。整列は等間隔を基準に ±(1 − detailAmount) × 0.5 の
  揺らぎ(Prosperity 高で整列)。窓高は役割で差を付ける(hall × 1.3 /
  warehouse × 0.8)。位置は壁体部品の側面(壁面)上で、1階正面の扉近傍は
  空ける。翼が 2 つの建物では、正面翼の背面・従属翼の正面(翼どうしの
  接合面)には開口・梁を置かない
- **木組み梁**: `wall = "plaster"` の建物のみ(確率 0.88)。外壁面ごと・
  階ごとに下端横架材+上端横架材+両隅の柱(計 4 本)。材は `wood`。
  「plaster のみ」の対象は木組み表現の梁で、水辺拡張が再利用する
  `beam`(欄干・杭繋ぎ・持ち送り。`params.waterfront = 1`)は壁材に
  依らず付く(commit 19)
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

段12「建物」が、一般建物(区画からの全単射。単棟 = 1 区画、連棟 = k 区画。
上記「連棟(rowhouse)の性質」「1:1」の改訂)の展開後に中心建築 1 棟を
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
  (footprint 頂点が水面(湖・池)にかかる場合は接地契約に従い
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
      屋根は瓦(湖畔の館・水辺の塔)
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

#### 水辺建築の拡張(PHASE 6 commit 19)

段12「建物」が、waterside 役割の一般建物の部品展開(commit 14 の詳細まで)
の後に、水辺拡張の部品を同じ `Building.parts` へ追記する。

**層の設計判断(pipeline 側で展開する)**: デッキ・張り出し部屋は建物の
一部であり、`Building.parts` が建築部品の契約上の置き場である。採択量が
`watersideRate`(= Water)駆動の確率で変わる=計画内容を持つため、乱数
ストリームを持たない mesh 層の表示写像(位置ハッシュのみ)には置けない。
また張り出しの衝突回避は区画・道路・広場・結界環(SiteContext)を入力と
する pipeline の関心である。この結果 WorldModel が変わるため正規化ハッシュ
は更新する(スナップショットの新旧表は test/hash.test.ts に記す)。
なお結界環外の水辺の魔導塔(wards.towers の onRing: false)は陸上
(waterSdf ≥ 1)に立地する計画(段8)のため杭基礎は不要で、commit 17 の
塔文法(mesh/wardparts.ts)のまま変更しない(確認済みの設計判断)。

規約(段12 が保証し、メッシュビルダー・テストが前提としてよい):

- 水辺拡張の部品はすべて `params.waterfront = 1` を持つ。配列順は
  commit 14 の詳細部品(〜外階段)に続けて、
  杭繋ぎ梁 → デッキ(床 → 杭 → 欄干(辺ごとに柱 → 手すり)→ デッキ扉)→
  張り出し部屋(壁 → 屋根 → 窓 → 持ち送り梁)→ 水路裏口(扉 → 段)の順
- 乱数は派生サブストリーム `"building/<id>/waterfront"` のみ消費する
  (骨格 `"building/<id>"`・`"/parts"`・`"/details"` の消費は
  commit 16 から不変。waterside 役割の建物でのみ消費し、建物内の
  消費数は採否に応じて可変でよい)
- **杭繋ぎ梁**: `foundation.kind = "piles"` の建物に、杭列の各辺に沿った
  木の横木(`beam`)を水面上 y = −0.25 に 1 本ずつ置く(杭基礎の見た目の
  充実。乱数非消費の決定的な追加)
- **杭支持デッキ(`deck`)**: overWater の waterside 建物の水側の面
  (張り出しで延長した面)に、採択率 clamp(0.4 + 0.6 × watersideRate)で
  木のデッキを張り出す。奥行き 1.8〜2.6、幅は延長面から両側 0.35 内側。
  デッキ床天端 = 基壇天端(plinthHeight)、床厚 0.22。
  杭(`pile`。y = −1.6 からデッキ床下端まで)を外縁に間隔 2.4 で立て、
  低い欄干(`beam` の柱 0.12 角 × 高さ 0.78 + 手すり)を外縁 3 辺に張る。
  壁面側にデッキへの出入り口(`door`。waterfront)を置き、扉に重なる
  1階の窓は配列から取り除く。
  採択条件: デッキ外縁のプローブ(外側2隅+外縁中点)の過半が水上
  (湖・池の waterSdf < 0)で、張り出し延長と同じ衝突検査
  (他区画・道路・水路・広場・結界環・境界)と既生成の建物 footprint
  との重なり検査に通ること。通らなければ採択しない
- **張り出し部屋**: overWater × 2階建て以上の waterside 建物の水側の面に、
  採択率 clamp(0.25 + 0.55 × watersideRate)で最上階の張り出し部屋を置く。
  幅 = clamp(面幅 × 0.55, 2.4, 5.4)(面幅 < 3.2 では置かない)、
  張り出し 1.15(壁へ 0.25 食い込ませる)。部品は `wall`(最上階の階高)+
  `gable`(params.pitch = roof.pitch。棟は面と平行)+ 外面の `window`
  1〜2 + 床下の持ち送り梁(`beam` × 3)。部屋に重なる同じ面・最上階の
  窓は配列から取り除く。採択条件はデッキと同じ衝突検査+外縁プローブの
  過半が水上
- **水路裏口**: canalside 区画 × overWater でない waterside 建物で、
  背面・左右のうち水路(中心線距離 − 幅/2)に最も近い面(外向き 0.8 の
  プローブで距離 < 6)に、採択率 clamp(0.5 + 0.4 × watersideRate)で
  裏口(`door`。外向きは水路側)を置く(水路向きの家並みの控えめな演出)。
  基壇が高い(plinthHeight ≥ 0.32)場合は裏口前に段(`stair`。steps 2、
  奥行き 0.6)を添える。裏口に重なる 1 階の窓は配列から取り除く
- **はみ出しの上限**: 水辺拡張部品は延長後の footprint から水側へ最大
  3.4(デッキ奥行き 2.6 + 欄干・杭のはね出し)まで出てよい。
  裏口の段は親区画から 1.2 以内(外階段と同じ帯)
- PHASE 6 の完了条件(implementation-spec 7章)に対応する統計契約:
  Water 90 の代表 seed で「水辺の家(waterside 役割 × waterside 区画)・
  張り出しデッキ(deck 部品)・橋詰め建築(bridgehead)・水路沿いの家並み
  (canalside 区画の建物 2 棟以上)・杭基礎(kind "piles")」のうち
  4 種以上が同一箱庭に共存し、岸線点のうち waterside 区画から 6 以内の
  点の割合(岸線占有率)が過半を下回る(採択上限 40% は段11 のまま。
  区画採択ロジックには手を入れない)

