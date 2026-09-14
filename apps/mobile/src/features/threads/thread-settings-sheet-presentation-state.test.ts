import { describe, expect, it } from "vite-plus/test";

import {
  settingsSheetRouteDidDismiss,
  stackContainsRouteName,
} from "./thread-settings-sheet-presentation-state";

describe("settings sheet route presence", () => {
  it("finds the picker route on the presenting stack", () => {
    expect(
      stackContainsRouteName(
        [{ name: "Thread" }, { name: "ThreadSettingsSheet" }],
        "ThreadSettingsSheet",
      ),
    ).toBe(true);
    expect(stackContainsRouteName([{ name: "Thread" }], "ThreadSettingsSheet")).toBe(false);
    expect(stackContainsRouteName(undefined, "ThreadSettingsSheet")).toBe(false);
  });

  it("treats a swipe-dismissed form sheet as closed once the route is gone", () => {
    expect(settingsSheetRouteDidDismiss({ presented: true, sheetRouteVisible: false })).toBe(true);
    expect(settingsSheetRouteDidDismiss({ presented: true, sheetRouteVisible: true })).toBe(false);
    expect(settingsSheetRouteDidDismiss({ presented: false, sheetRouteVisible: false })).toBe(
      false,
    );
  });
});
