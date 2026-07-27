import { describe, expect, it } from "vite-plus/test";

import { searchSettings, SETTINGS_SEARCH_ITEMS, type SettingsSearchItem } from "./settingsSearch";

const ITEMS: ReadonlyArray<SettingsSearchItem> = [
  {
    id: "word-wrap",
    title: "Word wrap",
    description: "Wrap long lines in code blocks.",
    to: "/settings/general",
    keywords: ["line wrapping"],
  },
  {
    id: "network-access",
    title: "Network access",
    description: "Make this environment reachable from other devices.",
    to: "/settings/connections",
    keywords: ["LAN"],
  },
  {
    id: "providers",
    title: "Providers",
    description: "Configure agent providers and models.",
    to: "/settings/providers",
    keywords: ["Claude", "Codex"],
  },
  {
    id: "provider-updates",
    title: "Update checks",
    description: "Check providers for newer versions.",
    to: "/settings/general",
  },
];

describe("searchSettings", () => {
  it("matches titles, descriptions, sections, and keywords", () => {
    expect(searchSettings("word", ITEMS).map((item) => item.id)).toEqual(["word-wrap"]);
    expect(searchSettings("devices", ITEMS).map((item) => item.id)).toEqual(["network-access"]);
    expect(searchSettings("connections", ITEMS).map((item) => item.id)).toEqual(["network-access"]);
    expect(searchSettings("claude", ITEMS).map((item) => item.id)).toEqual(["providers"]);
  });

  it("requires every query token to match", () => {
    expect(searchSettings("network devices", ITEMS).map((item) => item.id)).toEqual([
      "network-access",
    ]);
    expect(searchSettings("network claude", ITEMS)).toEqual([]);
  });

  it("ranks title matches ahead of lower-value matches", () => {
    expect(searchSettings("providers", ITEMS).map((item) => item.id)).toEqual([
      "providers",
      "provider-updates",
    ]);
  });

  it("returns no results for an empty query", () => {
    expect(searchSettings("   ", ITEMS)).toEqual([]);
  });

  it("keeps catalog result ids unique", () => {
    const ids = SETTINGS_SEARCH_ITEMS.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
