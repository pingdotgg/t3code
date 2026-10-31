import { describe, expect, it } from "vite-plus/test";

import { rankModelPickerSearch, scoreModelPickerSearch } from "./modelPickerSearch";

describe("scoreModelPickerSearch", () => {
  it("ranks exact token matches ahead of fuzzier matches", () => {
    const exactScore = scoreModelPickerSearch(
      {
        driverKind: "opencode",
        providerDisplayName: "opencode",
        name: "Claude Opus 4.7",
        subProvider: "GitHub Copilot",
      },
      "copilot opus",
    );
    const fuzzyScore = scoreModelPickerSearch(
      {
        driverKind: "opencode",
        providerDisplayName: "opencode",
        name: "Claude Opus 4.7",
        subProvider: "GitHub Copilot",
      },
      "coplt op",
    );

    expect(exactScore).not.toBeNull();
    expect(fuzzyScore).not.toBeNull();
    expect(exactScore!).toBeLessThan(fuzzyScore!);
  });

  it("does not let the favorite boost outrank clearly better textual matches", () => {
    const favoriteScore = scoreModelPickerSearch(
      {
        driverKind: "claudeAgent",
        providerDisplayName: "Claude",
        name: "Claude Opus 4.7",
        isFavorite: true,
      },
      "opus 4.7",
    );
    const nonFavoriteExactScore = scoreModelPickerSearch(
      {
        driverKind: "cursor",
        providerDisplayName: "Cursor",
        name: "Opus 4.7",
      },
      "opus 4.7",
    );

    expect(favoriteScore).not.toBeNull();
    expect(nonFavoriteExactScore).not.toBeNull();
    expect(nonFavoriteExactScore!).toBeLessThan(favoriteScore!);
  });
});

type CatalogModel = {
  driverKind: string;
  providerDisplayName: string;
  name: string;
  subProvider?: string;
  isFavorite?: boolean;
};

function instanceModels(
  driverKind: string,
  providerDisplayName: string,
  names: ReadonlyArray<string>,
): CatalogModel[] {
  return names.map((name) => ({ driverKind, providerDisplayName, name }));
}

const catalog: CatalogModel[] = [
  ...instanceModels("claudeAgent", "Claude", [
    "Claude Opus 5.5",
    "Claude Sonnet 5.5",
    "Claude Fable 5.1",
    "Claude Fable 5",
    "Claude Opus 5",
    "Claude Opus 4.8",
    "Claude Opus 4.7",
    "Claude Opus 4.6",
    "Claude Opus 4.5",
    "Claude Sonnet 5",
    "Claude Sonnet 4.6",
    "Claude Haiku 5.5",
    "Claude Haiku 4.5",
  ]),
  ...instanceModels("codex", "Codex", [
    "GPT-6.1 Sol",
    "GPT-6 Astra",
    "GPT-6 Luna",
    "GPT-6 Sol",
    "GPT-5.6 Sol",
    "GPT-5.6 Terra",
    "GPT-5.6 Luna",
    "GPT-5.5",
  ]),
  ...instanceModels("grok", "Grok", ["Grok 4.7", "Grok 4.6", "Grok 4.5"]),
  ...instanceModels("antigravity", "Antigravity", [
    "Gemini 3.8 Flash (High)",
    "Gemini 3.8 Flash (Medium)",
    "Gemini 3.8 Flash (Low)",
    "Gemini 3.7 Flash (High)",
    "Gemini 3.7 Flash (Medium)",
    "Gemini 3.7 Flash (Low)",
    "Gemini 3.6 Flash (High)",
    "Gemini 3.6 Flash (Medium)",
    "Gemini 3.6 Flash (Low)",
    "Gemini 3.1 Pro (High)",
    "Gemini 3.1 Pro (Low)",
  ]),
  {
    driverKind: "opencode",
    providerDisplayName: "OpenCode",
    name: "Kimi K3",
    subProvider: "Moonshot",
  },
  {
    driverKind: "opencode",
    providerDisplayName: "OpenCode",
    name: "Kimi K2.5",
    subProvider: "Moonshot",
  },
  {
    driverKind: "opencode",
    providerDisplayName: "OpenCode",
    name: "Kimi K2",
    subProvider: "Moonshot",
  },
];

function search(query: string, models: ReadonlyArray<CatalogModel> = catalog): string[] {
  return rankModelPickerSearch(models, query, (model) => model).map((model) => model.name);
}

describe("rankModelPickerSearch", () => {
  it("keeps newest first when a version token narrows the family", () => {
    expect(search("opus 4")).toEqual([
      "Claude Opus 4.8",
      "Claude Opus 4.7",
      "Claude Opus 4.6",
      "Claude Opus 4.5",
    ]);
    expect(search("opus 5")).toEqual(["Claude Opus 5.5", "Claude Opus 5", "Claude Opus 4.5"]);
    expect(search("opus 5.")).toEqual(["Claude Opus 5.5"]);
  });

  it("still ranks an exact name above newer models that extend it", () => {
    expect(search("gpt-6 sol").slice(0, 2)).toEqual(["GPT-6 Sol", "GPT-6.1 Sol"]);
    expect(search("claude opus 5").slice(0, 2)).toEqual(["Claude Opus 5", "Claude Opus 5.5"]);
    expect(search("Grok 4.6")[0]).toBe("Grok 4.6");
  });

  it("matches the provider when the name does not", () => {
    expect(search("moonshot")).toEqual(["Kimi K3", "Kimi K2.5", "Kimi K2"]);
  });

  it("ranks a favorite above newer models in the same family", () => {
    const models = catalog.map((model) =>
      model.name === "Claude Opus 4.5" ? { ...model, isFavorite: true } : model,
    );
    expect(search("opus", models).slice(0, 3)).toEqual([
      "Claude Opus 4.5",
      "Claude Opus 5.5",
      "Claude Opus 5",
    ]);
  });
});
