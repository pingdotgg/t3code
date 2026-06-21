import { describe, expect, it } from "@effect/vitest";

import { shouldRenderMainSidebarTrigger } from "./MainSidebarTrigger";

describe("shouldRenderMainSidebarTrigger", () => {
  it("hides the main header trigger when the desktop sidebar is open", () => {
    expect(
      shouldRenderMainSidebarTrigger({
        isMobile: false,
        open: true,
      }),
    ).toBe(false);
  });

  it("shows the main header trigger when the desktop sidebar is closed", () => {
    expect(
      shouldRenderMainSidebarTrigger({
        isMobile: false,
        open: false,
      }),
    ).toBe(true);
  });

  it("keeps the main header trigger visible on mobile", () => {
    expect(
      shouldRenderMainSidebarTrigger({
        isMobile: true,
        open: true,
      }),
    ).toBe(true);
  });
});
