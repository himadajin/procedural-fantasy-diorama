/**
 * アプリ既定値。
 * DEFAULT_SEED は UI の seed 入力欄の初期値であり、生成パイプラインの
 * 挙動には影響しない(生成は常に「入力された seed + パラメータ」で決まる)。
 *
 * 選定: PHASE 7 commit 23 の総合検証で、全パラメータ 50 の 24 seed を
 * 機械指標+目視で比較して選定した(design.md「入力」節の
 * 「デフォルトの箱庭は各傾向の中間にある集落」)。選定基準と候補比較は
 * docs/internal/plans/2026-07-07-verification-record.md に記録している。
 */
export const DEFAULT_SEED = "everdusk-102";
