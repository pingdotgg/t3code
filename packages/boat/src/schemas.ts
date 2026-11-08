import * as Schema from "effect/Schema";
import {
  BoatSandboxSize,
  BoatSandboxState,
  BoatSandboxSummary,
  BoatDesktopStreamSession,
} from "@t3tools/contracts";
export { BoatSandboxSize, BoatSandboxState, BoatSandboxSummary, BoatDesktopStreamSession };

export const BoatSandboxDetails = BoatSandboxSummary;
export type BoatSandboxDetails = typeof BoatSandboxDetails.Type;
export const CreateSandboxInput = Schema.Struct({
  name: Schema.String,
  requestId: Schema.optionalKey(Schema.String),
  size: Schema.optionalKey(BoatSandboxSize),
  autoStopMinutes: Schema.optionalKey(Schema.Number),
  template: Schema.optionalKey(Schema.String),
});
export type CreateSandboxInput = typeof CreateSandboxInput.Type;
export interface DesktopUrlInput {
  readonly theme?: "dark" | "light";
  readonly viewMode?: "desktop" | "browser";
}
export const SshKeyResponse = Schema.Struct({
  machineIp: Schema.NullOr(Schema.String),
  sshEndpoint: Schema.NullOr(Schema.String),
  sshUser: Schema.String,
  hostKey: Schema.String,
});
export type SshKeyResponse = typeof SshKeyResponse.Type;
export const ExposedPortResponse = Schema.Struct({
  port: Schema.Int,
  url: Schema.String,
  isProtected: Schema.Boolean,
});
export type ExposedPortResponse = typeof ExposedPortResponse.Type;

export const BoatSandbox = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1)),
  name: Schema.String,
  state: Schema.Literals([
    "init",
    "provisioning",
    "provisioned",
    "cloning",
    "ready",
    "idle",
    "running",
    "archiving",
    "archived",
    "error",
    "cancelled",
  ]),
  type: Schema.optionalKey(BoatSandboxSize),
  health: Schema.optionalKey(Schema.Literals(["ok", "degraded"])),
  createdAt: Schema.optionalKey(Schema.NullOr(Schema.String)),
  archiveAfter: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export function mapBoatSandbox(raw: typeof BoatSandbox.Type): BoatSandboxDetails {
  const state =
    raw.health === "degraded"
      ? "degraded"
      : raw.state === "archived"
        ? "stopped"
        : raw.state === "archiving"
          ? "stopping"
          : raw.state === "cancelled" || raw.state === "error"
            ? "error"
            : raw.state === "ready" || raw.state === "idle" || raw.state === "running"
              ? "ready"
              : "starting";
  return {
    sandboxId: raw.id,
    name: raw.name,
    state,
    size: raw.type ?? "default",
    autoStopDeadline: raw.archiveAfter ?? null,
    createdAt: raw.createdAt ?? "",
    hourlyRateUsd: null,
  };
}
export const BoatListResponse = Schema.Struct({
  ok: Schema.Literal(true),
  sandboxes: Schema.Array(BoatSandbox),
  nextCursor: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export const BoatDetailsResponse = Schema.Struct({
  ok: Schema.Literal(true),
  sandbox: BoatSandbox,
});
export const BoatActionResponse = Schema.Struct({ ok: Schema.Literal(true), id: Schema.String });
export const BoatDesktopResponse = Schema.Struct({
  ok: Schema.Literal(true),
  desktopUrl: Schema.String.check(Schema.isPattern(/^https:\/\//u)),
});

export const BoatBrowserResponse = Schema.Struct({
  ok: Schema.Literal(true),
  browserUrl: Schema.String.check(Schema.isPattern(/^https:\/\//u)),
});

export const BoatDeletionOperation = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(["sandbox", "snapshot"]),
  targetId: Schema.String,
  status: Schema.Literals(["pending", "processing", "blocked", "completed"]),
});
export type BoatDeletionOperation = typeof BoatDeletionOperation.Type;
export const BoatDeletionOperationResponse = Schema.Struct({
  ok: Schema.Literal(true),
  operation: BoatDeletionOperation,
});
export const BoatSavedSnapshot = Schema.Struct({
  name: Schema.String,
  status: Schema.Literals(["saving", "ready", "failed"]),
  sourceSandboxId: Schema.String,
  error: Schema.optionalKey(Schema.String),
});
export type BoatSavedSnapshot = typeof BoatSavedSnapshot.Type;
export const BoatSavedSnapshotResponse = Schema.Struct({
  ok: Schema.Literal(true),
  snapshot: BoatSavedSnapshot,
});
export const BoatUsage = Schema.Struct({
  ok: Schema.Literal(true),
  sandboxId: Schema.String,
  sandboxType: BoatSandboxSize,
  billingMultiplier: Schema.Number,
  seconds: Schema.Number,
  dollars: Schema.Number,
  secondsPerDollar: Schema.Number.check(Schema.isGreaterThan(0)),
  running: Schema.Boolean,
  since: Schema.String,
  until: Schema.String,
});
export type BoatUsage = typeof BoatUsage.Type;
export const BoatCommandResult = Schema.Struct({
  ok: Schema.Literal(true),
  success: Schema.Boolean,
  exitCode: Schema.NullOr(Schema.Int),
  stdout: Schema.String,
  stderr: Schema.String,
  timedOut: Schema.Boolean,
});
export type BoatCommandResult = typeof BoatCommandResult.Type;
export interface BoatForkInput {
  readonly name?: string;
  readonly requestId?: string;
  readonly size?: BoatSandboxSize;
  readonly autoStopMinutes?: number;
}
