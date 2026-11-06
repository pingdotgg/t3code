import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { EnvironmentId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import type { RuntimeMode } from "./providerPolicy.ts";
import { SecretReference } from "./secretReference.ts";

/**
 * OpenShell gateway contracts: server settings for the gateway connection,
 * sandbox template summaries, fleet lifecycle states, and the backend-agnostic
 * `GatewayDriver` interface. The fleet registry, drain protocol, pairing and
 * audit stay t3-native; only sandbox lifecycle talks to the driver.
 */

/** Backends behind the fleet driver; `openshell` is the first value. */
export const OpenShellDriverId = Schema.Literals(["openshell"]);
export type OpenShellDriverId = typeof OpenShellDriverId.Type;

/**
 * Ephemeral workers retire themselves (task settles, idle timeout, hard
 * lifetime cap); persistent ones are named lanes removed manually.
 */
export const OpenShellWorkerClass = Schema.Literals(["ephemeral", "persistent"]);
export type OpenShellWorkerClass = typeof OpenShellWorkerClass.Type;

/**
 * Fleet lifecycle state, tracked in the managing instance's registry, not only
 * in gateway phases. `failed` keeps the sandbox until drained (nothing lost).
 * OPEN(spec section 5.3): drain failures fold into `failed` for v1.
 */
export const OpenShellFleetState = Schema.Literals([
  "provisioning",
  "pairing",
  "ready",
  "draining",
  "deleting",
  "failed",
]);
export type OpenShellFleetState = typeof OpenShellFleetState.Type;

export const OpenShellSandboxResources = Schema.Struct({
  /** Whole or fractional cores, e.g. "2". */
  cpu: Schema.optionalKey(TrimmedNonEmptyString),
  /** Kubernetes-style quantity, e.g. "4Gi". */
  memory: Schema.optionalKey(TrimmedNonEmptyString),
  gpu: Schema.optionalKey(Schema.Number),
});
export type OpenShellSandboxResources = typeof OpenShellSandboxResources.Type;

/** Defaults applied to spawned workers when the call does not override them. */
export const OpenShellWorkerDefaults = Schema.Struct({
  workerClass: OpenShellWorkerClass.pipe(Schema.withDecodingDefault(Effect.succeed("ephemeral"))),
  /**
   * Hard lifetime cap for ephemeral workers. OpenShell has no native TTL; the
   * integration reaps (spec section 6.1).
   */
  ttlMs: Schema.optionalKey(Schema.DurationFromMillis),
  idleTimeoutMs: Schema.optionalKey(Schema.DurationFromMillis),
  drainTimeoutMs: Schema.optionalKey(Schema.DurationFromMillis),
  resources: Schema.optionalKey(OpenShellSandboxResources),
});
export type OpenShellWorkerDefaults = typeof OpenShellWorkerDefaults.Type;

/**
 * Shared RWX cache knob (spec section 8): derived bytes only (caches, mirrors,
 * seeds), never live state. Off or absent degrades per the section 8.4
 * fallback ladder (git remote as source of truth).
 */
export const OpenShellSharedCacheSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  mode: Schema.Literals(["rwx-pvc", "image-volume", "registry-proxy", "none"]).pipe(
    Schema.withDecodingDefault(Effect.succeed("none" as const)),
  ),
  mountPath: TrimmedNonEmptyString.pipe(Schema.withDecodingDefault(Effect.succeed("/opt/t3cache"))),
  /** Operator-labeled PVCs admitted by the gateway; mirrors read-only, cache read-write. */
  pvcNames: Schema.optionalKey(
    Schema.Struct({
      mirrors: Schema.optionalKey(TrimmedNonEmptyString),
      cache: Schema.optionalKey(TrimmedNonEmptyString),
    }),
  ),
});
export type OpenShellSharedCacheSettings = typeof OpenShellSharedCacheSettings.Type;

/**
 * Server-side gateway config (spec section 4.2). The gateway credential never
 * enters settings JSON: `credential` is a secret-provider reference, or null
 * to use the ServerSecretStore slot `openshell-gateway-credential`.
 */
export const OpenShellGatewaySettings = Schema.Struct({
  driver: OpenShellDriverId.pipe(Schema.withDecodingDefault(Effect.succeed("openshell"))),
  /** Gateway control-plane base URL. */
  gatewayUrl: Schema.optionalKey(TrimmedNonEmptyString),
  credential: Schema.optionalKey(Schema.NullOr(SecretReference)),
  /** Worker template name; spawn and the desktop template picker may override. */
  defaultSandboxTemplate: Schema.optionalKey(TrimmedNonEmptyString),
  /**
   * True only on the managing instance: it spawns and drains workers. Linked
   * environments can never hold this role (spec section 5.2).
   */
  managingInstance: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  workerDefaults: Schema.optionalKey(OpenShellWorkerDefaults),
  sharedCache: Schema.optionalKey(OpenShellSharedCacheSettings),
});
export type OpenShellGatewaySettings = typeof OpenShellGatewaySettings.Type;

/** A gateway sandbox template summary for pickers and preflight checks. */
export const OpenShellSandboxTemplate = Schema.Struct({
  name: TrimmedNonEmptyString,
  image: Schema.optionalKey(TrimmedNonEmptyString),
  cpu: Schema.optionalKey(TrimmedNonEmptyString),
  memory: Schema.optionalKey(TrimmedNonEmptyString),
  /** Fleet role the gateway labels this template for, when labeled. */
  role: Schema.optionalKey(Schema.Literals(["managing", "worker"])),
});
export type OpenShellSandboxTemplate = typeof OpenShellSandboxTemplate.Type;

