/**
 * アプリ既定値。
 * DEFAULT_SEED は UI の seed 入力欄の初期値であり、生成パイプラインの
 * 挙動には影響しない(生成は常に「入力された seed + パラメータ」で決まる)。
 *
 * 選定基準: design.md「入力」節 Monumentality 項の
 * 「複数の水辺タイプ(湖・池・水路など)と複数種の施設が同時に見える
 * 代表性」に基づき、機械指標+目視で比較して選定した。
 */
export const DEFAULT_SEED = "everdusk-102";
