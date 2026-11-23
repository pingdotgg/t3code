import * as Schema from "effect/Schema";

import { EnvironmentId } from "./baseSchemas.ts";

// agentctl Agent Sandboxes, which the host's T3 server discovers and manages
// for every client connected to it. Each Sandbox runs its own unmodified T3
// server, which the host reaches over SSH and relays at
// `/sandbox/<name>/` on its own origin.

/** Lifecycle of an Agent as agentctl reports it, derived like `agentctl tui` does. */
export const AgentctlSandboxPhase = Schema.Literals([
  "pending",
  "provisioning",
  "ready",
  "starting",
  "stopping",
  "stopped",
  "retrying",
  "unresponsive",
  "failed",
  "terminating",
]);
export type AgentctlSandboxPhase = typeof AgentctlSandboxPhase.Type;

/** A lifecycle request T3 started and is still waiting on. */
export const AgentctlSandboxAction = Schema.Literals([
  "creating",
  "starting",
  "stopping",
  "deleting",
]);
export type AgentctlSandboxAction = typeof AgentctlSandboxAction.Type;

export const AgentctlSandbox = Schema.Struct({
  name: Schema.String,
  phase: AgentctlSandboxPhase,
  /** Provisioning progress or the failure message, when there is one. */
  detail: Schema.NullOr(Schema.String),
  /** When it last became ready or stopped being so, as an ISO timestamp. */
  since: Schema.NullOr(Schema.String),
  /** Resources and network mode from its manifest, as agentctl spells them, such as `6Gi`. */
  cpu: Schema.NullOr(Schema.String),
  memory: Schema.NullOr(Schema.String),
  disk: Schema.NullOr(Schema.String),
  network: Schema.NullOr(Schema.String),
  /** False when the manifest has no `ssh` access, so T3 cannot reach it. */
  sshAccess: Schema.Boolean,
  /** Known once T3 has reached the Sandbox's server; null before that. */
  environmentId: Schema.NullOr(EnvironmentId),
  /** Whether this environment already got the user's preference settings from this computer. */
  settingsSeeded: Schema.Boolean,
  /** The harnesses agentctl set up in it, such as `claudeCode` or `pi`. */
  harnesses: Schema.Array(Schema.String),
  /** Where its agents work, and so its project's root; known once T3 has reached it. */
  workingDirectory: Schema.NullOr(Schema.String),
  /** Why T3 could not reach a Ready Sandbox, such as a missing SSH config include. */
  connectError: Schema.NullOr(Schema.String),
  action: Schema.NullOr(AgentctlSandboxAction),
  /** The last lifecycle request that failed, until the next one starts. */
  actionError: Schema.NullOr(Schema.String),
  manifestPath: Schema.NullOr(Schema.String),
  variant: Schema.NullOr(Schema.String),
});
export type AgentctlSandbox = typeof AgentctlSandbox.Type;

export const AgentctlSandboxesSnapshot = Schema.Struct({
  /** "unavailable" when agentctl is not installed or cannot reach its daemon. */
  status: Schema.Literals(["loading", "available", "unavailable"]),
  error: Schema.NullOr(Schema.String),
  sandboxes: Schema.Array(AgentctlSandbox),
  /** The desktop user's home, so paths can be shown as `~/…`. */
  homeDirectory: Schema.String,
});
export type AgentctlSandboxesSnapshot = typeof AgentctlSandboxesSnapshot.Type;

/** An `agent.yaml`, or a sibling `agent.<variant>.yaml`, found under a manifest root. */
export const AgentctlSandboxManifest = Schema.Struct({
  path: Schema.String,
  directory: Schema.String,
  /** The nearest folder at or above `directory` with a `.git`, or else the manifest root. */
  repository: Schema.String,
  variant: Schema.NullOr(Schema.String),
  /** `metadata.name`, the default name for a Sandbox applied from it. */
  agentName: Schema.NullOr(Schema.String),
});
export type AgentctlSandboxManifest = typeof AgentctlSandboxManifest.Type;

export const AgentctlSandboxSettings = Schema.Struct({
  /** Directories searched for manifests when creating a Sandbox. */
  manifestRoots: Schema.Array(Schema.String),
  /** The manifest the last Sandbox was created from, offered first next time. */
  lastManifestPath: Schema.optionalKey(Schema.String),
});
export type AgentctlSandboxSettings = typeof AgentctlSandboxSettings.Type;

