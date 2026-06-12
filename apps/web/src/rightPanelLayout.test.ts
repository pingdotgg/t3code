import { describe, expect, it } from "vitest";

import { resolveRightFilePanelVisibility } from "./rightPanelLayout";

describe("resolveRightFilePanelVisibility", () => {
  it("hides source control behind an open diff without clearing its open state", () => {
    expect(
      resolveRightFilePanelVisibility({
        diffOpen: true,
        filePanelOpen: true,
        hasStoredFilePanelContext: false,
        sourceControlOpen: true,
        useSheet: false,
      }),
    ).toEqual({
      open: false,
      renderContent: false,
      sourceControlHiddenByDiff: true,
    });
  });

  it("keeps ordinary file preview visible while diff is open", () => {
    expect(
      resolveRightFilePanelVisibility({
        diffOpen: true,
        filePanelOpen: true,
        hasStoredFilePanelContext: true,
        sourceControlOpen: false,
        useSheet: false,
      }),
    ).toEqual({
      open: true,
      renderContent: true,
      sourceControlHiddenByDiff: false,
    });
  });

  it("keeps cached file content mounted while closed only in inline layout", () => {
    expect(
      resolveRightFilePanelVisibility({
        diffOpen: false,
        filePanelOpen: false,
        hasStoredFilePanelContext: true,
        sourceControlOpen: false,
        useSheet: false,
      }).renderContent,
    ).toBe(true);

    expect(
      resolveRightFilePanelVisibility({
        diffOpen: false,
        filePanelOpen: false,
        hasStoredFilePanelContext: true,
        sourceControlOpen: false,
        useSheet: true,
      }).renderContent,
    ).toBe(false);
  });
});
