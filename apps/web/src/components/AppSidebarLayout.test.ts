import { describe, expect, it } from "vitest";

import { shouldAcceptThreadSidebarWidth } from "./AppSidebarLayout";

describe("shouldAcceptThreadSidebarWidth", () => {
  it("allows shrinking even when the sidebar is wider than the available content area", () => {
    expect(
      shouldAcceptThreadSidebarWidth({
        currentWidth: 900,
        nextWidth: 800,
        wrapperClientWidth: 700,
      }),
    ).toBe(true);
  });

  it("rejects expansion that would leave less than the minimum main content width", () => {
    expect(
      shouldAcceptThreadSidebarWidth({
        currentWidth: 500,
        nextWidth: 600,
        wrapperClientWidth: 1_000,
      }),
    ).toBe(false);
  });

  it("allows expansion when the main content minimum remains available", () => {
    expect(
      shouldAcceptThreadSidebarWidth({
        currentWidth: 300,
        nextWidth: 340,
        wrapperClientWidth: 1_000,
      }),
    ).toBe(true);
  });
});
