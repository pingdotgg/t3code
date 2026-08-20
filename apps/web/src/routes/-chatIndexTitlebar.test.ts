// @effect-diagnostics nodeBuiltinImport:off
// Regression coverage compares the onboarding header with the shared titlebar contract.
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

describe("hosted static onboarding header", () => {
  it("uses the shared workspace topbar geometry", () => {
    const routeSource = NodeFS.readFileSync(new URL("./_chat.index.tsx", import.meta.url), "utf8");
    const onboardingStart = routeSource.indexOf("function HostedStaticOnboardingState()");
    const onboardingEnd = routeSource.indexOf('<Empty className="flex-1">', onboardingStart);

    expect(onboardingStart).toBeGreaterThanOrEqual(0);
    expect(onboardingEnd).toBeGreaterThan(onboardingStart);

    const onboardingHeader = routeSource.slice(onboardingStart, onboardingEnd);

    expect(onboardingHeader).toContain("<WorkspacePageHeader");
    expect(onboardingHeader).not.toMatch(/(?:^|\s)(?:[\w-]+:)*py-/);

    const headerSource = NodeFS.readFileSync(
      new URL("../components/WorkspacePageHeader.tsx", import.meta.url),
      "utf8",
    );
    expect(headerSource).toContain("h-[var(--workspace-topbar-height)]");
    expect(headerSource).toContain("min-h-[var(--workspace-topbar-height)]");
    expect(headerSource).toContain("COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS");
  });
});