/** A checkout holding a manifest folder's manifests, as of its last fetch. */
export const AgentctlRepositoryStatus = Schema.Struct({
  path: Schema.String,
  /** Null on a detached HEAD. */
  branch: Schema.NullOr(Schema.String),
  /** Null when the branch tracks nothing, so there is nothing to pull. */
  upstream: Schema.NullOr(Schema.String),
  /** Changed and untracked files. */
  changes: Schema.Int,
  /** Null when Git cannot compare with the upstream, such as one deleted on the remote. */
  ahead: Schema.NullOr(Schema.Int),
  behind: Schema.NullOr(Schema.Int),
  /** Why the last fetch failed, when `behind` may be out of date. */
  fetchError: Schema.NullOr(Schema.String),
});
export type AgentctlRepositoryStatus = typeof AgentctlRepositoryStatus.Type;

export const AgentctlManifestRoot = Schema.Struct({
  directory: Schema.String,
  exists: Schema.Boolean,
  manifests: Schema.Int,
  /** The folder's own checkout and those inside it; empty outside Git. */
  repositories: Schema.Array(AgentctlRepositoryStatus),
});
export type AgentctlManifestRoot = typeof AgentctlManifestRoot.Type;

export const AgentctlRepositoryPull = Schema.Struct({
  repository: Schema.String,
  outcome: Schema.Literals(["updated", "up-to-date", "failed"]),
  /** Commits the pull brought in. */
  commits: Schema.Int,
  /** Git's own reason, when the pull failed. */
  error: Schema.NullOr(Schema.String),
});
export type AgentctlRepositoryPull = typeof AgentctlRepositoryPull.Type;

/** `error` is set when nothing could be pulled; each repository reports its own failure. */
export const AgentctlPullResult = Schema.Struct({
  error: Schema.NullOr(Schema.String),
  repositories: Schema.Array(AgentctlRepositoryPull),
});
export type AgentctlPullResult = typeof AgentctlPullResult.Type;

export const AgentctlCreateSandboxInput = Schema.Struct({
  manifestPath: Schema.String,
  name: Schema.String,
});
export type AgentctlCreateSandboxInput = typeof AgentctlCreateSandboxInput.Type;

/** Lifecycle requests resolve with agentctl's error message instead of rejecting. */
export const AgentctlActionResult = Schema.Struct({
  error: Schema.NullOr(Schema.String),
});
export type AgentctlActionResult = typeof AgentctlActionResult.Type;

export const AgentctlSandboxNameInput = Schema.Struct({ name: Schema.String });
export type AgentctlSandboxNameInput = typeof AgentctlSandboxNameInput.Type;

export const AgentctlManifestRootInput = Schema.Struct({ folder: Schema.String });
export type AgentctlManifestRootInput = typeof AgentctlManifestRootInput.Type;

export const AgentctlPullManifestRootsInput = Schema.Struct({
  folders: Schema.Array(Schema.String),
});
export type AgentctlPullManifestRootsInput = typeof AgentctlPullManifestRootsInput.Type;

export const AgentctlMarkSettingsSeededInput = Schema.Struct({
  name: Schema.String,
  environmentId: EnvironmentId,
});
export type AgentctlMarkSettingsSeededInput = typeof AgentctlMarkSettingsSeededInput.Type;

/** A one-time code the Sandbox's own server issued, which a client redeems for its own session. */
export const AgentctlSandboxPairing = Schema.Struct({
  environmentId: EnvironmentId,
  pairingToken: Schema.String,
});
export type AgentctlSandboxPairing = typeof AgentctlSandboxPairing.Type;

/** A manifest folder this computer does not have. */
export class AgentctlManifestRootError extends Schema.TaggedError<AgentctlManifestRootError>()(
  "AgentctlManifestRootError",
  {
    folder: Schema.String,
    message: Schema.String,
  },
) {}

export class AgentctlSandboxError extends Schema.TaggedError<AgentctlSandboxError>()(
  "AgentctlSandboxError",
  {
    sandboxName: Schema.String,
    reason: Schema.Literals(["not-found", "not-running", "unreachable"]),
    message: Schema.String,
  },
) {}
