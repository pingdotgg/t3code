// @effect-diagnostics nodeBuiltinImport:off - Regression coverage compares the onboarding header with the shared titlebar contract.
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

describe("hosted static onboarding header", () => {
  it("uses the shared workspace topbar geometry", () => {
    const routeSource = NodeFS.readFileSync(new URL("./_chat.index.tsx", import.meta.url), "utf8");
    const onboardingHeader = routeSource.slice(
      routeSource.indexOf("function HostedStaticOnboardingState()"),
      routeSource.indexOf(
        '<Empty className="flex-1">',
        routeSource.indexOf("function HostedStaticOnboardingState()"),
      ),
    );

    expect(onboardingHeader).toContain("workspace-topbar");
    expect(onboardingHeader).not.toMatch(/(?:^|:)py-/);
  });
});
