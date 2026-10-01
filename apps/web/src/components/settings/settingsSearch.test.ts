import { describe, expect, it, vi } from "vitest";

import { searchSettings, settingsSearchId } from "./settingsSearch";

vi.mock("../../env", () => ({ isElectron: true }));

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

  it("finds font and device settings with plural queries", () => {
    expect(searchSettings("fonts").some((item) => item.title === "Interface font")).toBe(true);
    expect(searchSettings("devices").some((item) => item.title === "Device support")).toBe(true);
  });

  it("routes storage and keybindings settings to their dedicated pages", () => {
    expect(
      searchSettings("keybindings").find((item) => item.to === "/settings/keybindings"),
    ).toMatchObject({
      title: "Keybindings",
      to: "/settings/keybindings",
      id: "section-shortcuts",
    });
    expect(searchSettings("delete merged worktrees")[0]).toMatchObject({
      title: "Delete merged worktrees",
      to: "/settings/storage",
    });
  });

  it("routes appearance and provider settings to their dedicated pages", () => {
    expect(searchSettings("theme")[0]).toMatchObject({
      title: "Theme",
      to: "/settings/appearance",
    });
    expect(searchSettings("sidebar icon size")[0]).toMatchObject({
      title: "Sidebar icon size",
      to: "/settings/appearance",
    });
    expect(searchSettings("delegated thread model")[0]).toMatchObject({
      title: "Delegated thread model",
      to: "/settings/providers",
    });
    expect(searchSettings("default model")[0]).toMatchObject({
      title: "Default model",
      to: "/settings/providers",
    });
    expect(searchSettings("providers")[0]).toMatchObject({
      title: "Providers",
      to: "/settings/providers",
    });
  });

  it("finds visible settings added outside the main row list", () => {
    expect(searchSettings("update track")[0]).toMatchObject({
      title: "Update track",
      id: "setting-update-track",
      to: "/settings/general",
    });
    expect(searchSettings("local source", { localRebuildEnabled: true })[0]).toMatchObject({
      title: "Local source",
      id: "setting-local-source",
    });
    expect(searchSettings("local source")).toEqual([]);
    expect(searchSettings("sidebar icon size")[0]?.title).toBe("Sidebar icon size");
    expect(searchSettings("normal message preview")[0]?.title).toBe("Normal message preview");
  });
});
