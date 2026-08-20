import * as Schema from "effect/Schema";

import { EnvironmentId, IsoDateTime, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Project mirroring: a project whose files live on another T3 environment
 * (the "origin", e.g. a laptop) while agent execution happens here (the
 * "host"). The origin runs a MirrorAgent holding an outbound `mirror.connect`
 * stream to the host; the host answers turn lifecycle events with directives,
 * and the agent replies via `mirror.respond`. Bulk bytes (git bundles) never
 * cross the WebSocket — they move over short-lived signed HTTP URLs.
 */

export const MirrorSyncId = TrimmedNonEmptyString.check(Schema.isMaxLength(64));
export type MirrorSyncId = typeof MirrorSyncId.Type;

export const MirrorConnectionId = TrimmedNonEmptyString.check(Schema.isMaxLength(64));
export type MirrorConnectionId = typeof MirrorConnectionId.Type;

/** A git object id: SHA-1 (40 hex chars) or SHA-256 (64 hex chars). */
export const GitObjectId = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/));
export type GitObjectId = typeof GitObjectId.Type;

export const MirrorGitRemote = Schema.Struct({
  name: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
});
export type MirrorGitRemote = typeof MirrorGitRemote.Type;

export const MirrorRefUpdate = Schema.Struct({
  /** Fully qualified ref, e.g. refs/heads/feature-x. */
  ref: TrimmedNonEmptyString,
  oid: GitObjectId,
});
export type MirrorRefUpdate = typeof MirrorRefUpdate.Type;

export const MirrorSyncReason = Schema.Literals(["seed", "turn-start", "manual"]);
export type MirrorSyncReason = typeof MirrorSyncReason.Type;

/** Host -> origin instructions delivered over the mirror.connect stream. */
export const MirrorDirective = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("seed-requested"),
    syncId: MirrorSyncId,
    /** Relative signed URL the agent PUTs the full `git bundle --all` to. */
    uploadUrl: TrimmedNonEmptyString,
    expiresAt: IsoDateTime,
  }),
  Schema.Struct({
    type: Schema.Literal("sync-requested"),
    syncId: MirrorSyncId,
    /** Last snapshot the host has; null when the host has none recorded. */
    baseSnapshotOid: Schema.NullOr(GitObjectId),
    uploadUrl: TrimmedNonEmptyString,
    expiresAt: IsoDateTime,
    reason: MirrorSyncReason,
  }),
  Schema.Struct({
    type: Schema.Literal("apply-requested"),
    syncId: MirrorSyncId,
    /** Relative signed URL the agent GETs the incremental bundle from. */
    downloadUrl: TrimmedNonEmptyString,
    expiresAt: IsoDateTime,
    /** Snapshot both sides shared before the turn ran. */
    baseSnapshotOid: GitObjectId,
    /** Post-turn snapshot of the host mirror worktree. */
    targetSnapshotOid: GitObjectId,
    /** Branch refs the turn created or moved, to recreate on the origin. */
    refUpdates: Schema.Array(MirrorRefUpdate),
  }),
  Schema.Struct({
    type: Schema.Literal("link-revoked"),
  }),
  Schema.Struct({
    type: Schema.Literal("submodule-seed-requested"),
    syncId: MirrorSyncId,
    /** Gitlink path, relative to the project root, e.g. "vendor/lib". */
    path: TrimmedNonEmptyString,
    /** Relative signed URL the agent PUTs the full `git bundle --all` to. */
    uploadUrl: TrimmedNonEmptyString,
    expiresAt: IsoDateTime,
  }),
  Schema.Struct({
    type: Schema.Literal("submodule-sync-requested"),
    syncId: MirrorSyncId,
    path: TrimmedNonEmptyString,
    /** Last snapshot the host has; null when the host has none recorded. */
    baseSnapshotOid: Schema.NullOr(GitObjectId),
    uploadUrl: TrimmedNonEmptyString,
    expiresAt: IsoDateTime,
    reason: MirrorSyncReason,
  }),
  Schema.Struct({
    type: Schema.Literal("submodule-apply-requested"),
    syncId: MirrorSyncId,
    path: TrimmedNonEmptyString,
    /** Relative signed URL the agent GETs the incremental bundle from. */
    downloadUrl: TrimmedNonEmptyString,
    expiresAt: IsoDateTime,
    /** Snapshot both sides shared before the turn ran. */
    baseSnapshotOid: GitObjectId,
    /** Post-turn snapshot of the host mirror's nested repository. */
    targetSnapshotOid: GitObjectId,
    /** Branch refs the turn created or moved, to recreate on the origin. */
    refUpdates: Schema.Array(MirrorRefUpdate),
  }),
]);
export type MirrorDirective = typeof MirrorDirective.Type;

