import type { HermesGatewayCompatibility, HermesSettings } from "@t3tools/contracts";

import type { HermesGatewayConnectionState, HermesGatewayHealth } from "./HermesGatewayClient.ts";
import {
  assessHermesConnectionSecurity,
  sanitizeHermesEndpoint,
  type HermesConnectionSecurityInput,
} from "./HermesConnectionSecurity.ts";

export const HERMES_CORE_CAPABILITIES = [
  "session.lifecycle",
  "session.history",
  "turn.prompt",
  "turn.interrupt",
] as const;

export type HermesFeatureName = "remote" | "import" | "mcp" | "attachments" | "proactive" | "voice";

export interface HermesFeatureDiagnostic {
  readonly feature: HermesFeatureName;
  readonly requested: boolean;
  readonly available: boolean;
  readonly missingCapabilities: ReadonlyArray<string>;
  readonly reason: string;
}

export type HermesUpgradeGate =
  | { readonly status: "ready"; readonly reason: string }
  | { readonly status: "degraded"; readonly reason: string }
  | {
      readonly status: "upgrade_required";
      readonly reason: string;
      readonly missingCapabilities: ReadonlyArray<string>;
    };

export type HermesRecoveryControlName =
  | "reconnect"
  | "revoke_all"
  | "quarantine"
  | "pause_ingestion"
  | "stop_owned_process";

export interface HermesRecoveryControl {
  readonly control: HermesRecoveryControlName;
  readonly supported: boolean;
  readonly reason: string;
}

export interface HermesOperationalDiagnostics {
  readonly connection: HermesGatewayHealth;
  readonly endpoint: string;
  readonly profileConfigured: boolean;
  readonly upgradeGate: HermesUpgradeGate;
  readonly features: ReadonlyArray<HermesFeatureDiagnostic>;
  readonly recoveryControls: ReadonlyArray<HermesRecoveryControl>;
  readonly processOwnership: "external" | "t3_owned";
}

export interface HermesImportProgress {
  readonly status: "pending" | "running" | "completed" | "failed" | "cancelled" | "unknown";
  readonly completed: number | null;
  readonly total: number | null;
  readonly attempt: number | null;
  readonly canRetry: boolean;
  readonly canCancel: boolean;
}

const FEATURE_CAPABILITIES: Readonly<
  Record<Exclude<HermesFeatureName, "remote" | "attachments">, ReadonlyArray<string>>
> = {
  import: ["profile.import"],
  mcp: ["session_mcp"],
  proactive: ["cron.events.global_cursor", "events.stable_ids"],
  voice: ["voice"],
};

const RECOVERY_CAPABILITIES: Readonly<
  Record<Exclude<HermesRecoveryControlName, "reconnect" | "stop_owned_process">, string>
> = {
  revoke_all: "auth.revoke_all",
  quarantine: "gateway.quarantine",
  pause_ingestion: "ingestion.pause",
};

export function assessHermesOnboarding(
  settings: HermesSettings,
  security: Omit<HermesConnectionSecurityInput, "endpoint" | "remoteInstanceEnabled">,
) {
  return assessHermesConnectionSecurity({
    ...security,
    endpoint: settings.endpoint,
    remoteInstanceEnabled: settings.remoteAccessEnabled,
  });
}

export function deriveHermesUpgradeGate(
  compatibility: HermesGatewayCompatibility | undefined,
): HermesUpgradeGate {
  if (compatibility === undefined) {
    return {
      status: "degraded",
      reason: "Gateway version and capabilities have not been negotiated.",
    };
  }
  if (compatibility.status === "unsupported") {
    return {
      status: "upgrade_required",
      reason: compatibility.reason,
      missingCapabilities: [],
    };
  }
  if (compatibility.status === "legacy") {
    return {
      status: "degraded",
      reason:
        "Gateway does not advertise a protocol version; optional and destructive operations remain unavailable.",
    };
  }
  const available = new Set(compatibility.capabilities);
  const missingCapabilities = HERMES_CORE_CAPABILITIES.filter(
    (capability) => !available.has(capability),
  );
  return missingCapabilities.length === 0
    ? { status: "ready", reason: compatibility.reason }
    : {
        status: "upgrade_required",
        reason: "Gateway is missing capabilities required for safe session recovery.",
        missingCapabilities,
      };
}

