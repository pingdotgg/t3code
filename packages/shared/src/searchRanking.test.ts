import { describe, expect, it } from "vite-plus/test";

import {
  foldForSearch,
  insertRankedSearchResult,
  normalizeSearchQuery,
  scoreQueryMatch,
  scoreSubsequenceMatch,
} from "./searchRanking.ts";

describe("foldForSearch", () => {
  it("folds the Turkish dotted and dotless I together", () => {
    expect(foldForSearch("İptal")).toBe("iptal");
    expect(foldForSearch("Yapılandırma")).toBe("yapilandirma");
    expect(foldForSearch("Işık")).toBe("isik");
    expect(foldForSearch("ışık")).toBe("isik");
  });

  it("folds Latin accents", () => {
    expect(foldForSearch("Café")).toBe("cafe");
    expect(foldForSearch("Öffnen")).toBe("offnen");
    expect(foldForSearch("Ångström")).toBe("angstrom");
  });

  it("keeps combining marks that carry meaning in other scripts", () => {
    // Stripping every \p{M} would collapse these onto their bare letters, so
    // searching for one spelling would start returning the other.
    expect(foldForSearch("بَ")).not.toBe(foldForSearch("ب"));
    expect(foldForSearch("שָׁלוֹם")).not.toBe(foldForSearch("שלום"));
  });

  it("collapses runs of whitespace and trims", () => {
    expect(foldForSearch("  a   b  ")).toBe("a b");
  });
});

describe("normalizeSearchQuery", () => {
  it("trims and lowercases queries", () => {
    expect(normalizeSearchQuery("  UI  ")).toBe("ui");
  });

  it("can strip leading trigger characters", () => {
    expect(normalizeSearchQuery("  $ui", { trimLeadingPattern: /^\$+/ })).toBe("ui");
  });

  it("lowercases without folding, so the fold can hit both sides at once", () => {
    // Callers use this on the query, and some of them (modelPickerSearch) also
    // use it on the candidate. Folding here as well would fold the query twice
    // and leave the two kinds of caller with different candidate strings, so the
    // fold stays in scoreQueryMatch where it is applied to both sides together.
    expect(normalizeSearchQuery("Café")).toBe("café");
    expect(normalizeSearchQuery("İptal")).toBe("i̇ptal");
  });
});

describe("scoreQueryMatch", () => {
  it("keeps accented queries findable through the real call path", () => {
    // This is how callers actually use the two functions: the query goes
    // through normalizeSearchQuery, the candidate is only lowercased by the
    // caller. Folding the query on its own would break "café" -> "Café", which
    // matched before this change.
    const accented = normalizeSearchQuery("Café");
    expect(
      scoreQueryMatch({
        value: "Café",
        query: accented,
        exactBase: 0,
        includesBase: 20,
      }),
    ).toBe(0);

    expect(
      scoreQueryMatch({
        value: "İptal",
        query: normalizeSearchQuery("iptal"),
        exactBase: 0,
        includesBase: 20,
      }),
    ).toBe(0);
  });

  it("finds a Turkish label from an ASCII query", () => {
    expect(
      scoreQueryMatch({
        value: "İptal",
        query: "iptal",
        exactBase: 0,
        prefixBase: 10,
        includesBase: 20,
      }),
    ).toBe(0);

    expect(
      scoreQueryMatch({
        value: "Yapılandırma",
        query: "yapilandirma",
        exactBase: 0,
        prefixBase: 10,
        includesBase: 20,
      }),
    ).toBe(0);
  });

  it("still matches accented text that already matched, at the same score", () => {
    // These two scores were measured on the implementation before this change.
    // A folded retry that fired first would raise them to exactBase and quietly
    // reorder every existing result, so they are pinned here.
    expect(
      scoreQueryMatch({
        value: "café menu",
        query: "café",
        exactBase: 0,
        prefixBase: 10,
        includesBase: 20,
        fuzzyBase: 30,
      }),
    ).toBe(15);

    expect(
      scoreQueryMatch({
        value: "öffnen dosyası",
        query: "öffnen",
        exactBase: 0,
        prefixBase: 10,
        includesBase: 20,
        fuzzyBase: 30,
      }),
    ).toBe(18);
  });

  it("folds accents when the query is typed without them", () => {
    expect(
      scoreQueryMatch({
        value: "Café",
        query: "cafe",
        exactBase: 0,
        includesBase: 20,
      }),
    ).toBe(0);
  });

  it("folds without a fuzzy tier available", () => {
    expect(
      scoreQueryMatch({
        value: "İptal",
        query: "iptal",
        exactBase: 0,
        includesBase: 20,
      }),
    ).toBe(0);
  });

  it("does not fold non-Latin scripts into each other", () => {
    expect(
      scoreQueryMatch({
        value: "ב",
        query: "בَ",
        exactBase: 0,
        prefixBase: 10,
        boundaryBase: 15,
        includesBase: 20,
        fuzzyBase: 30,
      }),
    ).toBeNull();
  });

  it("returns null when neither the plain nor the folded comparison matches", () => {
    expect(
      scoreQueryMatch({
        value: "deploy",
        query: "cancel",
        exactBase: 0,
        prefixBase: 10,
        includesBase: 20,
        fuzzyBase: 30,
      }),
    ).toBeNull();
  });
});

describe("scoreQueryMatch", () => {
  it("prefers exact matches over broader contains matches", () => {
    expect(
      scoreQueryMatch({
        value: "ui",
        query: "ui",
        exactBase: 0,
        prefixBase: 10,
        includesBase: 20,
      }),
    ).toBe(0);

    expect(
      scoreQueryMatch({
        value: "building native ui",
        query: "ui",
        exactBase: 0,
        prefixBase: 10,
        boundaryBase: 20,
        includesBase: 30,
      }),
    ).toBeGreaterThan(0);
  });

  it("treats boundary matches as stronger than generic contains matches", () => {
    const boundaryScore = scoreQueryMatch({
      value: "gh-fix-ci",
      query: "fix",
      exactBase: 0,
      prefixBase: 10,
      boundaryBase: 20,
      includesBase: 30,
      boundaryMarkers: ["-"],
    });
    const containsScore = scoreQueryMatch({
      value: "highfixci",
      query: "fix",
      exactBase: 0,
      prefixBase: 10,
      boundaryBase: 20,
      includesBase: 30,
      boundaryMarkers: ["-"],
    });

    expect(boundaryScore).not.toBeNull();
    expect(containsScore).not.toBeNull();
    expect(boundaryScore!).toBeLessThan(containsScore!);
  });
});

describe("scoreSubsequenceMatch", () => {
  it("scores tighter subsequences ahead of looser ones", () => {
    const compact = scoreSubsequenceMatch("ghfixci", "gfc");
    const spread = scoreSubsequenceMatch("github-fix-ci", "gfc");

    expect(compact).not.toBeNull();
    expect(spread).not.toBeNull();
    expect(compact!).toBeLessThan(spread!);
  });
});

describe("insertRankedSearchResult", () => {
  it("keeps the best-ranked candidates within the limit", () => {
    const ranked = [
      { item: "b", score: 20, tieBreaker: "b" },
      { item: "d", score: 40, tieBreaker: "d" },
    ];

    insertRankedSearchResult(ranked, { item: "a", score: 10, tieBreaker: "a" }, 2);
    insertRankedSearchResult(ranked, { item: "c", score: 30, tieBreaker: "c" }, 2);

    expect(ranked.map((entry) => entry.item)).toEqual(["a", "b"]);
  });
});
