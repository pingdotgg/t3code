import { describe, expect, it } from "vitest";

import {
  resolveExternalSidebarControlHeight,
  shouldRenderExternalSidebarControl,
} from "./AppSidebarLayout";

describe("shouldRenderExternalSidebarControl", () => {
  it("keeps collapse inside the expanded sidebar header", () => {
    expect(shouldRenderExternalSidebarControl(true)).toBe(false);
  });

  it("renders the external control only to reopen a collapsed sidebar", () => {
    expect(shouldRenderExternalSidebarControl(false)).toBe(true);
  });
});

describe("resolveExternalSidebarControlHeight", () => {
  it("aligns desktop and browser thread routes to the compact header", () => {
    expect(resolveExternalSidebarControlHeight("/environment/thread", true)).toBe("39px");
    expect(resolveExternalSidebarControlHeight("/environment/thread", false)).toBe("40px");
    expect(resolveExternalSidebarControlHeight("/draft/draft-id", true)).toBe("39px");
  });

  it("retains the existing topbar height outside thread routes", () => {
    expect(resolveExternalSidebarControlHeight("/settings/interface", true)).toBe(
      "var(--workspace-topbar-height)",
    );
    expect(resolveExternalSidebarControlHeight("/", false)).toBe("var(--workspace-topbar-height)");
  });
});