/** The worker sandbox as created on the gateway. */
export const OpenShellEnvironmentSandbox = Schema.Struct({
  /** Deterministic, e.g. `t3-worker-<hash of the idempotency key>`. */
  name: TrimmedNonEmptyString,
  sandboxId: Schema.String,
  template: Schema.NullOr(TrimmedNonEmptyString),
  /** Gateway phase observed at return. */
  phase: Schema.String,
});
export type OpenShellEnvironmentSandbox = typeof OpenShellEnvironmentSandbox.Type;

/**
 * Drain journal progress for one removal (spec section 7.4). Deletion is only
 * allowed once every thread and worktree acked.
 */
export const OpenShellDrainProgress = Schema.Struct({
  /** Deterministic `drain:<workerEnvId>:<generation>`; retries reuse it. */
  drainId: TrimmedNonEmptyString,
  threads: Schema.Struct({ total: Schema.Number, acked: Schema.Number, failed: Schema.Number }),
  worktrees: Schema.Struct({ total: Schema.Number, acked: Schema.Number, failed: Schema.Number }),
  startedAt: Schema.Number,
  finishedAt: Schema.NullOr(Schema.Number),
});
export type OpenShellDrainProgress = typeof OpenShellDrainProgress.Type;

/** One worker as the managing instance's fleet registry sees it. */
export const OpenShellFleetWorkerStatus = Schema.Struct({
  environmentId: EnvironmentId,
  label: Schema.NullOr(TrimmedNonEmptyString),
  sandboxName: TrimmedNonEmptyString,
  workerClass: OpenShellWorkerClass,
  state: OpenShellFleetState,
  /** Ephemeral: epoch-ms retirement deadline managed by this instance. */
  expiresAt: Schema.NullOr(Schema.Number),
  drain: Schema.optionalKey(OpenShellDrainProgress),
  lastError: Schema.NullOr(Schema.String),
});
export type OpenShellFleetWorkerStatus = typeof OpenShellFleetWorkerStatus.Type;

export interface GatewayDriverSpawnSpec {
  template?: string;
  workerClass: OpenShellWorkerClass;
  /** Stable label; expected for persistent workers (spec section 6.1). */
  label?: string;
  /** Ephemeral hard lifetime cap, overriding the gateway defaults. */
  ttlMs?: number;
  /** Seed the checkout or deps from this ref or seed store (spec section 10). */
  seedFrom?: string;
  resources?: OpenShellSandboxResources;
  /**
   * Runtime mode the worker's threads run under; translated into a sandbox
   * policy at spawn (spec section 5.2), conservative default when absent.
   * OPEN-QUESTION (spec section 5.2): inherit the delegating mode instead?
   */
  runtimeMode?: RuntimeMode;
}

export interface GatewayDriverSpawnOptions {
  /** Receipt-keyed idempotency: retries converge on the same sandbox. */
  idempotencyKey?: string;
}

export interface GatewayDriverSpawnResult {
  environmentId: EnvironmentId;
  sandbox: OpenShellEnvironmentSandbox;
  workerClass: OpenShellWorkerClass;
  state: OpenShellFleetState;
  expiresAt: number | null;
  warnings: ReadonlyArray<string>;
}

export interface GatewayDriverDrainResult {
  drainId: string;
  progress: OpenShellDrainProgress;
  /** Still draining, verified complete, or failed with the sandbox kept. */
  state: "draining" | "deleting" | "failed";
}

export interface GatewayDriverRemoveOptions {
  timeoutMs?: number;
  /** Skip drain only with an explicit user ack; thread snapshots still export. */
  force?: boolean;
  idempotencyKey?: string;
}

export interface GatewayDriverRemoveResult {
  environmentId: EnvironmentId;
  /** `refused` keeps the sandbox: nothing lost outranks cleanup. */
  outcome: "completed" | "drain_pending" | "refused";
  drain?: OpenShellDrainProgress;
  sandboxOutcome?: "completed" | "accepted" | "already_absent";
  reason?: string;
}

export interface GatewayDriverStatusSelector {
  environmentId?: EnvironmentId;
  workerClass?: OpenShellWorkerClass;
}

/**
 * Backend-agnostic fleet driver (spec section 12); OpenShell is the first
 * implementation. Only the spawn, drain, remove, status and template verbs the
 * fleet tools need. OPEN(spec section 12): exec, credential, shared-volume and
 * snapshot seams land with the driver implementation phase.
 */
export interface GatewayDriver {
  /** `"openshell"` today; one value per backend. */
  readonly id: string;

  listTemplates(): Promise<ReadonlyArray<OpenShellSandboxTemplate>>;

  spawn(
    spec: GatewayDriverSpawnSpec,
    opts: GatewayDriverSpawnOptions,
  ): Promise<GatewayDriverSpawnResult>;

  /** Move all durable worker state to the managing instance before any delete. */
  drain(
    environmentId: EnvironmentId,
    opts: { timeoutMs?: number },
  ): Promise<GatewayDriverDrainResult>;

  /** Drain-first removal; `refused` keeps the sandbox (spec section 7). */
  remove(
    environmentId: EnvironmentId,
    opts: GatewayDriverRemoveOptions,
  ): Promise<GatewayDriverRemoveResult>;

  status(selector: GatewayDriverStatusSelector): Promise<ReadonlyArray<OpenShellFleetWorkerStatus>>;
}