export const MirrorStreamEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("connected"),
    connectionId: MirrorConnectionId,
    /** True when the host has no mirror contents yet and will ask to seed. */
    needsSeed: Schema.Boolean,
    /**
     * True when this origin's MirrorAgent understands submodule-* directives.
     * Absent/false on older origins; the host must skip all submodule
     * cascade logic for them rather than sending directives they will fail
     * to decode.
     */
    supportsSubmodules: Schema.optional(Schema.Boolean),
    /**
     * Extra gitignored path patterns to force-include in sync snapshots,
     * derived from the project's `mirrorIncludeIgnoredFiles` setting. Sent
     * once per connection rather than per-directive; the origin caches it
     * for the life of the connection.
     */
    extraIncludePaths: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  }),
  Schema.Struct({
    type: Schema.Literal("directive"),
    connectionId: MirrorConnectionId,
    directive: MirrorDirective,
  }),
  Schema.Struct({
    type: Schema.Literal("settings-updated"),
    connectionId: MirrorConnectionId,
    /**
     * Freshly resolved extra include patterns, sent right before every
     * directive so a project-settings change (e.g. toggling
     * mirrorIncludeIgnoredFiles) takes effect on the next sync without
     * requiring the origin to reconnect.
     */
    extraIncludePaths: Schema.Array(TrimmedNonEmptyString),
  }),
]);
export type MirrorStreamEvent = typeof MirrorStreamEvent.Type;

/** Origin -> host replies, posted through mirror.respond. */
export const MirrorAgentResponse = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("seed-uploaded"),
    syncId: MirrorSyncId,
    /** Symbolic HEAD of the origin repo, e.g. refs/heads/main; null when detached. */
    headRef: Schema.NullOr(TrimmedNonEmptyString),
    snapshotOid: GitObjectId,
    /** Origin repo remotes, replicated onto the mirror at seed time. */
    remotes: Schema.Array(MirrorGitRemote),
  }),
  Schema.Struct({
    type: Schema.Literal("sync-uploaded"),
    syncId: MirrorSyncId,
    snapshotOid: GitObjectId,
  }),
  Schema.Struct({
    type: Schema.Literal("sync-no-change"),
    syncId: MirrorSyncId,
    snapshotOid: GitObjectId,
  }),
  Schema.Struct({
    type: Schema.Literal("apply-result"),
    syncId: MirrorSyncId,
    outcome: Schema.Literals(["applied", "conflicted"]),
    /** Repo-relative paths left untouched on the origin because of conflicts. */
    conflictPaths: Schema.Array(TrimmedNonEmptyString),
  }),
  Schema.Struct({
    type: Schema.Literal("sync-failed"),
    syncId: MirrorSyncId,
    message: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    type: Schema.Literal("submodule-seed-uploaded"),
    syncId: MirrorSyncId,
    path: TrimmedNonEmptyString,
    /** Symbolic HEAD of the nested repo, e.g. refs/heads/main; null when detached. */
    headRef: Schema.NullOr(TrimmedNonEmptyString),
    snapshotOid: GitObjectId,
    /** Nested repo remotes, replicated onto the mirror at seed time. */
    remotes: Schema.Array(MirrorGitRemote),
  }),
  Schema.Struct({
    type: Schema.Literal("submodule-sync-uploaded"),
    syncId: MirrorSyncId,
    path: TrimmedNonEmptyString,
    snapshotOid: GitObjectId,
  }),
  Schema.Struct({
    type: Schema.Literal("submodule-sync-no-change"),
    syncId: MirrorSyncId,
    path: TrimmedNonEmptyString,
    snapshotOid: GitObjectId,
  }),
  Schema.Struct({
    type: Schema.Literal("submodule-apply-result"),
    syncId: MirrorSyncId,
    path: TrimmedNonEmptyString,
    outcome: Schema.Literals(["applied", "conflicted"]),
    /** Repo-relative paths (within the submodule) left untouched due to conflicts. */
    conflictPaths: Schema.Array(TrimmedNonEmptyString),
  }),
  Schema.Struct({
    type: Schema.Literal("submodule-skipped"),
    syncId: MirrorSyncId,
    path: TrimmedNonEmptyString,
    reason: Schema.Literals(["no-nested-repository", "error"]),
    detail: Schema.String,
  }),
]);
export type MirrorAgentResponse = typeof MirrorAgentResponse.Type;

