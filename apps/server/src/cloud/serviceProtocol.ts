import type { ServerSelfUpdateOutcome } from "@t3tools/contracts";

export const SERVICE_LAUNCHER_PROTOCOL = 1 as const;
export const SERVICE_STATE_SCHEMA_VERSION = 1 as const;
export const SERVICE_HANDOFF_EXIT_CODE = 75 as const;
export const SERVICE_LAUNCHER_CONTEXT_ENV = "T3_SERVICE_LAUNCHER_CONTEXT";
export const SERVICE_LAUNCHER_FILE = "service-launcher.mjs";
export const SERVICE_STATE_FILE = "service-state.json";

export interface PendingServiceUpdate {
  readonly id: string;
  readonly fromVersion: string;
  readonly targetVersion: string;
  readonly status: "pending";
  readonly requestedAt: string;
}

export type ServiceUpdateRecord = PendingServiceUpdate | ServerSelfUpdateOutcome;

export interface ServiceState {
  readonly schemaVersion: typeof SERVICE_STATE_SCHEMA_VERSION;
  readonly launcherProtocol: typeof SERVICE_LAUNCHER_PROTOCOL;
  readonly activeVersion: string;
  readonly update?: ServiceUpdateRecord;
}

/** Context is copied from launcher-owned state when a child is spawned. */
export interface ServiceLauncherContext {
  readonly protocol: typeof SERVICE_LAUNCHER_PROTOCOL;
  readonly activeVersion: string;
  readonly childVersion: string;
  readonly trial: boolean;
  readonly update?: ServiceUpdateRecord;
}

export type ServiceLauncherChildMessage =
  | {
      readonly type: "request-update";
      readonly fromVersion: string;
      readonly targetVersion: string;
    }
  | {
      readonly type: "prepared";
      readonly updateId: string;
    };

export type ServiceLauncherParentMessage =
  | {
      readonly type: "update-accepted";
      readonly update: PendingServiceUpdate;
    }
  | {
      readonly type: "update-rejected";
      readonly reason: string;
    }
  | {
      readonly type: "committed";
      readonly update: ServerSelfUpdateOutcome & { readonly status: "committed" };
    };

export const isExactServiceVersion = (version: string): boolean =>
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version);
