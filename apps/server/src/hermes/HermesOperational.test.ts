import { describe, expect, it } from "vite-plus/test";
import { HermesSettings, type HermesGatewayCompatibility } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import {
  assessHermesOnboarding,
  buildHermesOperationalDiagnostics,
  deriveHermesUpgradeGate,
  projectHermesFeatureDiagnostics,
  projectHermesRecoveryControls,
  sanitizeHermesImportProgress,
} from "./HermesOperational.ts";

const decodeHermesSettings = Schema.decodeSync(HermesSettings);

const settings = decodeHermesSettings({
  endpoint: "ws://127.0.0.1:9119/api/ws",
  profileKey: "work",
});

const supported: HermesGatewayCompatibility = {
  status: "supported",
  protocol: { major: 1, minor: 3 },
  capabilities: [
    "session.lifecycle",
    "session.history",
    "turn.prompt",
    "turn.interrupt",
    "attachments.image",
  ],
  inventory: null,
  reason: "supported",
  serverVersion: "1.3.0",
};

describe("Hermes operational onboarding and gates", () => {
  it("validates local onboarding without exposing the gateway token", () => {
    const result = assessHermesOnboarding(settings, {
      gatewayToken: "private-gateway-token",
      remoteGloballyEnabled: false,
      remotePairingToken: undefined,
      remoteTlsCertificateSha256: undefined,
    });

    expect(result.status).toBe("ready");
    expect(result.diagnosticEndpoint).not.toContain("private-gateway-token");
  });

  it("requires an upgrade for unsupported protocols or missing recovery capabilities", () => {
    expect(
      deriveHermesUpgradeGate({
        ...supported,
        protocol: { major: 2, minor: 0 },
        status: "unsupported",
      }).status,
    ).toBe("upgrade_required");
    expect(
      deriveHermesUpgradeGate({
        ...supported,
        capabilities: ["session.lifecycle"],
      }),
    ).toMatchObject({
      status: "upgrade_required",
      missingCapabilities: ["session.history", "turn.prompt", "turn.interrupt"],
    });
  });

  it("keeps optional features off unless both instance switch and capability agree", () => {
    const enabled = decodeHermesSettings({
      ...settings,
      attachmentsEnabled: true,
      importEnabled: true,
      proactiveEnabled: true,
    });
    const diagnostics = projectHermesFeatureDiagnostics(enabled, supported);

    expect(diagnostics.find((entry) => entry.feature === "attachments")).toMatchObject({
      requested: true,
      available: true,
    });
    expect(diagnostics.find((entry) => entry.feature === "import")).toMatchObject({
      requested: true,
      available: false,
      missingCapabilities: ["profile.import"],
    });
    expect(diagnostics.find((entry) => entry.feature === "proactive")).toMatchObject({
      requested: true,
      available: false,
    });
  });

  it("recognizes the negotiated ephemeral session MCP lease capability", () => {
    const enabled = decodeHermesSettings({
      ...settings,
      mcpEnabled: true,
    });
    const diagnostics = projectHermesFeatureDiagnostics(enabled, {
      ...supported,
      capabilities: [...supported.capabilities, "session_mcp"],
    });

    expect(diagnostics.find((entry) => entry.feature === "mcp")).toMatchObject({
      requested: true,
      available: true,
      missingCapabilities: [],
    });
  });
});

describe("Hermes recovery and sanitized diagnostics", () => {
  it("never offers process stop for an externally started gateway", () => {
    const controls = projectHermesRecoveryControls({
      connectionState: "ready",
      compatibility: supported,
      processOwnership: "external",
      ownedProcessStopAvailable: true,
    });

    expect(controls.find((control) => control.control === "reconnect")?.supported).toBe(true);
    expect(controls.find((control) => control.control === "stop_owned_process")).toMatchObject({
      supported: false,
      reason: "Hermes was started externally; T3 does not own or stop this process.",
    });
    expect(controls.find((control) => control.control === "revoke_all")?.supported).toBe(false);
  });

  it("redacts every endpoint query value and emits counts instead of import details", () => {
    const diagnostics = buildHermesOperationalDiagnostics({
      endpoint: "ws://127.0.0.1:9119/api/ws?token=secret&label=private",
      profileKey: "work",
      settings,
      compatibility: supported,
      connection: {
        state: "ready",
        reconnectAttempt: 0,
        protocolStatus: "supported",
        protocolMajor: 1,
        protocolMinor: 3,
        serverVersion: "1.3.0",
        capabilities: supported.capabilities,
        writesBlocked: false,
        indeterminateMutationCount: 0,
      },
    });
    const progress = sanitizeHermesImportProgress({
      status: "running",
      completed: 3,
      total: 10,
      attempt: 1,
      path: "/private/profile",
      error: "secret",
    });

    expect(diagnostics.endpoint).not.toContain("secret");
    expect(diagnostics.endpoint).not.toContain("private");
    expect(diagnostics.processOwnership).toBe("external");
    expect(progress).toEqual({
      status: "running",
      completed: 3,
      total: 10,
      attempt: 1,
      canRetry: false,
      canCancel: true,
    });
  });
});
