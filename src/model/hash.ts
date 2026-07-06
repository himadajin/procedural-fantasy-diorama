/**
 * WorldModel 正規化ハッシュ(決定性検証)。
 * 正式定義は docs/internal/contracts/pipeline.md「WorldModel 正規化ハッシュ」:
 * 深さ優先走査・キー辞書順・数値は小数6桁の固定精度で文字列化し、
 * FNV-1a(32bit)で 16進8桁にする。summary.hash 自身は計算から除外する。
 * three 非依存の純関数。
 */
import { hashString } from "../rng";
import type { WorldModel } from "./worldmodel";

/** 数値の固定精度文字列化(1e-6 で丸め。-0 は 0 に正規化) */
function formatNumber(v: number): string {
  const n = Object.is(v, -0) ? 0 : v;
  return n.toFixed(6);
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
