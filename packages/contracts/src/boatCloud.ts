import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { EnvironmentId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Boat cloud runs agents on Boat (boat.dev) VMs. Each VM runs its own T3 server,
 * so it is an ordinary environment that clients pair with over its public URL.
 * The environment holding the Boat API key creates, wakes and stops the VMs.
 */

/** Boat serves every VM's ports under this domain, so its URL marks an environment as a VM. */
const BOAT_HOST_SUFFIX = ".on.boat.dev";

export function isBoatCloudHttpBaseUrl(httpBaseUrl: string | null | undefined): boolean {
  if (!httpBaseUrl) return false;
  try {
    return new URL(httpBaseUrl).hostname.endsWith(BOAT_HOST_SUFFIX);
  } catch {
    return false;
  }
}

/** The API key scopes Boat cloud uses, in Boat's own scope names. */
export const BOAT_CLOUD_REQUIRED_SCOPES = [
  "sandbox.create",
  "sandbox.read",
  "sandbox.update",
  "sandbox.stop",
  "sandbox.resume",
  "sandbox.delete",
  "exec",
  "file.read",
  "file.write",
  "host",
  "ssh",
  "snapshot.read",
  "snapshot.write",
  "environment.read",
  "environment.write",
  "account.read",
  // Reading which AI credentials a profile holds needs it; Boat never returns their values.
  "account.admin",
] as const;

export const BOAT_CLOUD_SETUP_STEPS = [
  "create-vm",
  "install-server",
  "copy-skills",
  "save-snapshot",
] as const;
export const BoatCloudSetupStep = Schema.Literals(BOAT_CLOUD_SETUP_STEPS);
export type BoatCloudSetupStep = typeof BoatCloudSetupStep.Type;

export const BoatCloudSetup = Schema.Struct({
  status: Schema.Literals(["idle", "running", "ready", "failed"]),
  /** The step running, or the one that failed. */
  step: Schema.NullOr(BoatCloudSetupStep),
  error: Schema.NullOr(Schema.String),
});
export type BoatCloudSetup = typeof BoatCloudSetup.Type;

export const BoatCloudMachineState = Schema.Literals(["running", "starting", "stopped", "gone"]);
export type BoatCloudMachineState = typeof BoatCloudMachineState.Type;

export const BoatCloudMachine = Schema.Struct({
  sandboxId: TrimmedNonEmptyString,
  environmentId: Schema.NullOr(EnvironmentId),
  label: Schema.String,
  httpBaseUrl: Schema.NullOr(Schema.String),
  state: BoatCloudMachineState,
  repositories: Schema.Array(Schema.String),
  /** When this machine last copied the VM's sessions and workspaces, before stopping it. */
  backedUpAt: Schema.NullOr(Schema.String),
  /** The Boat environment the VM started on. Boat keeps it across stops and resumes. */
  environment: Schema.NullOr(Schema.String),
});
export type BoatCloudMachine = typeof BoatCloudMachine.Type;

/**
 * Starting a thread on Boat cloud, in order. `server` and `repository` run at
 * the same time; the holder reports the first three and the client the rest.
 * Acquire returns once the server is up, so `repository` can still be running.
 */
export const BOAT_CLOUD_START_STEPS = [
  "machine",
  "server",
  "repository",
  "connect",
  "project",
  "thread",
] as const;
export const BoatCloudStartStep = Schema.Literals(BOAT_CLOUD_START_STEPS);
export type BoatCloudStartStep = typeof BoatCloudStartStep.Type;

export const BoatCloudStepProgress = Schema.Struct({
  step: BoatCloudStartStep,
  state: Schema.Literals(["pending", "active", "done", "failed"]),
  /** What the step is doing, such as which VM it reuses or which repository it clones. */
  detail: Schema.NullOr(Schema.String),
});
export type BoatCloudStepProgress = typeof BoatCloudStepProgress.Type;

/** One acquire in flight on the holder, so the client that asked can show its steps. */
export const BoatCloudStart = Schema.Struct({
  requestId: TrimmedNonEmptyString,
  steps: Schema.Array(BoatCloudStepProgress),
});
export type BoatCloudStart = typeof BoatCloudStart.Type;

/** What a Boat environment passes to its VMs, in Boat's own field names. */
export const BoatCloudEnvironmentAccess = Schema.Struct({
  passGithub: Schema.Boolean,
  passSandboxCredentials: Schema.Boolean,
  passSecrets: Schema.Boolean,
  passAgentsCredentials: Schema.Boolean,
});
export type BoatCloudEnvironmentAccess = typeof BoatCloudEnvironmentAccess.Type;

export const BoatCloudEnvironment = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  isDefault: Schema.Boolean,
  ...BoatCloudEnvironmentAccess.fields,
  /** Boat's ids of the AI credentials its VMs get, such as `anthropic-api-key`. Null when unknown. */
  agentCredentials: Schema.NullOr(Schema.Array(Schema.String)),
});
export type BoatCloudEnvironment = typeof BoatCloudEnvironment.Type;

