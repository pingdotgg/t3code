import { describe, expect, it } from "vitest";
import { shouldOpenProjectFolderPickerImmediately } from "./Sidebar.logic";

describe("shouldOpenProjectFolderPickerImmediately", () => {
  it("opens the folder picker immediately in Electron on desktop", () => {
    expect(
      shouldOpenProjectFolderPickerImmediately({
        isElectron: true,
        isMobile: false,
      }),
    ).toBe(true);
  });

  it("keeps manual project entry on mobile Electron layouts", () => {
    expect(
      shouldOpenProjectFolderPickerImmediately({
        isElectron: true,
        isMobile: true,
      }),
    ).toBe(false);
  });

  it("keeps manual project entry outside Electron", () => {
    expect(
      shouldOpenProjectFolderPickerImmediately({
        isElectron: false,
        isMobile: false,
      }),
    ).toBe(false);
  });
});
