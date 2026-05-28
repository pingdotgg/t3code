import { describe, expect, it } from "vitest";

import { shouldShowNoActiveThreadSidebarTrigger } from "./NoActiveThreadState";

describe("shouldShowNoActiveThreadSidebarTrigger", () => {
  it("shows the trigger when the mobile sidebar sheet is closed", () => {
    expect(
      shouldShowNoActiveThreadSidebarTrigger({
        isMobile: true,
        open: true,
        openMobile: false,
      }),
    ).toBe(true);
  });

  it("hides the trigger when the mobile sidebar sheet is already open", () => {
    expect(
      shouldShowNoActiveThreadSidebarTrigger({
        isMobile: true,
        open: true,
        openMobile: true,
      }),
    ).toBe(false);
  });

  it("shows the trigger when the desktop sidebar is collapsed", () => {
    expect(
      shouldShowNoActiveThreadSidebarTrigger({
        isMobile: false,
        open: false,
        openMobile: false,
      }),
    ).toBe(true);
  });

  it("hides the trigger when the desktop sidebar is expanded", () => {
    expect(
      shouldShowNoActiveThreadSidebarTrigger({
        isMobile: false,
        open: true,
        openMobile: false,
      }),
    ).toBe(false);
  });
});
