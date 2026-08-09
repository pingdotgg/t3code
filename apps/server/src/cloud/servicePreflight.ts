import packageJson from "../../package.json" with { type: "json" };
import { SERVICE_LAUNCHER_PROTOCOL } from "./serviceProtocol.ts";

export const PROVIDER_LIFECYCLE_RECOVERY_PROTOCOL = 1 as const;
export const PROVIDER_LIFECYCLE_RECOVERY_REQUIRED_REASON =
  "This T3 Code release does not include the required automatic provider lifecycle recovery. The current server was kept running.";
export const EMPTY_COLLAB_WAIT_RECOVERY_PROTOCOL = 1 as const;
export const EMPTY_COLLAB_WAIT_RECOVERY_REQUIRED_REASON =
  "This T3 Code release does not include the required empty collaboration-wait recovery. The current server was kept running.";
// Protocol 3 requires exact-request settlement and delivery correlation at the
// projection boundary. Protocol 2 could still let a stale recovery race erase
// a newer pending turn, so it must never pass an upgrade preflight as if it
// carried the complete recovery contract.
export const PENDING_TURN_RECOVERY_PROTOCOL = 3 as const;
export const PENDING_TURN_RECOVERY_REQUIRED_REASON =
  "This T3 Code release does not include the required durable pending-turn recovery. The current server was kept running.";

export type ServicePreflightResult =
  | {
      readonly status: "ready";
      readonly version: string;
      readonly launcherProtocol: typeof SERVICE_LAUNCHER_PROTOCOL;
      readonly providerLifecycleRecoveryProtocol: typeof PROVIDER_LIFECYCLE_RECOVERY_PROTOCOL;
      readonly emptyCollabWaitRecoveryProtocol: typeof EMPTY_COLLAB_WAIT_RECOVERY_PROTOCOL;
      readonly pendingTurnRecoveryProtocol: typeof PENDING_TURN_RECOVERY_PROTOCOL;
    }
  | {
      readonly status: "blocked";
      readonly version: string;
      readonly reason: string;
    };

export function runServicePreflight(input: {
  /** Older servers always pass this flag when invoking a staged preflight. */
  readonly databasePath: string;
  readonly launcherProtocol: number;
  readonly version?: string;
}): ServicePreflightResult {
  const version = input.version ?? packageJson.version;
  if (input.launcherProtocol !== SERVICE_LAUNCHER_PROTOCOL) {
    return {
      status: "blocked",
      version,
      reason:
        "This release requires a newer T3 Code service launcher. Update it on the server machine.",
    };
  }

  return {
    status: "ready",
    version,
    launcherProtocol: SERVICE_LAUNCHER_PROTOCOL,
    providerLifecycleRecoveryProtocol: PROVIDER_LIFECYCLE_RECOVERY_PROTOCOL,
    emptyCollabWaitRecoveryProtocol: EMPTY_COLLAB_WAIT_RECOVERY_PROTOCOL,
    pendingTurnRecoveryProtocol: PENDING_TURN_RECOVERY_PROTOCOL,
  };
}

export function decodeServicePreflightResult(value: unknown): ServicePreflightResult | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    record.status === "ready" &&
    record.launcherProtocol === SERVICE_LAUNCHER_PROTOCOL &&
    typeof record.version === "string"
  ) {
    if (record.providerLifecycleRecoveryProtocol !== PROVIDER_LIFECYCLE_RECOVERY_PROTOCOL) {
      return {
        status: "blocked",
        version: record.version,
        reason: PROVIDER_LIFECYCLE_RECOVERY_REQUIRED_REASON,
      };
    }
    if (record.pendingTurnRecoveryProtocol !== PENDING_TURN_RECOVERY_PROTOCOL) {
      return {
        status: "blocked",
        version: record.version,
        reason: PENDING_TURN_RECOVERY_REQUIRED_REASON,
      };
    }
    if (record.emptyCollabWaitRecoveryProtocol !== EMPTY_COLLAB_WAIT_RECOVERY_PROTOCOL) {
      return {
        status: "blocked",
        version: record.version,
        reason: EMPTY_COLLAB_WAIT_RECOVERY_REQUIRED_REASON,
      };
    }
    return {
      status: "ready",
      version: record.version,
      launcherProtocol: SERVICE_LAUNCHER_PROTOCOL,
      providerLifecycleRecoveryProtocol: PROVIDER_LIFECYCLE_RECOVERY_PROTOCOL,
      emptyCollabWaitRecoveryProtocol: EMPTY_COLLAB_WAIT_RECOVERY_PROTOCOL,
      pendingTurnRecoveryProtocol: PENDING_TURN_RECOVERY_PROTOCOL,
    };
  }
  if (
    record.status === "blocked" &&
    typeof record.version === "string" &&
    typeof record.reason === "string"
  ) {
    return { status: "blocked", version: record.version, reason: record.reason };
  }
  return undefined;
}
