import { describe, expect, it } from "vite-plus/test";

import { resolveWizardEnvironmentStatus } from "./WelcomeWizard.logic";

const connection = (
  phase: Parameters<typeof resolveWizardEnvironmentStatus>[0]["connection"]["phase"],
) => ({ phase, error: null, traceId: null });

describe("resolveWizardEnvironmentStatus", () => {
  it("reports a switched-off computer as off whatever its phase", () => {
    for (const phase of ["available", "connecting", "connected", "error"] as const) {
      expect(
        resolveWizardEnvironmentStatus({ enabled: false, connection: connection(phase) }),
      ).toEqual({ kind: "off", text: "Off" });
    }
  });

  it("shows the reason for an unsupported server instead of offering to turn it on", () => {
    expect(
      resolveWizardEnvironmentStatus({
        enabled: false,
        unsupportedReason: "server too old",
        connection: connection("unsupported"),
      }),
    ).toEqual({ kind: "unsupported", text: "Not supported: server too old" });
  });

  it("shows the live connection label for a computer that is on", () => {
    const status = (phase: Parameters<typeof connection>[0]) =>
      resolveWizardEnvironmentStatus({ enabled: true, connection: connection(phase) });

    expect(status("connected")).toEqual({ kind: "on", text: "Connected" });
    expect(status("connecting")).toEqual({ kind: "on", text: "Connecting…" });
    expect(status("available")).toEqual({ kind: "on", text: "Not connected" });
    expect(status("error")).toEqual({ kind: "on", text: "Connection failed" });
  });
});
