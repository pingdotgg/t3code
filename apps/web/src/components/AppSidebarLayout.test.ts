import { describe, expect, it } from "vitest";

import { shouldRenderExternalSidebarControl } from "./AppSidebarLayout";

describe("shouldRenderExternalSidebarControl", () => {
  it("keeps collapse inside the expanded sidebar header", () => {
    expect(shouldRenderExternalSidebarControl(true)).toBe(false);
  });

  it("renders the external control only to reopen a collapsed sidebar", () => {
    expect(shouldRenderExternalSidebarControl(false)).toBe(true);
  });
});
