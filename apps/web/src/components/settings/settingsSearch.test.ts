import { describe, expect, it } from "vitest";

import { searchSettings, settingsSearchId } from "./settingsSearch";

describe("settings search", () => {
  it("finds settings across pages by title and related terms, preferring exact titles", () => {
    expect(
      searchSettings("review prompt")
        .slice(0, 2)
        .map((item) => item.title),
    ).toEqual(["Review prompt", "Fix prompt"]);
    expect(searchSettings("browser recording")[0]).toMatchObject({
      title: "Browser recording frame rate",
      to: "/settings/general",
    });
    expect(searchSettings("pair phone").some((item) => item.to === "/settings/connections")).toBe(
      true,
    );
  });

  it("keeps result anchors stable and returns no results for empty or unmatched queries", () => {
    expect(settingsSearchId("UI density")).toBe("setting-ui-density");
    expect(searchSettings("  ")).toEqual([]);
    expect(searchSettings("not-a-real-setting")).toEqual([]);
  });
});
