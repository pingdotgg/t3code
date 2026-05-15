import { describe, expect, it } from "vitest";

import { shouldRenderMainSidebarTrigger } from "./MainSidebarTrigger";

describe("shouldRenderMainSidebarTrigger", () => {
  it("hides the main header trigger when the desktop sidebar is open", () => {
    expect(
      shouldRenderMainSidebarTrigger({
        isMobile: false,
        open: true,
        openMobile: false,
      }),
    ).toBe(false);
  });

  it("shows the main header trigger when the desktop sidebar is closed", () => {
    expect(
      shouldRenderMainSidebarTrigger({
        isMobile: false,
        open: false,
        openMobile: false,
      }),
    ).toBe(true);
  });

  it("uses the mobile sheet state on mobile", () => {
    expect(
      shouldRenderMainSidebarTrigger({
        isMobile: true,
        open: true,
        openMobile: true,
      }),
    ).toBe(false);
    expect(
      shouldRenderMainSidebarTrigger({
        isMobile: true,
        open: true,
        openMobile: false,
      }),
    ).toBe(true);
  });
});
