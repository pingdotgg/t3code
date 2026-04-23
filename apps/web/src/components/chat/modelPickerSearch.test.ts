import { describe, expect, it } from "vitest";

import { buildModelPickerSearchText, scoreModelPickerSearch } from "./modelPickerSearch";

describe("buildModelPickerSearchText", () => {
  it("builds provider-agnostic search text from generic fields", () => {
    expect(
      buildModelPickerSearchText({
        provider: "opencode",
        name: "Claude Opus 4.7",
        subProvider: "GitHub Copilot",
      }),
    ).toBe("claude opus 4.7 github copilot opencode opencode");
  });
});

describe("scoreModelPickerSearch", () => {
  it("matches typo-tolerant multi-token queries", () => {
    expect(
      scoreModelPickerSearch(
        {
          provider: "opencode",
          name: "Claude Opus 4.7",
          subProvider: "GitHub Copilot",
        },
        "coplt op",
      ),
    ).not.toBeNull();
  });

  it("rejects results when any query token does not match", () => {
    expect(
      scoreModelPickerSearch(
        {
          provider: "codex",
          name: "GPT-5 Codex",
        },
        "coplt op",
      ),
    ).toBeNull();
  });

  it("ranks exact token matches ahead of fuzzier matches", () => {
    const exactScore = scoreModelPickerSearch(
      {
        provider: "opencode",
        name: "Claude Opus 4.7",
        subProvider: "GitHub Copilot",
      },
      "copilot opus",
    );
    const fuzzyScore = scoreModelPickerSearch(
      {
        provider: "opencode",
        name: "Claude Opus 4.7",
        subProvider: "GitHub Copilot",
      },
      "coplt op",
    );

    expect(exactScore).not.toBeNull();
    expect(fuzzyScore).not.toBeNull();
    expect(exactScore!).toBeLessThan(fuzzyScore!);
  });

  it("gives favorite models a strong enough ranking boost for partial queries", () => {
    const favoriteScore = scoreModelPickerSearch(
      {
        provider: "claudeAgent",
        name: "Claude Opus 4.7",
        isFavorite: true,
      },
      "opu",
    );
    const nonFavoriteScore = scoreModelPickerSearch(
      {
        provider: "cursor",
        name: "Opus 4.5",
      },
      "opu",
    );

    expect(favoriteScore).not.toBeNull();
    expect(nonFavoriteScore).not.toBeNull();
    expect(favoriteScore!).toBeLessThan(nonFavoriteScore!);
  });

  it("does not let the favorite boost outrank clearly better textual matches", () => {
    const favoriteScore = scoreModelPickerSearch(
      {
        provider: "claudeAgent",
        name: "Claude Opus 4.7",
        isFavorite: true,
      },
      "opus 4.7",
    );
    const nonFavoriteExactScore = scoreModelPickerSearch(
      {
        provider: "cursor",
        name: "Opus 4.7",
      },
      "opus 4.7",
    );

    expect(favoriteScore).not.toBeNull();
    expect(nonFavoriteExactScore).not.toBeNull();
    expect(nonFavoriteExactScore!).toBeLessThan(favoriteScore!);
  });
});
