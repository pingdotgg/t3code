import { describe, expect, it } from "vite-plus/test";

import { resolveWizardEnvironmentStatus } from "./WelcomeWizard.logic";

describe("resolveWizardEnvironmentStatus", () => {
  it("reports a switched-off computer as off whatever its phase", () => {
    for (const phase of ["available", "connecting", "connected", "error"] as const) {
      expect(resolveWizardEnvironmentStatus({ enabled: false, phase, error: null })).toEqual({
        kind: "off",
        text: "Off",
      });
    }
  });

  it("shows the reason for an unsupported server instead of offering to turn it on", () => {
    expect(
      resolveWizardEnvironmentStatus({
        enabled: false,
        unsupportedReason: "server too old",
        phase: "unsupported",
        error: null,
      }),
    ).toEqual({ kind: "failed", text: "Not supported: server too old" });
  });

  it("names the non-connected phases instead of showing them as connecting", () => {
    const status = (
      phase: Parameters<typeof resolveWizardEnvironmentStatus>[0]["phase"],
      error: string | null = null,
    ) => resolveWizardEnvironmentStatus({ enabled: true, phase, error }).text;

    expect(status("connected")).toBe("Connected");
    expect(status("offline")).toBe("Offline");
    expect(status("error", "session expired")).toBe("Connection failed: session expired");
    expect(status("error")).toBe("Connection failed");
    expect(status("unsupported", "server too old")).toBe("Not supported: server too old");
    expect(status("available")).toBe("Connecting…");
    expect(status("connecting")).toBe("Connecting…");
    expect(status("reconnecting")).toBe("Connecting…");
  });
});
