import { describe, expect, it } from "vite-plus/test";

import { resolveSidebarSheetTriggerInsetClass } from "./SidebarChrome";

describe("resolveSidebarSheetTriggerInsetClass", () => {
  it("aligns the sheet trigger with the floating control on desktop", () => {
    expect(resolveSidebarSheetTriggerInsetClass(true)).toBe(
      "ml-[calc(var(--workspace-controls-left)-0.75rem)]",
    );
  });

  it("keeps the header padding on web and mobile", () => {
    expect(resolveSidebarSheetTriggerInsetClass(false)).toBeNull();
  });
});
