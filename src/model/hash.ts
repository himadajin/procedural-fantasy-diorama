/**
 * WorldModel 正規化ハッシュ(決定性検証)。
 * 正式定義は docs/internal/contracts/pipeline.md「WorldModel 正規化ハッシュ」:
 * 深さ優先走査・キー辞書順・数値は固定精度(下記 NUMERIC_PRECISION_DIGITS)で
 * 文字列化し、FNV-1a(32bit)で 16進8桁にする。summary.hash 自身は計算から
 * 除外する。three 非依存の純関数。
 */
import { hashString } from "../rng";
import type { WorldModel } from "./worldmodel";

/**
 * 数値の固定精度桁数(小数点以下)。ハッシュの文字列化(formatNumber)と、
 * 生成の構造的分岐比較の安定化(stableRound。下記)で共有する単一の定数。
 * 値は docs/internal/contracts/pipeline.md「WorldModel 正規化ハッシュ」節の
 * 実測記録を正とする。
 */
const NUMERIC_PRECISION_DIGITS = 3;

/** 数値の固定精度文字列化(NUMERIC_PRECISION_DIGITS で丸め。-0 は 0 に正規化) */
function formatNumber(v: number): string {
  const n = Object.is(v, -0) ? 0 : v;
  return n.toFixed(NUMERIC_PRECISION_DIGITS);
}

/**
 * 幾何計算値(三角関数由来の連続値)を固定閾値と比較して生成の構造的分岐
 * (regen の要否・採否等)を行う箇所で、比較の直前に適用する丸め関数
 * (docs/internal/contracts/pipeline.md「WorldModel 正規化ハッシュ」節)。
 * ハッシュの文字列化と同じ精度(NUMERIC_PRECISION_DIGITS)で丸めることで、
 * クロスアーキテクチャの ULP 差(1e-14〜1e-15 オーダー)が閾値ちょうどの
 * 分岐を反転させないようにする。RNG 由来・Params 由来の値どうしの比較は
 * ビット決定論的なため対象外。
 */
export function stableRound(v: number): number {
  const n = Object.is(v, -0) ? 0 : v;
  return Number(n.toFixed(NUMERIC_PRECISION_DIGITS));
}

function serialize(value: unknown, out: string[]): void {
  if (value === null) {
    out.push("null");
    return;
  }
  switch (typeof value) {
    case "number":
      out.push(formatNumber(value));
      return;
    case "string":
      out.push(value);
      return;
    case "boolean":
      out.push(value ? "true" : "false");
      return;
    default:
      break;
  }
  if (Array.isArray(value)) {
    out.push("[");
    for (const item of value) {
      serialize(item, out);
      out.push(",");
    }
    out.push("]");
    return;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    out.push("{");
    for (const key of Object.keys(record).sort()) {
      if (record[key] === undefined) continue;
      out.push(key, ":");
      serialize(record[key], out);
      out.push(",");
    }
    out.push("}");
    return;
  }
  throw new Error(`hashWorldModel: 直列化できない値(${typeof value})`);
}

/** WorldModel の正規化ハッシュ(16進8桁)。summary.hash 自身は除外する */
export function hashWorldModel(model: WorldModel): string {
  const { hash: _excluded, ...summary } = model.summary;
  void _excluded;
  const out: string[] = [];
  serialize({ ...model, summary }, out);
  return hashString(out.join("")).toString(16).padStart(8, "0");
}
