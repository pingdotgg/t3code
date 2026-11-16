import { describe, expect, it } from "vite-plus/test";
import {
  NAVIGATION_TAB_ORDER,
  navigationCustomizationAvailable,
  moveNavigationTab,
  overflowNavigationTabs,
  enabledNavigationTabs,
  sharedSlotAbsentee,
  toggleNavigationTabVisibility,
  resolveSelectedNavigationTab,
  resolveNavigationTabOrder,
  selectedNavigationTab,
  visibleNavigationTabs,
} from "./navigation-tab-order";

describe("navigation tab order", () => {
  it("enables customization only above four registered sections, excluding Settings", () => {
    expect(navigationCustomizationAvailable()).toBe(false);
    expect(navigationCustomizationAvailable(3)).toBe(false);
    expect(navigationCustomizationAvailable(4)).toBe(false);
    expect(navigationCustomizationAvailable(5)).toBe(true);
    expect(navigationCustomizationAvailable(6)).toBe(true);
  });

  it("fills missing sections and drops removed placeholders, duplicates, and Settings", () => {
    expect(
      resolveNavigationTabOrder(["usage", "home", "inbox", "settings", "usage", null]),
    ).toEqual(["usage", "threads", "pullRequests", "issues"]);
    expect(resolveNavigationTabOrder()).toEqual(NAVIGATION_TAB_ORDER);
  });

  it("gives the shared slot to the open list, or else the one opened last", () => {
    expect(sharedSlotAbsentee("issues", "pullRequests")).toBe("pullRequests");
    expect(sharedSlotAbsentee("pullRequests", "issues")).toBe("issues");
    expect(sharedSlotAbsentee("threads", "issues")).toBe("pullRequests");
    expect(sharedSlotAbsentee("usage", undefined)).toBe("issues");
  });

  it("moves a section without changing the relative order of the others", () => {
    for (const tab of NAVIGATION_TAB_ORDER) {
      for (let position = 0; position < NAVIGATION_TAB_ORDER.length; position++) {
        const order = moveNavigationTab(NAVIGATION_TAB_ORDER, tab, position);
        expect(order[position]).toBe(tab);
        expect(order.filter((other) => other !== tab)).toEqual(
          NAVIGATION_TAB_ORDER.filter((other) => other !== tab),
        );
      }
    }
  });

  it("shows every real section without overflow and keeps Settings selected during editing", () => {
    expect(visibleNavigationTabs()).toEqual(NAVIGATION_TAB_ORDER);
    expect(overflowNavigationTabs()).toEqual([]);
    expect(selectedNavigationTab(undefined, "threads", true)).toBe("settings");
    expect(selectedNavigationTab(undefined, "usage", false)).toBe("usage");
    expect(selectedNavigationTab(undefined, "usage", false, [], 2)).toBe("settings");
  });

  it("removes hidden sections from navigation and restores their saved positions", () => {
    const order = moveNavigationTab(undefined, "usage", 0);
    const hidden = toggleNavigationTabVisibility([], "usage");
    expect(enabledNavigationTabs(order, hidden)).toEqual(["threads", "pullRequests", "issues"]);
    expect(toggleNavigationTabVisibility(hidden, "usage")).toEqual([]);
    expect(visibleNavigationTabs(order, [], 5)).toEqual(order);
    expect(enabledNavigationTabs(undefined, ["home", "inbox", "settings"])).toEqual(
      NAVIGATION_TAB_ORDER,
    );
  });

  it("falls back when the selected section is hidden, including when all are hidden", () => {
    expect(resolveSelectedNavigationTab(undefined, ["threads"], "threads")).toBe("pullRequests");
    expect(resolveSelectedNavigationTab(undefined, ["threads"], "usage")).toBe("usage");
    expect(
      resolveSelectedNavigationTab(undefined, NAVIGATION_TAB_ORDER, "threads"),
    ).toBeUndefined();
  });
});