export function projectHermesFeatureDiagnostics(
  settings: HermesSettings,
  compatibility: HermesGatewayCompatibility | undefined,
): ReadonlyArray<HermesFeatureDiagnostic> {
  const available = new Set(compatibility?.capabilities ?? []);
  const requested: Readonly<Record<HermesFeatureName, boolean>> = {
    remote: settings.remoteAccessEnabled,
    import: settings.importEnabled,
    mcp: settings.mcpEnabled,
    attachments: settings.attachmentsEnabled,
    proactive: settings.proactiveEnabled,
    voice: settings.voiceEnabled,
  };
  const required = (feature: HermesFeatureName): ReadonlyArray<string> => {
    if (feature === "remote") return [];
    if (feature === "attachments") {
      return ["attachments.image|attachments.file|attachments.pdf"];
    }
    return FEATURE_CAPABILITIES[feature];
  };
  return (Object.keys(requested) as HermesFeatureName[]).map((feature) => {
    const missingCapabilities =
      feature === "attachments"
        ? [...available].some((capability) => capability.startsWith("attachments."))
          ? []
          : required(feature)
        : required(feature).filter((capability) => !available.has(capability));
    const isAvailable =
      feature === "remote"
        ? false
        : compatibility?.status === "supported" && missingCapabilities.length === 0;
    const reason = !requested[feature]
      ? "Disabled for this instance."
      : feature === "remote"
        ? "Remote transport remains blocked until scoped pairing and TLS pin verification are implemented."
        : isAvailable
          ? "Enabled and advertised by the gateway."
          : compatibility?.status === "legacy"
            ? "Unavailable without a negotiated capability inventory."
            : "Requested but not advertised by the gateway.";
    return {
      feature,
      requested: requested[feature],
      available: requested[feature] && isAvailable,
      missingCapabilities,
      reason,
    };
  });
}

export function projectHermesRecoveryControls(input: {
  readonly connectionState: HermesGatewayConnectionState;
  readonly compatibility: HermesGatewayCompatibility | undefined;
  readonly processOwnership: "external" | "t3_owned";
  readonly ownedProcessStopAvailable: boolean;
}): ReadonlyArray<HermesRecoveryControl> {
  const capabilities = new Set(input.compatibility?.capabilities ?? []);
  const controls: HermesRecoveryControl[] = [
    {
      control: "reconnect",
      supported: input.connectionState !== "closed",
      reason:
        input.connectionState === "closed"
          ? "The client has been permanently closed."
          : "Reconnects only the T3-owned WebSocket client; it does not restart Hermes.",
    },
  ];
  for (const control of ["revoke_all", "quarantine", "pause_ingestion"] as const) {
    const capability = RECOVERY_CAPABILITIES[control];
    const supported = input.compatibility?.status === "supported" && capabilities.has(capability);
    controls.push({
      control,
      supported,
      reason: supported
        ? `Gateway advertises ${capability}.`
        : `Gateway does not advertise ${capability}; no operation is exposed.`,
    });
  }
  const canStopOwnedProcess =
    input.processOwnership === "t3_owned" && input.ownedProcessStopAvailable;
  controls.push({
    control: "stop_owned_process",
    supported: canStopOwnedProcess,
    reason: canStopOwnedProcess
      ? "Available for a process launched and tracked by this T3 runtime."
      : input.processOwnership === "external"
        ? "Hermes was started externally; T3 does not own or stop this process."
        : "No verified owned-process stop handle is available.",
  });
  return controls;
}

export function buildHermesOperationalDiagnostics(input: {
  readonly endpoint: string;
  readonly profileKey: string;
  readonly settings: HermesSettings;
  readonly connection: HermesGatewayHealth;
  readonly compatibility: HermesGatewayCompatibility | undefined;
  readonly processOwnership?: "external" | "t3_owned";
  readonly ownedProcessStopAvailable?: boolean;
}): HermesOperationalDiagnostics {
  const processOwnership = input.processOwnership ?? "external";
  return {
    connection: input.connection,
    endpoint: sanitizeHermesEndpoint(input.endpoint),
    profileConfigured: input.profileKey.trim().length > 0,
    upgradeGate: deriveHermesUpgradeGate(input.compatibility),
    features: projectHermesFeatureDiagnostics(input.settings, input.compatibility),
    recoveryControls: projectHermesRecoveryControls({
      connectionState: input.connection.state,
      compatibility: input.compatibility,
      processOwnership,
      ownedProcessStopAvailable: input.ownedProcessStopAvailable === true,
    }),
    processOwnership,
  };
}

export function sanitizeHermesImportProgress(value: unknown): HermesImportProgress {
  const record = isRecord(value) ? value : {};
  const status = readImportStatus(record.status);
  return {
    status,
    completed: readNonNegativeNumber(record.completed),
    total: readNonNegativeNumber(record.total),
    attempt: readNonNegativeNumber(record.attempt),
    canRetry: status === "failed",
    canCancel: status === "pending" || status === "running",
  };
}

function readImportStatus(value: unknown): HermesImportProgress["status"] {
  return value === "pending" ||
    value === "running" ||
    value === "completed" ||
    value === "failed" ||
    value === "cancelled"
    ? value
    : "unknown";
}

function readNonNegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