export const MirrorProjectState = Schema.Literals([
  "seeding",
  "idle",
  "syncing",
  "applying",
  "offline",
  "conflict",
]);
export type MirrorProjectState = typeof MirrorProjectState.Type;

export const MirrorProjectStatus = Schema.Struct({
  projectId: ProjectId,
  state: MirrorProjectState,
  originConnected: Schema.Boolean,
  lastSyncedAt: Schema.NullOr(IsoDateTime),
  lastSyncedSnapshotOid: Schema.NullOr(GitObjectId),
  /** Non-empty only in the conflict state. */
  conflictPaths: Schema.Array(TrimmedNonEmptyString),
  /** Per-submodule-path soft failures (e.g. no local copy on the origin). */
  submoduleWarnings: Schema.Array(
    Schema.Struct({ path: TrimmedNonEmptyString, detail: Schema.String }),
  ),
  /**
   * Bytes of the in-flight bundle upload while seeding/syncing, absent when
   * no transfer is active. `totalBytes` is null when the uploader did not
   * send a Content-Length.
   */
  transfer: Schema.optional(
    Schema.Struct({
      bytes: Schema.Number,
      totalBytes: Schema.NullOr(Schema.Number),
    }),
  ),
});
export type MirrorProjectStatus = typeof MirrorProjectStatus.Type;

// RPC payloads

export const MirrorCreatePeerCredentialInput = Schema.Struct({
  projectId: ProjectId,
  originEnvironmentId: EnvironmentId,
});
export type MirrorCreatePeerCredentialInput = typeof MirrorCreatePeerCredentialInput.Type;

export const MirrorCreatePeerCredentialResult = Schema.Struct({
  /** Bearer access token scoped to mirror:sync, bound to the project. */
  token: TrimmedNonEmptyString,
});
export type MirrorCreatePeerCredentialResult = typeof MirrorCreatePeerCredentialResult.Type;

/** Served by the ORIGIN environment: persist the link and start the agent. */
export const MirrorAttachInput = Schema.Struct({
  projectId: ProjectId,
  /** Base http(s) URL the origin uses to reach the host. */
  hostUrl: TrimmedNonEmptyString,
  token: TrimmedNonEmptyString,
  /** Absolute path of the working copy on the origin machine. */
  localRootPath: TrimmedNonEmptyString,
});
export type MirrorAttachInput = typeof MirrorAttachInput.Type;

export const MirrorAttachResult = Schema.Struct({
  projectId: ProjectId,
});
export type MirrorAttachResult = typeof MirrorAttachResult.Type;

export const MirrorDetachInput = Schema.Struct({
  projectId: ProjectId,
});
export type MirrorDetachInput = typeof MirrorDetachInput.Type;

