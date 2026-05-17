import { describe, expect, it } from "@effect/vitest";

import { authProbeTimeoutForDistribution } from "./AcpRegistryService.ts";

describe("authProbeTimeoutForDistribution", () => {
  it("keeps binary auth probes tight", () => {
    expect(authProbeTimeoutForDistribution("binary")).toBe("4 seconds");
  });

  it("gives package-managed agents more first-start time", () => {
    expect(authProbeTimeoutForDistribution("npx")).toBe("25 seconds");
    expect(authProbeTimeoutForDistribution("uvx")).toBe("25 seconds");
  });
});
