# WorldModel スキーマ契約 — 素材(materialId の語彙)

WorldModel スキーマ契約の一部(2026-07-07 に worldmodel.md から分割)。
本書は Part の `materialId` の語彙(基準色)の正であり、art-direction 5.1節・
5.5節と同期する。
スキーマの変更はコードより先に本書を更新する。
索引と節→ファイルの対応表は [README.md](README.md) を参照。
関連: この語彙を使う Part の型・変換規約は [buildings.md](buildings.md) を参照。

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
| `tilled-soil` | `#63513e` | 耕土(畑の基盤・畝。Phase D タスク D2b。基準色は art-direction 5.5節) |
| `meadow` | `#94a166` | 牧草(牧草地のパッチ。Phase D タスク D2b。同上) |
| `canvas` | `#c9b48e` | 帆布(生成りの天幕・風車の帆。Phase D タスク D3。同上) |
| `awning-madder` | `#8f6350` | 茜の天幕(屋台。Phase D タスク D3。同上) |
| `awning-slate` | `#6b7a8c` | 青灰の天幕(屋台。Phase D タスク D3。同上) |
| `void` | `#352c22` | 開口暗色(井戸の井桁内の暗がり。Phase D タスク D3。開口の奥面と同色) |
| `wet-wood` | `#4a3c2e` | 濡れ木(水車の水輪。Phase D タスク D4。基準色は art-direction 5.5節) |
| `glow` | (art-direction 5.4節) | 発光部品(`crystal` / `sigil`)。基準色表は使わず、発光束のマテリアル規範(上記)に従う |

- 色の正はメッシュビルダーの基準色表(`src/mesh/buildings.ts`)とし、
  art-direction 5.1節と同期させる。頂点カラーは基準色 × 面ごとの
  ±8% 明度ムラ(位置ハッシュ由来。乱数ストリーム非消費)×
  壁足元・基壇下端・軒裏の焼き込みAO(art-direction 3節)で決める
- マテリアル束(マージ先): 屋根系(`thatch` / `shingle` / `tile` /
  `slate`)は「屋根」束、それ以外は「躯体」束。束ごとに 1 つの
  統合ジオメトリ+ MeshStandardMaterial(頂点カラー)となる