/** Served by the ORIGIN environment: one row per folder shared to a host. */
export const MirrorLinkInfo = Schema.Struct({
  projectId: ProjectId,
  /** Base http(s) URL of the host this folder is mirrored to. */
  hostUrl: TrimmedNonEmptyString,
  /** Absolute path of the shared working copy on this machine. */
  localRootPath: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
});
export type MirrorLinkInfo = typeof MirrorLinkInfo.Type;

export const MirrorListLinksResult = Schema.Struct({
  links: Schema.Array(MirrorLinkInfo),
});
export type MirrorListLinksResult = typeof MirrorListLinksResult.Type;

export const MirrorConnectInput = Schema.Struct({
  projectId: ProjectId,
  /** True when this origin's MirrorAgent understands submodule-* directives. */
  supportsSubmodules: Schema.optional(Schema.Boolean),
});
export type MirrorConnectInput = typeof MirrorConnectInput.Type;

export const MirrorRespondInput = Schema.Struct({
  connectionId: MirrorConnectionId,
  response: MirrorAgentResponse,
});
export type MirrorRespondInput = typeof MirrorRespondInput.Type;

export const MirrorRequestSyncInput = Schema.Struct({
  projectId: ProjectId,
});
export type MirrorRequestSyncInput = typeof MirrorRequestSyncInput.Type;

export const MirrorSubscribeStatusInput = Schema.Struct({
  /** Omit to receive status for every mirrored project. */
  projectId: Schema.optional(ProjectId),
});
export type MirrorSubscribeStatusInput = typeof MirrorSubscribeStatusInput.Type;

// Errors

export class MirrorOriginOfflineError extends Schema.TaggedErrorClass<MirrorOriginOfflineError>()(
  "MirrorOriginOfflineError",
  {
    projectId: ProjectId,
    originLabel: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  },
) {
  override get message(): string {
    const label = this.originLabel ?? "the machine holding this project's files";
    return `Cannot sync project files: ${label} is offline.`;
  }
}

export class MirrorSyncFailedError extends Schema.TaggedErrorClass<MirrorSyncFailedError>()(
  "MirrorSyncFailedError",
  {
    projectId: ProjectId,
    syncId: Schema.optional(MirrorSyncId),
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Mirror sync failed: ${this.detail}`;
  }
}

/**
 * The mirrored folder could not be made into a git repository. A plain folder
 * is a valid origin — it gets initialized in place — so this now only fires
 * when that initialization fails: the path is missing, is not a directory, or
 * is not writable.
 *
 * The tag is unchanged from when a non-repository was refused outright, so
 * older paired clients still decode it.
 */
export class MirrorNotARepositoryError extends Schema.TaggedErrorClass<MirrorNotARepositoryError>()(
  "MirrorNotARepositoryError",
  {
    path: TrimmedNonEmptyString,
    detail: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    const detail = this.detail?.trim();
    return `Could not prepare ${this.path} as a git repository${
      detail !== undefined && detail.length > 0 ? `: ${detail}` : "."
    }`;
  }
}

export class MirrorLinkNotFoundError extends Schema.TaggedErrorClass<MirrorLinkNotFoundError>()(
  "MirrorLinkNotFoundError",
  {
    projectId: ProjectId,
  },
) {
  override get message(): string {
    return `No mirror link exists for project ${this.projectId}.`;
  }
}

export class MirrorProjectNotMirroredError extends Schema.TaggedErrorClass<MirrorProjectNotMirroredError>()(
  "MirrorProjectNotMirroredError",
  {
    projectId: ProjectId,
  },
) {
  override get message(): string {
    return `Project ${this.projectId} has no origin; it is not a mirrored project.`;
  }
}

export const MirrorSyncError = Schema.Union([
  MirrorOriginOfflineError,
  MirrorSyncFailedError,
  MirrorProjectNotMirroredError,
]);
export type MirrorSyncError = typeof MirrorSyncError.Type;
