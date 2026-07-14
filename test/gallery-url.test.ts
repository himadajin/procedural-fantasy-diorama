import { describe, expect, it } from "vitest";
import { DEFAULT_PARAMS } from "../src/model/worldmodel";
import { parseGalleryUrl, serializeGalleryUrl } from "../src/ui/gallery-url";

const KNOWN_IDS = ["building/house", "building/waterside"];

describe("gallery-url: parseGalleryUrl(implementation-spec 1.11節)", () => {
  it("gallery パラメータが無ければ null(従来どおり箱庭タブで起動)", () => {
    expect(parseGalleryUrl("?seed=foo", KNOWN_IDS, "default-seed")).toBeNull();
    expect(parseGalleryUrl("", KNOWN_IDS, "default-seed")).toBeNull();
  });

  it("未知の対象idなら null", () => {
    expect(
      parseGalleryUrl("?gallery=building/center", KNOWN_IDS, "default-seed"),
    ).toBeNull();
    expect(
      parseGalleryUrl("?gallery=facility/well", KNOWN_IDS, "default-seed"),
    ).toBeNull();
  });

  it("既知の対象idのみ指定: seed は既定、paramsは全て既定値50", () => {
    const state = parseGalleryUrl(
      "?gallery=building/house",
      KNOWN_IDS,
      "default-seed",
    );
    expect(state).not.toBeNull();
    expect(state?.targetId).toBe("building/house");
    expect(state?.seed).toBe("default-seed");
    expect(state?.params).toEqual(DEFAULT_PARAMS);
  });

  it("seed・prosperity・settlement を指定どおりに反映する", () => {
    const state = parseGalleryUrl(
      "?gallery=building/waterside&seed=everdusk-101&prosperity=70&settlement=30",
      KNOWN_IDS,
      "default-seed",
    );
    expect(state?.seed).toBe("everdusk-101");
    expect(state?.params.prosperity).toBe(70);
    expect(state?.params.settlement).toBe(30);
    // 関連パラメータ以外(water 等)は既定値のまま
    expect(state?.params.water).toBe(DEFAULT_PARAMS.water);
  });

  it("空文字の seed は既定 seed へフォールバックする", () => {
    const state = parseGalleryUrl(
      "?gallery=building/house&seed=",
      KNOWN_IDS,
      "default-seed",
    );
    expect(state?.seed).toBe("default-seed");
  });

  it("範囲外・非数値のパラメータはクランプ・既定値50へフォールバックする", () => {
    const state = parseGalleryUrl(
      "?gallery=building/house&prosperity=150&settlement=not-a-number",
      KNOWN_IDS,
      "default-seed",
    );
    expect(state?.params.prosperity).toBe(100);
    expect(state?.params.settlement).toBe(DEFAULT_PARAMS.settlement);
  });

  it("先頭に ? が無い search 文字列でも解析できる", () => {
    const state = parseGalleryUrl(
      "gallery=building/house&seed=abc",
      KNOWN_IDS,
      "default-seed",
    );
    expect(state?.targetId).toBe("building/house");
    expect(state?.seed).toBe("abc");
  });
});

describe("gallery-url: serializeGalleryUrl", () => {
  it("対象id・seed・関連パラメータを含むクエリ文字列を組み立てる", () => {
    const url = serializeGalleryUrl("building/house", "everdusk-101", {
      ...DEFAULT_PARAMS,
      prosperity: 70,
      settlement: 30,
    });
    expect(url.startsWith("?")).toBe(true);
    const q = new URLSearchParams(url.slice(1));
    expect(q.get("gallery")).toBe("building/house");
    expect(q.get("seed")).toBe("everdusk-101");
    expect(q.get("prosperity")).toBe("70");
    expect(q.get("settlement")).toBe("30");
  });

  it("parse(serialize(x)) が往復して元の状態を再現する", () => {
    const original = {
      targetId: "building/waterside",
      seed: "round-trip-seed",
      params: { ...DEFAULT_PARAMS, prosperity: 12, settlement: 88 },
    };
    const url = serializeGalleryUrl(
      original.targetId,
      original.seed,
      original.params,
    );
    const parsed = parseGalleryUrl(url, KNOWN_IDS, "unused-default");
    expect(parsed?.targetId).toBe(original.targetId);
    expect(parsed?.seed).toBe(original.seed);
    expect(parsed?.params.prosperity).toBe(original.params.prosperity);
    expect(parsed?.params.settlement).toBe(original.params.settlement);
  });
});