export const BoatCloudStatus = Schema.Struct({
  connected: Schema.Boolean,
  /** The Boat account the key belongs to. */
  account: Schema.NullOr(Schema.String),
  setup: BoatCloudSetup,
  /** VMs can start from the saved snapshot, even while setup rebuilds it. */
  snapshotReady: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  machines: Schema.Array(BoatCloudMachine),
  starts: Schema.Array(BoatCloudStart),
  /** The Boat environment new VMs start on, by name. */
  environment: Schema.NullOr(Schema.String),
  environments: Schema.Array(BoatCloudEnvironment),
  /** Why the environments could not be listed, such as a key without `environment.read`. */
  environmentsError: Schema.NullOr(Schema.String),
});
export type BoatCloudStatus = typeof BoatCloudStatus.Type;

export const BoatCloudSubscribeInput = Schema.Struct({});
export type BoatCloudSubscribeInput = typeof BoatCloudSubscribeInput.Type;

export const BoatCloudConnectInput = Schema.Struct({
  apiKey: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
});
export type BoatCloudConnectInput = typeof BoatCloudConnectInput.Type;

/** Picks the environment for new VMs, and optionally changes what it passes to them. */
export const BoatCloudConfigureEnvironmentInput = Schema.Struct({
  environmentId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  access: Schema.optional(BoatCloudEnvironmentAccess),
});
export type BoatCloudConfigureEnvironmentInput = typeof BoatCloudConfigureEnvironmentInput.Type;

export const BoatCloudEmptyInput = Schema.Struct({});
export type BoatCloudEmptyInput = typeof BoatCloudEmptyInput.Type;

/** How many repositories the snapshot checks out. */
export const BOAT_CLOUD_SNAPSHOT_REPOSITORIES = 10;

export const BoatCloudRunSetupInput = Schema.Struct({
  /**
   * Git remotes the snapshot checks out, most worked first. The holder keeps them for later
   * rebuilds; absent keeps the ones it has.
   */
  repositories: Schema.optional(
    Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(2048))).check(
      Schema.isMaxLength(BOAT_CLOUD_SNAPSHOT_REPOSITORIES),
    ),
  ),
});
export type BoatCloudRunSetupInput = typeof BoatCloudRunSetupInput.Type;

export const BoatCloudAcquireInput = Schema.Struct({
  /** The project's git remote; the VM clones it when it does not have it yet. */
  repositoryUrl: TrimmedNonEmptyString.check(Schema.isMaxLength(2048)),
  /** The thread's base branch; the start fails early when the remote does not have it. */
  baseBranch: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(512))),
  /** Names this start in `BoatCloudStatus.starts`. */
  requestId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  /** Boat cloud VMs the client already paired with; picking one of them skips the pairing code. */
  paired: Schema.optional(
    Schema.Array(
      Schema.Struct({
        environmentId: EnvironmentId,
        httpBaseUrl: TrimmedNonEmptyString.check(Schema.isMaxLength(2048)),
      }),
    ).check(Schema.isMaxLength(64)),
  ),
});
export type BoatCloudAcquireInput = typeof BoatCloudAcquireInput.Type;

export const BoatCloudWakeInput = Schema.Struct({
  environmentId: EnvironmentId,
  /** Finds a VM this holder did not start, such as one another holder made with the same key. */
  httpBaseUrl: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(2048))),
  /** The holder reports the wake's machine and server steps under this id in its status. */
  requestId: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(128))),
});
export type BoatCloudWakeInput = typeof BoatCloudWakeInput.Type;

/** What a client needs to reach a VM's T3 server: a one-time pairing code for its URL. */
export const BoatCloudSession = Schema.Struct({
  sandboxId: TrimmedNonEmptyString,
  environmentId: EnvironmentId,
  httpBaseUrl: TrimmedNonEmptyString,
  /** Null when the client is already paired with this environment and reconnects instead. */
  pairingCode: Schema.NullOr(TrimmedNonEmptyString),
  /** Repository checkout on the VM; null for a wake. */
  workspaceRoot: Schema.NullOr(TrimmedNonEmptyString),
  /**
   * The thread's worktree, which the VM cuts while its server starts. Ready once the start's
   * `repository` step is done. Absent from older holders and for a start with no base branch.
   */
  worktree: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        path: TrimmedNonEmptyString,
        branch: TrimmedNonEmptyString,
        baseBranch: TrimmedNonEmptyString,
      }),
    ),
  ),
});
export type BoatCloudSession = typeof BoatCloudSession.Type;

export class BoatCloudError extends Schema.TaggedError<BoatCloudError>()("BoatCloudError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}
