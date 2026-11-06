import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  NodeId,
  OrchestrationV2Checkpoint,
  type OrchestrationV2CheckpointRepository,
  OrchestrationV2CheckpointScope,
  type OrchestrationV2CheckpointStatus,
  type OrchestrationV2Run,
  ProviderThreadId,
  RunId,
  ThreadId,
  type ThreadRepoWorktree,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { isGitImport, parseTurnDiffFilesFromNumstat } from "../checkpointing/Diffs.ts";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { CHECKPOINT_DIFF_MAX_OUTPUT_BYTES } from "../vcs/VcsDriver.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";

const CHECKPOINT_REFS_PREFIX = "refs/t3/orchestration-v2/checkpoints";
const ROOT_CHECKPOINT_SCOPE_NAME = "root";

export class CheckpointRootScopePrepareError extends Schema.TaggedError<CheckpointRootScopePrepareError>()(
  "CheckpointRootScopePrepareError",
  {
    threadId: ThreadId,
    runId: RunId,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to prepare root checkpoint scope for run ${this.runId}.`;
  }
}

export class CheckpointBaselineCaptureError extends Schema.TaggedError<CheckpointBaselineCaptureError>()(
  "CheckpointBaselineCaptureError",
  {
    scopeId: CheckpointScopeId,
    ordinalWithinScope: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to capture checkpoint baseline ${this.ordinalWithinScope} for scope ${this.scopeId}.`;
  }
}

export class CheckpointCaptureError extends Schema.TaggedError<CheckpointCaptureError>()(
  "CheckpointCaptureError",
  {
    scopeId: CheckpointScopeId,
    parentCheckpointId: Schema.optional(CheckpointId),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to capture checkpoint for scope ${this.scopeId}.`;
  }
}

export class CheckpointRestoreError extends Schema.TaggedError<CheckpointRestoreError>()(
  "CheckpointRestoreError",
  {
    scopeId: CheckpointScopeId,
    checkpointId: CheckpointId,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to restore checkpoint ${this.checkpointId} for scope ${this.scopeId}.`;
  }
}

export class CheckpointDeleteStaleRefsError extends Schema.TaggedError<CheckpointDeleteStaleRefsError>()(
  "CheckpointDeleteStaleRefsError",
  {
    scopeId: CheckpointScopeId,
    checkpointIds: Schema.Array(CheckpointId),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to delete stale checkpoint refs for scope ${this.scopeId}.`;
  }
}

/** A repository worktree's files cannot be restored as asked; nothing was changed. */
export class CheckpointRepositoryUnavailableError extends Schema.TaggedError<CheckpointRepositoryUnavailableError>()(
  "CheckpointRepositoryUnavailableError",
  {
    repository: Schema.String,
    worktreePath: Schema.String,
    reason: Schema.Literals([
      "checkpoint-missing",
      "worktree-unrelated",
      "source-missing",
      "branch-missing",
      "branch-in-use",
      "submodule-changes",
      "submodule-commit-missing",
      "submodule-untracked-files",
    ]),
    submodulePath: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    const at = `${this.repository} at ${this.worktreePath}`;
    switch (this.reason) {
      case "checkpoint-missing":
        return `No checkpoint of ${at} is left for this turn.`;
      case "worktree-unrelated":
        return `${this.worktreePath} is no longer a worktree of ${this.repository}, so it was left as it is.`;
      case "source-missing":
        return `The worktree of ${at} is gone, and so is the checkout it came from, so it can't be recreated.`;
      case "branch-missing":
        return `The worktree of ${at} is gone, and its branch no longer exists, so it can't be recreated.`;
      case "branch-in-use":
        return `The worktree of ${at} is gone, and another worktree has its branch checked out, so it can't be recreated.`;
      case "submodule-changes":
        return `The submodule ${this.submodulePath ?? ""} in ${at} has uncommitted changes. Commit or move them first.`;
      case "submodule-commit-missing":
        return `The submodule ${this.submodulePath ?? ""} in ${at} no longer has the commit this turn used.`;
      case "submodule-untracked-files":
        return `The submodule ${this.submodulePath ?? ""} in ${at} has untracked or ignored files that the commit this turn used would replace. Move them first.`;
    }
  }
}

export class CheckpointRepositoryRestoreError extends Schema.TaggedError<CheckpointRepositoryRestoreError>()(
  "CheckpointRepositoryRestoreError",
  {
    repository: Schema.String,
    worktreePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to restore the files of ${this.repository} at ${this.worktreePath}.`;
  }
}

export const CheckpointServiceV2Error = Schema.Union([
  CheckpointRootScopePrepareError,
  CheckpointBaselineCaptureError,
  CheckpointCaptureError,
  CheckpointRestoreError,
  CheckpointDeleteStaleRefsError,
  CheckpointRepositoryUnavailableError,
  CheckpointRepositoryRestoreError,
]);
export type CheckpointServiceV2Error = typeof CheckpointServiceV2Error.Type;

const isCheckpointRestoreError = Schema.is(CheckpointRestoreError);
const isCheckpointRepositoryUnavailableError = Schema.is(CheckpointRepositoryUnavailableError);

/** Which repository worktree a snapshot belongs to. */
export type CheckpointRepositoryIdentity = Pick<
  OrchestrationV2CheckpointRepository,
  "repository" | "repositoryPath" | "worktreePath" | "branch"
>;

/** What the history walk needs from a thread's checkpoints and runs. */
export interface RepositoryCheckpointHistory {
  readonly scopeId: CheckpointScopeId;
  readonly checkpoints: ReadonlyArray<
    Pick<OrchestrationV2Checkpoint, "scopeId" | "ordinalWithinScope" | "status" | "repositories">
  >;
  readonly runs: ReadonlyArray<Pick<OrchestrationV2Run, "ordinal">>;
}

/**
 * The thread's runs. A snapshot left where a rolled-back run ended is reused
 * as a baseline only if it was captured as one since.
 */
export type CheckpointRunHistory = ReadonlyArray<Pick<OrchestrationV2Run, "ordinal" | "status">>;

export type RepositorySnapshot =
  | { readonly _tag: "found"; readonly ordinal: number; readonly ref: CheckpointRef }
  /** A snapshot this ordinal should have is missing or failed to capture. */
  | { readonly _tag: "unavailable"; readonly ordinal: number }
  /** The thread has no snapshot of the worktree at or after the target. */
  | { readonly _tag: "none" };

export interface RepositoryRestorePlan {
  /** The worktree folder is gone and gets recreated from its branch before the restore. */
  readonly recreate: boolean;
}

export interface CheckpointServiceV2Shape {
  readonly prepareRootRunScope: (input: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly rootNodeId: NodeId;
    readonly providerThreadId: ProviderThreadId;
    readonly cwd: string;
    readonly createdAt: DateTime.Utc;
  }) => Effect.Effect<OrchestrationV2CheckpointScope, CheckpointServiceV2Error>;
  /** Repository worktrees are captured first and never fail the call. */
  readonly captureBaseline: (input: {
    readonly scope: OrchestrationV2CheckpointScope;
    readonly ordinalWithinScope: number;
    readonly repoWorktrees?: ReadonlyArray<ThreadRepoWorktree>;
    readonly runs?: CheckpointRunHistory;
  }) => Effect.Effect<void, CheckpointServiceV2Error>;
  /**
   * Snapshots a worktree the thread is attaching, before the agent edits it,
   * so the turn's diff and rollback start from what was already there.
   */
  readonly captureRepositoryBaseline: (input: {
    readonly threadId: ThreadId;
    readonly repoWorktree: ThreadRepoWorktree;
    readonly ordinalWithinScope: number;
    readonly runs?: CheckpointRunHistory;
  }) => Effect.Effect<OrchestrationV2CheckpointStatus>;
  readonly materializeBaselineCheckpoint: (input: {
    readonly scope: OrchestrationV2CheckpointScope;
    readonly ordinalWithinScope: number;
    /** The run materializing the baseline: its root node, and when it was requested. */
    readonly nodeId: NodeId;
    readonly capturedAt: DateTime.Utc;
    readonly runs?: CheckpointRunHistory;
    /** Records a missing checkpoint without touching git, for side chats sharing a parent's worktree. */
    readonly forceMissing?: boolean;
  }) => Effect.Effect<OrchestrationV2Checkpoint, CheckpointServiceV2Error>;
  readonly capture: (input: {
    readonly scope: OrchestrationV2CheckpointScope;
    readonly runId: RunId | null;
    readonly nodeId: NodeId;
    readonly ordinalWithinScope: number;
    readonly appRunOrdinal: number | null;
    readonly capturedAt: DateTime.Utc;
    readonly repoWorktrees?: ReadonlyArray<ThreadRepoWorktree>;
    /** Decides whether the previous ordinal's snapshot can be counted against. */
    readonly runs?: CheckpointRunHistory;
    /** The thread's checkpoints so far; their path prefixes stay their worktrees'. */
    readonly checkpoints?: ReadonlyArray<
      Pick<OrchestrationV2Checkpoint, "scopeId" | "repositories">
    >;
    readonly forceMissing?: boolean;
  }) => Effect.Effect<OrchestrationV2Checkpoint, CheckpointServiceV2Error>;
  /**
   * Gives earlier checkpoints that have no usable snapshot (a folder that is
   * not a Git repository, say) the repository snapshots a rollback to them
   * would restore, so those turns can be rewound too.
   */
  readonly backfillRepositories: (input: {
    readonly scope: OrchestrationV2CheckpointScope;
    readonly checkpoint: OrchestrationV2Checkpoint;
    readonly checkpoints: ReadonlyArray<OrchestrationV2Checkpoint>;
    readonly runs: RepositoryCheckpointHistory["runs"];
  }) => Effect.Effect<ReadonlyArray<OrchestrationV2Checkpoint>, CheckpointServiceV2Error>;
  readonly resolveRepositorySnapshot: (input: {
    readonly history: RepositoryCheckpointHistory;
    readonly repository: CheckpointRepositoryIdentity;
    readonly targetOrdinal: number;
  }) => Effect.Effect<RepositorySnapshot>;
  /** Checks a repository restore before anything changes. */
  readonly inspectRepositoryRestore: (input: {
    readonly repository: CheckpointRepositoryIdentity;
    readonly ref: CheckpointRef;
  }) => Effect.Effect<RepositoryRestorePlan, CheckpointServiceV2Error>;
  readonly restoreRepository: (input: {
    readonly repository: CheckpointRepositoryIdentity;
    readonly ref: CheckpointRef;
  }) => Effect.Effect<void, CheckpointServiceV2Error>;
  /** The key of the repository lease that attaching and removing its worktrees take. */
  readonly repositoryLeaseKey: (
    repository: Pick<CheckpointRepositoryIdentity, "repositoryPath" | "worktreePath">,
  ) => Effect.Effect<string | null>;
  readonly restore: (input: {
    readonly scope: OrchestrationV2CheckpointScope;
    readonly checkpoint: OrchestrationV2Checkpoint;
    /** Also move submodule checkouts, as a repository worktree restore does. */
    readonly alignSubmodules?: boolean;
  }) => Effect.Effect<void, CheckpointServiceV2Error>;
  /** Repository refs that a `keep` checkpoint still names survive. */
  readonly deleteStaleRefs: (input: {
    readonly scope: OrchestrationV2CheckpointScope;
    readonly checkpoints: ReadonlyArray<OrchestrationV2Checkpoint>;
    readonly keep?: ReadonlyArray<Pick<OrchestrationV2Checkpoint, "repositories">>;
  }) => Effect.Effect<void, CheckpointServiceV2Error>;
}

export class CheckpointServiceV2 extends Context.Service<
  CheckpointServiceV2,
  CheckpointServiceV2Shape
>()("t3/orchestration-v2/CheckpointService/CheckpointServiceV2") {}

const checkpointRefForKey = Effect.fn("checkpointRefForKey")(function* (
  key: string,
  ordinalWithinScope: number,
) {
  const sha256 = yield* Digest.Digest;
  const digest = yield* sha256
    .digest(Digest.sha256, new TextEncoder().encode(key))
    .pipe(Effect.orDie);
  const scopeKey = Hex.encode(digest).slice(0, 32);
  return CheckpointRef.make(
    `${CHECKPOINT_REFS_PREFIX}/${Base64Url.encode(scopeKey)}/ordinal/${ordinalWithinScope}`,
  );
});

export const checkpointRefForScopeOrdinal = Effect.fn("checkpointRefForScopeOrdinal")(
  function* (input: { readonly scopeId: CheckpointScopeId; readonly ordinalWithinScope: number }) {
    return yield* checkpointRefForKey(input.scopeId, input.ordinalWithinScope);
  },
);

/**
 * Lives in the worktree's repository. Two worktrees of one repository share
 * its refs, so the worktree path is part of the key.
 */
const checkpointRefForRepository = Effect.fn("checkpointRefForRepository")(function* (input: {
  readonly scopeId: CheckpointScopeId;
  readonly worktreePath: string;
  readonly ordinalWithinScope: number;
}) {
  return yield* checkpointRefForKey(
    `${input.scopeId}\u0000repository\u0000${input.worktreePath}`,
    input.ordinalWithinScope,
  );
});

/** The status of the scope's own workspace snapshot. */
export const checkpointWorkspaceStatus = (
  checkpoint: Pick<OrchestrationV2Checkpoint, "status" | "workspaceStatus">,
): OrchestrationV2CheckpointStatus => checkpoint.workspaceStatus ?? checkpoint.status;

function aggregateCheckpointStatus(
  workspaceStatus: OrchestrationV2CheckpointStatus,
  repositories: ReadonlyArray<Pick<OrchestrationV2CheckpointRepository, "status">>,
): OrchestrationV2CheckpointStatus {
  const statuses = [workspaceStatus, ...repositories.map((repository) => repository.status)];
  if (statuses.includes("ready")) return "ready";
  return statuses.includes("error") ? "error" : "missing";
}

/** Paths the checkpoint lists for its own workspace, without the repositories' paths. */
export function checkpointWorkspaceFiles(
  checkpoint: Pick<OrchestrationV2Checkpoint, "files" | "repositories">,
): OrchestrationV2Checkpoint["files"] {
  const prefixes = (checkpoint.repositories ?? []).map((repository) => `${repository.pathPrefix}/`);
  return prefixes.length === 0
    ? checkpoint.files
    : checkpoint.files.filter((file) => !prefixes.some((prefix) => file.path.startsWith(prefix)));
}

/**
 * Names each worktree's paths after its repository; two worktrees of one repository, ever in
 * the scope, or of the folder itself, add the folder name, and a number if those match too.
 * An earlier checkpoint's prefix stays its worktree's, so diffs across turns name each apart.
 */
export function repositoryPathPrefixes(
  path: Path.Path,
  repositories: ReadonlyArray<
    Pick<ThreadRepoWorktree, "repository" | "repositoryPath" | "worktreePath">
  >,
  earlier: ReadonlyArray<
    Pick<
      OrchestrationV2CheckpointRepository,
      "repository" | "repositoryPath" | "worktreePath" | "pathPrefix"
    >
  > = [],
): ReadonlyMap<string, string> {
  const nameOf = (entry: Pick<ThreadRepoWorktree, "repository" | "repositoryPath">) =>
    entry.repository === "."
      ? path.basename(entry.repositoryPath) || "repository"
      : entry.repository;
  // The first worktree to use a prefix owns it.
  const owners = new Map<string, string>();
  const kept = new Map<string, string>();
  for (const entry of earlier) {
    if (!owners.has(entry.pathPrefix)) owners.set(entry.pathPrefix, entry.worktreePath);
    kept.set(entry.worktreePath, entry.pathPrefix);
  }
  const worktreesByName = new Map<string, Set<string>>();
  for (const entry of [...earlier, ...repositories]) {
    const worktrees = worktreesByName.get(nameOf(entry)) ?? new Set<string>();
    worktreesByName.set(nameOf(entry), worktrees.add(entry.worktreePath));
  }
  const used = new Set(owners.keys());
  return new Map(
    repositories.map((entry) => {
      const previous = kept.get(entry.worktreePath);
      if (previous !== undefined && owners.get(previous) === entry.worktreePath) {
        return [entry.worktreePath, previous] as const;
      }
      const name = nameOf(entry);
      const base =
        entry.repository === "." || (worktreesByName.get(name)?.size ?? 0) > 1
          ? `${name}@${path.basename(entry.worktreePath)}`
          : name;
      let prefix = base;
      for (let suffix = 2; used.has(prefix); suffix += 1) prefix = `${base}-${suffix}`;
      used.add(prefix);
      return [entry.worktreePath, prefix] as const;
    }),
  );
}

/**
 * The snapshot of a repository worktree that rewinding to `targetOrdinal` restores: the one the
 * target checkpoint lists, or else the earliest one taken after it, from when the thread first
 * attached the worktree, even if that run was rolled back. A snapshot a later checkpoint relied on
 * is never passed over for a newer one.
 */
export const resolveRepositorySnapshot = Effect.fn("resolveRepositorySnapshot")(function* (input: {
  readonly history: RepositoryCheckpointHistory;
  readonly worktreePath: string;
  /** A checkout of the repository; its refs live in the common Git directory. */
  readonly cwd: string;
  readonly targetOrdinal: number;
  /** Only snapshots before this ordinal count. */
  readonly beforeOrdinal?: number;
}) {
  const checkpointStore = yield* CheckpointStore.CheckpointStore;
  const entryAt = (ordinal: number, options?: { readonly includeStale: boolean }) =>
    input.history.checkpoints
      .find(
        (checkpoint) =>
          checkpoint.scopeId === input.history.scopeId &&
          checkpoint.ordinalWithinScope === ordinal &&
          (options?.includeStale === true || checkpoint.status !== "stale"),
      )
      ?.repositories?.find((repository) => repository.worktreePath === input.worktreePath);
  const target = entryAt(input.targetOrdinal);
  if (target !== undefined) {
    return target.status === "ready"
      ? ({ _tag: "found", ordinal: input.targetOrdinal, ref: target.ref } as const)
      : ({ _tag: "unavailable", ordinal: input.targetOrdinal } as const);
  }
  const before = input.beforeOrdinal ?? Number.POSITIVE_INFINITY;
  const existing = (ordinal: number) =>
    checkpointRefForRepository({
      scopeId: input.history.scopeId,
      worktreePath: input.worktreePath,
      ordinalWithinScope: ordinal,
    }).pipe(
      Effect.flatMap((ref) =>
        checkpointStore.hasCheckpointRef({ cwd: input.cwd, checkpointRef: ref }).pipe(
          Effect.orElseSucceed(() => false),
          Effect.map((exists) => (exists ? ref : null)),
        ),
      ),
    );
  // Rolled-back runs count: a rewind deletes the snapshots its runs took at
  // their end, not the one taken when a run first attached a worktree, and a
  // retry that finishes restoring files must find the same ones as the
  // attempt before it.
  const laterRuns = [
    ...new Set(
      input.history.runs
        .filter((run) => run.ordinal > input.targetOrdinal)
        .map((run) => run.ordinal),
    ),
  ].toSorted((left, right) => left - right);
  // A run's baseline sits one ordinal below it.
  for (const runOrdinal of laterRuns) {
    const ordinal = runOrdinal - 1;
    if (ordinal >= before) break;
    const ref = yield* existing(ordinal);
    if (ref !== null) return { _tag: "found", ordinal, ref } as const;
    // A rolled-back run's stale checkpoint still records that it captured the
    // worktree. One a later turn backfilled records no such thing.
    const entry = entryAt(runOrdinal, { includeStale: true });
    if (entry !== undefined && entry.backfilled !== true) {
      return { _tag: "unavailable", ordinal } as const;
    }
  }
  // Attached between turns: the baseline sits at the latest run's ordinal,
  // which the loop above never reaches.
  const latest = Math.max(input.targetOrdinal, ...input.history.runs.map((run) => run.ordinal));
  if (latest < before) {
    const ref = yield* existing(latest);
    if (ref !== null) return { _tag: "found", ordinal: latest, ref } as const;
  }
  return { _tag: "none" } as const;
});

function checkpointIdForScopeOrdinal(
  idAllocator: IdAllocator.IdAllocatorV2["Service"],
  input: {
    readonly scopeId: CheckpointScopeId;
    readonly ordinalWithinScope: number;
  },
) {
  return idAllocator.allocate.checkpoint({
    checkpointScopeId: input.scopeId,
    name: String(input.ordinalWithinScope),
  });
}

const makeRootRunScope = Effect.fn("CheckpointService.makeRootRunScope")(function* (input: {
  readonly idAllocator: IdAllocator.IdAllocatorV2["Service"];
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly rootNodeId: NodeId;
  readonly providerThreadId: ProviderThreadId;
  readonly cwd: string;
  readonly createdAt: DateTime.Utc;
}) {
  const scopeId = yield* input.idAllocator.allocate.checkpointScope({
    threadId: input.threadId,
    name: ROOT_CHECKPOINT_SCOPE_NAME,
  });
  return {
    id: scopeId,
    threadId: input.threadId,
    runId: input.runId,
    nodeId: input.rootNodeId,
    parentScopeId: null,
    providerThreadId: input.providerThreadId,
    kind: "root_run",
    ordinalWithinParent: 0,
    advancesAppRunCount: true,
    cwd: input.cwd,
    createdAt: input.createdAt,
  } satisfies OrchestrationV2CheckpointScope;
});

function makeCheckpoint(input: {
  readonly id: CheckpointId;
  readonly scope: OrchestrationV2CheckpointScope;
  readonly runId: RunId | null;
  readonly nodeId: NodeId;
  readonly parentCheckpointId: CheckpointId | null;
  readonly ordinalWithinScope: number;
  readonly appRunOrdinal: number | null;
  readonly ref: CheckpointRef;
  readonly status: OrchestrationV2Checkpoint["status"];
  readonly files: OrchestrationV2Checkpoint["files"];
  readonly capturedAt: DateTime.Utc;
}): OrchestrationV2Checkpoint {
  return {
    id: input.id,
    threadId: input.scope.threadId,
    scopeId: input.scope.id,
    runId: input.runId,
    nodeId: input.nodeId,
    parentCheckpointId: input.parentCheckpointId,
    ordinalWithinScope: input.ordinalWithinScope,
    appRunOrdinal: input.appRunOrdinal,
    ref: input.ref,
    status: input.status,
    files: input.files,
    capturedAt: input.capturedAt,
  };
}

function withRepositories(
  checkpoint: OrchestrationV2Checkpoint,
  repositories: ReadonlyArray<OrchestrationV2CheckpointRepository>,
  repositoryFiles: OrchestrationV2Checkpoint["files"],
): OrchestrationV2Checkpoint {
  if (repositories.length === 0) return checkpoint;
  const workspaceStatus = checkpointWorkspaceStatus(checkpoint);
  return {
    ...checkpoint,
    status: aggregateCheckpointStatus(workspaceStatus, repositories),
    files: [...checkpointWorkspaceFiles(checkpoint), ...repositoryFiles],
    workspaceStatus,
    repositories,
  };
}

/** `git config -z --get-regexp` records: the key, a newline, then the value. */
function parseConfigValues(stdout: string): ReadonlyArray<string> {
  return stdout
    .split("\0")
    .filter((record) => record.length > 0)
    .flatMap((record) => {
      const newline = record.indexOf("\n");
      return newline < 0 ? [] : [record.slice(newline + 1)];
    });
}

export const layer: Layer.Layer<
  CheckpointServiceV2,
  never,
  | CheckpointStore.CheckpointStore
  | Digest.Digest
  | IdAllocator.IdAllocatorV2
  | GitVcsDriver.GitVcsDriver
  | FileSystem.FileSystem
  | Path.Path
> = Layer.effect(
  CheckpointServiceV2,
  Effect.gen(function* () {
    const checkpointStore = yield* CheckpointStore.CheckpointStore;
    const digest = yield* Digest.Digest;
    const git = yield* GitVcsDriver.GitVcsDriver;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const isWindows = yield* HostProcess.isWindows;
    const provideDigest = Effect.provideService(Digest.Digest, digest);
    const checkpointRefFor = (input: Parameters<typeof checkpointRefForScopeOrdinal>[0]) =>
      checkpointRefForScopeOrdinal(input).pipe(provideDigest);
    const repositoryRefFor = (input: Parameters<typeof checkpointRefForRepository>[0]) =>
      checkpointRefForRepository(input).pipe(provideDigest);
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const workspaceLocks = yield* KeyedLock.make<string>();
    const withWorkspaceLock = <A, E, R>(cwd: string, effect: Effect.Effect<A, E, R>) =>
      workspaceLocks.withLock(cwd, effect);

    const isGitCheckpointable = (cwd: string) =>
      checkpointStore.isGitRepository(cwd).pipe(Effect.orElseSucceed(() => false));
    const exists = (target: string) =>
      fileSystem.exists(target).pipe(Effect.orElseSucceed(() => false));
    const realPathOr = (target: string) =>
      fileSystem.realPath(target).pipe(Effect.orElseSucceed(() => path.resolve(target)));
    const pathIdentity = (target: string) =>
      realPathOr(target).pipe(
        Effect.map((resolved) => (isWindows ? resolved.toLowerCase() : resolved)),
      );
    const probe = (
      cwd: string,
      operation: string,
      args: ReadonlyArray<string>,
      maxOutputBytes = 256 * 1024,
    ) =>
      git
        .execute({
          operation: `CheckpointService.${operation}`,
          cwd,
          args,
          allowNonZeroExit: true,
          timeoutMs: 30_000,
          maxOutputBytes,
        })
        .pipe(
          Effect.map((result) => ({ ok: result.exitCode === 0, stdout: result.stdout })),
          Effect.orElseSucceed(() => ({ ok: false, stdout: "" })),
        );
    const run = (cwd: string, operation: string, args: ReadonlyArray<string>) =>
      git.execute({ operation: `CheckpointService.${operation}`, cwd, args, timeoutMs: 60_000 });

    const changedFiles = (input: {
      readonly scopeId: CheckpointScopeId;
      readonly cwd: string;
      readonly fromCheckpointRef: CheckpointRef;
      readonly toCheckpointRef: CheckpointRef;
    }) => {
      const refs = {
        cwd: input.cwd,
        fromCheckpointRef: input.fromCheckpointRef,
        toCheckpointRef: input.toCheckpointRef,
      };
      // A pull or rebase can change thousands of files the turn did not write.
      return Effect.all([
        checkpointStore.diffCheckpoints({
          ...refs,
          fallbackFromToHead: false,
          ignoreWhitespace: false,
          format: "numstat",
        }),
        checkpointStore.listAuthoredPaths(refs).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("orchestration V2 checkpoint authored paths failed", {
              scopeId: input.scopeId,
              checkpointRef: input.toCheckpointRef,
              cause: String(cause),
            }).pipe(Effect.as(null)),
          ),
        ),
      ]).pipe(
        Effect.map(([diff, authoredPaths]) =>
          parseTurnDiffFilesFromNumstat(diff)
            .filter((file) => !isGitImport(file, authoredPaths))
            .map((file) => ({
              path: file.path,
              kind: "modified",
              additions: file.additions,
              deletions: file.deletions,
            })),
        ),
        Effect.catch((cause) =>
          Effect.logWarning("orchestration V2 checkpoint diff summary failed", {
            scopeId: input.scopeId,
            checkpointRef: input.toCheckpointRef,
            cause: String(cause),
          }).pipe(Effect.as([])),
        ),
      );
    };

    const refExists = (cwd: string, checkpointRef: CheckpointRef) =>
      checkpointStore.hasCheckpointRef({ cwd, checkpointRef }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("orchestration V2 checkpoint ref lookup failed", {
            checkpointRef,
            cause: String(cause),
          }).pipe(Effect.as(false)),
        ),
      );

    // A rewind deletes the snapshots its runs took at their end, but Git can
    // refuse, as when another process holds the ref's lock. One left where a
    // rolled-back run ended still holds that run's files. Only a baseline
    // captured there since matches what the next run starts from.
    const isStaleSnapshot = (input: {
      readonly cwd: string;
      readonly checkpointRef: CheckpointRef;
      readonly ordinalWithinScope: number;
      readonly runs: CheckpointRunHistory | undefined;
    }) =>
      input.runs?.some(
        (run) => run.ordinal === input.ordinalWithinScope && run.status === "rolled_back",
      ) === true
        ? checkpointStore
            .isBaselineCheckpoint({ cwd: input.cwd, checkpointRef: input.checkpointRef })
            .pipe(
              Effect.map((baseline) => !baseline),
              Effect.catch((cause) =>
                Effect.logWarning("orchestration V2 checkpoint baseline lookup failed", {
                  checkpointRef: input.checkpointRef,
                  cause: String(cause),
                }).pipe(Effect.as(true)),
              ),
            )
        : Effect.succeed(false);

    const captureRepositorySnapshotIfMissing = (input: {
      readonly scopeId: CheckpointScopeId;
      readonly repoWorktree: ThreadRepoWorktree;
      readonly ordinalWithinScope: number;
      readonly runs: CheckpointRunHistory | undefined;
    }): Effect.Effect<OrchestrationV2CheckpointStatus> =>
      withWorkspaceLock(
        input.repoWorktree.worktreePath,
        Effect.gen(function* () {
          const cwd = input.repoWorktree.worktreePath;
          if (!(yield* isGitCheckpointable(cwd))) return "missing";
          const checkpointRef = yield* repositoryRefFor({
            scopeId: input.scopeId,
            worktreePath: cwd,
            ordinalWithinScope: input.ordinalWithinScope,
          });
          if (
            (yield* refExists(cwd, checkpointRef)) &&
            !(yield* isStaleSnapshot({ ...input, cwd, checkpointRef }))
          ) {
            return "ready";
          }
          yield* checkpointStore.captureCheckpoint({ cwd, checkpointRef, baseline: true });
          return "ready" as const;
        }),
      ).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("orchestration V2 repository baseline capture failed", {
            scopeId: input.scopeId,
            ordinalWithinScope: input.ordinalWithinScope,
            cause: String(cause),
          }).pipe(Effect.as("error" as const)),
        ),
      );

    const captureBaseline: CheckpointServiceV2Shape["captureBaseline"] = (input) =>
      Effect.forEach(
        input.repoWorktrees ?? [],
        (repoWorktree) =>
          captureRepositorySnapshotIfMissing({
            scopeId: input.scope.id,
            repoWorktree,
            ordinalWithinScope: input.ordinalWithinScope,
            runs: input.runs,
          }),
        { discard: true },
      ).pipe(
        Effect.andThen(
          withWorkspaceLock(
            input.scope.cwd,
            Effect.gen(function* () {
              if (!(yield* isGitCheckpointable(input.scope.cwd))) {
                return;
              }

              const checkpointRef = yield* checkpointRefFor({
                scopeId: input.scope.id,
                ordinalWithinScope: input.ordinalWithinScope,
              });
              const exists = yield* checkpointStore.hasCheckpointRef({
                cwd: input.scope.cwd,
                checkpointRef,
              });
              if (
                exists &&
                !(yield* isStaleSnapshot({
                  cwd: input.scope.cwd,
                  checkpointRef,
                  ordinalWithinScope: input.ordinalWithinScope,
                  runs: input.runs,
                }))
              ) {
                return;
              }

              yield* checkpointStore
                .captureCheckpoint({
                  cwd: input.scope.cwd,
                  checkpointRef,
                  baseline: true,
                })
                .pipe(
                  Effect.catchTags({
                    VcsUnsupportedOperationError: () => Effect.void,
                  }),
                );
            }),
          ),
        ),
        Effect.mapError(
          (cause) =>
            new CheckpointBaselineCaptureError({
              scopeId: input.scope.id,
              ordinalWithinScope: input.ordinalWithinScope,
              cause,
            }),
        ),
      );

    const captureRepositoryBaseline: CheckpointServiceV2Shape["captureRepositoryBaseline"] = (
      input,
    ) =>
      idAllocator.allocate
        .checkpointScope({ threadId: input.threadId, name: ROOT_CHECKPOINT_SCOPE_NAME })
        .pipe(
          Effect.flatMap((scopeId) =>
            captureRepositorySnapshotIfMissing({
              scopeId,
              repoWorktree: input.repoWorktree,
              ordinalWithinScope: input.ordinalWithinScope,
              runs: input.runs,
            }),
          ),
          Effect.catchTags({
            IdAllocatorV2AllocationError: (cause) =>
              Effect.logWarning("orchestration V2 repository baseline scope was not allocated", {
                threadId: input.threadId,
                cause: String(cause),
              }).pipe(Effect.as("error" as const)),
          }),
        );

    const materializeBaselineCheckpoint: CheckpointServiceV2Shape["materializeBaselineCheckpoint"] =
      (input) =>
        withWorkspaceLock(
          input.scope.cwd,
          Effect.gen(function* () {
            const checkpointRef = yield* checkpointRefFor({
              scopeId: input.scope.id,
              ordinalWithinScope: input.ordinalWithinScope,
            });
            const checkpointId = yield* checkpointIdForScopeOrdinal(idAllocator, {
              scopeId: input.scope.id,
              ordinalWithinScope: input.ordinalWithinScope,
            });
            const checkpointable =
              input.forceMissing !== true && (yield* isGitCheckpointable(input.scope.cwd));
            const available = checkpointable
              ? yield* checkpointStore
                  .hasCheckpointRef({
                    cwd: input.scope.cwd,
                    checkpointRef,
                  })
                  .pipe(
                    Effect.catch((cause) =>
                      Effect.logWarning("orchestration V2 baseline ref lookup failed", {
                        scopeId: input.scope.id,
                        checkpointRef,
                        cause: String(cause),
                      }).pipe(Effect.as(false)),
                    ),
                  )
              : false;
            const stale =
              available &&
              (yield* isStaleSnapshot({
                cwd: input.scope.cwd,
                checkpointRef,
                ordinalWithinScope: input.ordinalWithinScope,
                runs: input.runs,
              }));
            return makeCheckpoint({
              id: checkpointId,
              scope: input.scope,
              runId: null,
              nodeId: input.nodeId,
              parentCheckpointId: null,
              ordinalWithinScope: input.ordinalWithinScope,
              appRunOrdinal: null,
              ref: checkpointRef,
              status: stale ? "error" : available ? "ready" : "missing",
              files: [],
              capturedAt: input.capturedAt,
            });
          }),
        ).pipe(
          Effect.mapError(
            (cause) =>
              new CheckpointCaptureError({
                scopeId: input.scope.id,
                cause,
              }),
          ),
        );

    const captureWorkspace = (input: Parameters<CheckpointServiceV2Shape["capture"]>[0]) =>
      withWorkspaceLock(
        input.scope.cwd,
        Effect.gen(function* () {
          const checkpointId = yield* checkpointIdForScopeOrdinal(idAllocator, {
            scopeId: input.scope.id,
            ordinalWithinScope: input.ordinalWithinScope,
          });
          const parentCheckpointId =
            input.ordinalWithinScope > 0
              ? yield* checkpointIdForScopeOrdinal(idAllocator, {
                  scopeId: input.scope.id,
                  ordinalWithinScope: input.ordinalWithinScope - 1,
                })
              : null;
          const checkpointRef = yield* checkpointRefFor({
            scopeId: input.scope.id,
            ordinalWithinScope: input.ordinalWithinScope,
          });
          const previousCheckpointRef = yield* checkpointRefFor({
            scopeId: input.scope.id,
            ordinalWithinScope: Math.max(0, input.ordinalWithinScope - 1),
          });

          if (input.forceMissing === true || !(yield* isGitCheckpointable(input.scope.cwd))) {
            return makeCheckpoint({
              id: checkpointId,
              scope: input.scope,
              runId: input.runId,
              nodeId: input.nodeId,
              parentCheckpointId,
              ordinalWithinScope: input.ordinalWithinScope,
              appRunOrdinal: input.appRunOrdinal,
              ref: checkpointRef,
              status: "missing",
              files: [],
              capturedAt: input.capturedAt,
            });
          }

          const captureStatus = yield* checkpointStore
            .captureCheckpoint({
              cwd: input.scope.cwd,
              checkpointRef,
            })
            .pipe(
              Effect.as("ready" as const),
              Effect.catchTags({
                VcsUnsupportedOperationError: () => Effect.succeed("missing" as const),
              }),
              Effect.catch((cause) =>
                Effect.logWarning("orchestration V2 checkpoint capture failed", {
                  scopeId: input.scope.id,
                  checkpointRef,
                  cause: String(cause),
                }).pipe(Effect.as("error" as const)),
              ),
            );

          if (captureStatus !== "ready") {
            return makeCheckpoint({
              id: checkpointId,
              scope: input.scope,
              runId: input.runId,
              nodeId: input.nodeId,
              parentCheckpointId,
              ordinalWithinScope: input.ordinalWithinScope,
              appRunOrdinal: input.appRunOrdinal,
              ref: checkpointRef,
              status: captureStatus,
              files: [],
              capturedAt: input.capturedAt,
            });
          }

          const previousExists = yield* checkpointStore
            .hasCheckpointRef({
              cwd: input.scope.cwd,
              checkpointRef: previousCheckpointRef,
            })
            .pipe(
              Effect.catch((cause) =>
                Effect.logWarning("orchestration V2 previous checkpoint ref lookup failed", {
                  scopeId: input.scope.id,
                  checkpointRef: previousCheckpointRef,
                  cause: String(cause),
                }).pipe(Effect.as(false)),
              ),
            );
          const files =
            previousExists &&
            !(yield* isStaleSnapshot({
              cwd: input.scope.cwd,
              checkpointRef: previousCheckpointRef,
              ordinalWithinScope: input.ordinalWithinScope - 1,
              runs: input.runs,
            }))
              ? yield* changedFiles({
                  scopeId: input.scope.id,
                  cwd: input.scope.cwd,
                  fromCheckpointRef: previousCheckpointRef,
                  toCheckpointRef: checkpointRef,
                })
              : [];

          return makeCheckpoint({
            id: checkpointId,
            scope: input.scope,
            runId: input.runId,
            nodeId: input.nodeId,
            parentCheckpointId,
            ordinalWithinScope: input.ordinalWithinScope,
            appRunOrdinal: input.appRunOrdinal,
            ref: checkpointRef,
            status: "ready",
            files,
            capturedAt: input.capturedAt,
          });
        }),
      );

    const captureRepository = (input: {
      readonly scopeId: CheckpointScopeId;
      readonly repoWorktree: ThreadRepoWorktree;
      readonly pathPrefix: string;
      readonly ordinalWithinScope: number;
      readonly runs: CheckpointRunHistory | undefined;
    }) =>
      withWorkspaceLock(
        input.repoWorktree.worktreePath,
        Effect.gen(function* () {
          const cwd = input.repoWorktree.worktreePath;
          const checkpointRef = yield* repositoryRefFor({
            scopeId: input.scopeId,
            worktreePath: cwd,
            ordinalWithinScope: input.ordinalWithinScope,
          });
          const entry = (
            status: OrchestrationV2CheckpointStatus,
          ): OrchestrationV2CheckpointRepository => ({
            repository: input.repoWorktree.repository,
            repositoryPath: input.repoWorktree.repositoryPath,
            worktreePath: cwd,
            branch: input.repoWorktree.branch,
            pathPrefix: input.pathPrefix,
            ref: checkpointRef,
            status,
          });
          if (!(yield* isGitCheckpointable(cwd))) {
            return { entry: entry("missing"), files: [] };
          }
          const captured = yield* checkpointStore.captureCheckpoint({ cwd, checkpointRef }).pipe(
            Effect.as(true),
            Effect.catch((cause) =>
              Effect.logWarning("orchestration V2 repository checkpoint capture failed", {
                scopeId: input.scopeId,
                checkpointRef,
                cause: String(cause),
              }).pipe(Effect.as(false)),
            ),
          );
          if (!captured) return { entry: entry("error"), files: [] };
          const previousCheckpointRef = yield* repositoryRefFor({
            scopeId: input.scopeId,
            worktreePath: cwd,
            ordinalWithinScope: Math.max(0, input.ordinalWithinScope - 1),
          });
          const files =
            input.ordinalWithinScope > 0 &&
            (yield* refExists(cwd, previousCheckpointRef)) &&
            !(yield* isStaleSnapshot({
              cwd,
              checkpointRef: previousCheckpointRef,
              ordinalWithinScope: input.ordinalWithinScope - 1,
              runs: input.runs,
            }))
              ? yield* changedFiles({
                  scopeId: input.scopeId,
                  cwd,
                  fromCheckpointRef: previousCheckpointRef,
                  toCheckpointRef: checkpointRef,
                })
              : [];
          return {
            entry: entry("ready"),
            files: files.map((file) => ({ ...file, path: `${input.pathPrefix}/${file.path}` })),
          };
        }),
      );

    const capture: CheckpointServiceV2Shape["capture"] = Effect.fn("CheckpointService.capture")(
      function* (input) {
        const workspace = yield* captureWorkspace(input);
        const workspaceKey = yield* pathIdentity(input.scope.cwd);
        const repoWorktrees: Array<ThreadRepoWorktree> = [];
        for (const repoWorktree of input.repoWorktrees ?? []) {
          // A thread can attach its own checkout; the workspace snapshot covers it.
          if ((yield* pathIdentity(repoWorktree.worktreePath)) !== workspaceKey) {
            repoWorktrees.push(repoWorktree);
          }
        }
        const prefixes = repositoryPathPrefixes(
          path,
          repoWorktrees,
          (input.checkpoints ?? []).flatMap((checkpoint) =>
            checkpoint.scopeId === input.scope.id ? (checkpoint.repositories ?? []) : [],
          ),
        );
        const captured = yield* Effect.forEach(repoWorktrees, (repoWorktree) =>
          captureRepository({
            scopeId: input.scope.id,
            repoWorktree,
            pathPrefix: prefixes.get(repoWorktree.worktreePath) ?? repoWorktree.repository,
            ordinalWithinScope: input.ordinalWithinScope,
            runs: input.runs,
          }),
        );
        return withRepositories(
          workspace,
          captured.map(({ entry }) => entry),
          captured.flatMap(({ files }) => files),
        );
      },
      (effect, input) =>
        effect.pipe(
          Effect.mapError(
            (cause) =>
              new CheckpointCaptureError({
                scopeId: input.scope.id,
                cause,
              }),
          ),
        ),
    );

    const resolveSnapshot: CheckpointServiceV2Shape["resolveRepositorySnapshot"] = Effect.fn(
      "CheckpointService.resolveRepositorySnapshot",
    )(function* (input) {
      const cwd = (yield* exists(input.repository.worktreePath))
        ? input.repository.worktreePath
        : input.repository.repositoryPath;
      return yield* resolveRepositorySnapshot({
        history: input.history,
        worktreePath: input.repository.worktreePath,
        cwd,
        targetOrdinal: input.targetOrdinal,
      }).pipe(
        provideDigest,
        Effect.provideService(CheckpointStore.CheckpointStore, checkpointStore),
      );
    });

    const backfillRepositories: CheckpointServiceV2Shape["backfillRepositories"] = Effect.fn(
      "CheckpointService.backfillRepositories",
    )(
      function* (input) {
        const entries = input.checkpoint.repositories ?? [];
        const latestOrdinal = input.checkpoint.ordinalWithinScope;
        if (entries.length === 0) return [];
        const scopeCheckpoints = [
          ...input.checkpoints.filter(
            (candidate) =>
              candidate.scopeId === input.scope.id && candidate.id !== input.checkpoint.id,
          ),
          input.checkpoint,
        ];
        const history: RepositoryCheckpointHistory = {
          scopeId: input.scope.id,
          checkpoints: scopeCheckpoints,
          runs: input.runs,
        };
        const ordinals = new Set<number>(
          [0, latestOrdinal - 1].filter((ordinal) => ordinal >= 0 && ordinal < latestOrdinal),
        );
        for (const candidate of scopeCheckpoints) {
          if (candidate.ordinalWithinScope < latestOrdinal && candidate.status === "missing") {
            ordinals.add(candidate.ordinalWithinScope);
          }
        }
        const workspaceCheckpointable = yield* isGitCheckpointable(input.scope.cwd);
        const upgraded: Array<OrchestrationV2Checkpoint> = [];
        for (const ordinal of [...ordinals].toSorted((left, right) => left - right)) {
          const existing = scopeCheckpoints.find(
            (candidate) => candidate.ordinalWithinScope === ordinal,
          );
          if (
            existing !== undefined &&
            (existing.status === "ready" ||
              existing.status === "stale" ||
              existing.repositories !== undefined)
          ) {
            continue;
          }
          const repositories: Array<OrchestrationV2CheckpointRepository> = [];
          for (const entry of entries) {
            const cwd = (yield* exists(entry.worktreePath))
              ? entry.worktreePath
              : entry.repositoryPath;
            const snapshot = yield* resolveRepositorySnapshot({
              history,
              worktreePath: entry.worktreePath,
              cwd,
              targetOrdinal: ordinal,
              beforeOrdinal: latestOrdinal,
            }).pipe(
              provideDigest,
              Effect.provideService(CheckpointStore.CheckpointStore, checkpointStore),
            );
            if (snapshot._tag === "found") {
              repositories.push({ ...entry, ref: snapshot.ref, status: "ready", backfilled: true });
            } else if (snapshot._tag === "unavailable") {
              repositories.push({
                ...entry,
                ref: yield* repositoryRefFor({
                  scopeId: input.scope.id,
                  worktreePath: entry.worktreePath,
                  ordinalWithinScope: snapshot.ordinal,
                }),
                status: "error",
                backfilled: true,
              });
            }
          }
          if (existing !== undefined && repositories.length === 0) continue;
          const workspaceRef =
            existing?.ref ??
            (yield* checkpointRefFor({ scopeId: input.scope.id, ordinalWithinScope: ordinal }));
          const workspaceReady =
            workspaceCheckpointable && (yield* refExists(input.scope.cwd, workspaceRef));
          const base =
            existing ??
            makeCheckpoint({
              id: yield* checkpointIdForScopeOrdinal(idAllocator, {
                scopeId: input.scope.id,
                ordinalWithinScope: ordinal,
              }),
              scope: input.scope,
              runId: null,
              nodeId: input.scope.nodeId,
              parentCheckpointId: null,
              ordinalWithinScope: ordinal,
              appRunOrdinal: null,
              ref: workspaceRef,
              status: "missing",
              files: [],
              capturedAt: input.scope.createdAt,
            });
          upgraded.push(
            withRepositories(
              {
                ...base,
                status: workspaceReady ? "ready" : base.status === "error" ? "error" : "missing",
              },
              repositories,
              [],
            ),
          );
        }
        return upgraded;
      },
      (effect, input) =>
        effect.pipe(
          Effect.mapError(
            (cause) => new CheckpointCaptureError({ scopeId: input.scope.id, cause }),
          ),
        ),
    );

    const submoduleAlignment = Effect.fnUntraced(function* (
      worktreePath: string,
      ref: CheckpointRef,
    ) {
      const listed = yield* probe(worktreePath, "listSubmodules", [
        "config",
        "--blob",
        `${ref}:.gitmodules`,
        "-z",
        "--get-regexp",
        "^submodule\\..*\\.path$",
      ]);
      if (!listed.ok) return [];
      const worktreeKey = yield* pathIdentity(worktreePath);
      const changes: Array<{
        readonly path: string;
        readonly dir: string;
        readonly commit: string;
      }> = [];
      for (const submodulePath of parseConfigValues(listed.stdout)) {
        const segments = submodulePath.split("/").filter((segment) => segment.length > 0);
        if (segments.length === 0 || segments.some((segment) => segment === "..")) continue;
        const dir = path.join(worktreePath, ...segments);
        const toplevel = yield* probe(dir, "submoduleToplevel", ["rev-parse", "--show-toplevel"]);
        // Not checked out, so nothing there to move.
        if (
          !toplevel.ok ||
          (yield* pathIdentity(toplevel.stdout.trim())) !== (yield* pathIdentity(dir)) ||
          (yield* pathIdentity(dir)) === worktreeKey
        ) {
          continue;
        }
        const recorded = /^160000 commit ([0-9a-f]+)\t/.exec(
          (yield* probe(worktreePath, "submoduleGitlink", [
            "ls-tree",
            "-z",
            `${ref}^{tree}`,
            "--",
            submodulePath,
          ])).stdout,
        );
        if (recorded === null) continue;
        const head = (yield* probe(dir, "submoduleHead", ["rev-parse", "HEAD"])).stdout.trim();
        if (head !== recorded[1]) {
          changes.push({ path: submodulePath, dir, commit: recorded[1]! });
        }
      }
      return changes;
    });

    const submoduleProblem = Effect.fnUntraced(function* (change: {
      readonly dir: string;
      readonly commit: string;
    }) {
      const status = yield* probe(change.dir, "submoduleChanges", [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=no",
      ]);
      if (!status.ok || status.stdout.length > 0) return "submodule-changes" as const;
      const present = yield* probe(change.dir, "submoduleCommit", [
        "cat-file",
        "-e",
        `${change.commit}^{commit}`,
      ]);
      if (!present.ok) return "submodule-commit-missing" as const;
      // Checkout would replace an ignored file at a path the commit adds, or
      // refuse an untracked one after other files were restored, so both refuse here.
      const changed = yield* probe(
        change.dir,
        "submoduleAddedFiles",
        ["diff-tree", "-r", "-z", "--name-status", "--diff-filter=AD", "HEAD", change.commit],
        CHECKPOINT_DIFF_MAX_OUTPUT_BYTES,
      );
      if (!changed.ok) return "submodule-changes" as const;
      const fields = changed.stdout.split("\0");
      const removed = new Set<string>();
      const added: Array<string> = [];
      for (let index = 0; index + 1 < fields.length; index += 2) {
        if (fields[index] === "D") removed.add(fields[index + 1]!);
        else added.push(fields[index + 1]!);
      }
      for (const file of added) {
        const segments = file.split("/");
        for (let depth = 1; depth <= segments.length; depth += 1) {
          const relative = segments.slice(0, depth).join("/");
          const found = yield* fileSystem
            .lstat(path.join(change.dir, relative))
            .pipe(Effect.orElseSucceed(() => null));
          if (found === null) break;
          // A file HEAD tracks where the commit has a folder is Git's to replace.
          if (depth === segments.length || (found.type !== "Directory" && !removed.has(relative))) {
            return "submodule-untracked-files" as const;
          }
        }
      }
      return null;
    });

    // The restored tree records each submodule's commit; its checkout follows, as pinning
    // left it. All are checked before any file changes, and none moves unless all can.
    const prepareSubmoduleAlignment = Effect.fnUntraced(function* (
      cwd: string,
      ref: CheckpointRef,
    ) {
      const changes = yield* submoduleAlignment(cwd, ref);
      for (const change of changes) {
        const problem = yield* submoduleProblem(change);
        if (problem !== null) return { problem, path: change.path } as const;
      }
      return {
        problem: null,
        move: Effect.forEach(
          changes,
          (change) =>
            run(change.dir, "alignSubmodule", [
              "checkout",
              "--quiet",
              "--no-overwrite-ignore",
              "--detach",
              change.commit,
            ]),
          { discard: true },
        ),
      } as const;
    });

    const commonDirOf = (cwd: string) =>
      probe(cwd, "commonDir", ["rev-parse", "--path-format=absolute", "--git-common-dir"]).pipe(
        Effect.flatMap((result) =>
          result.ok && result.stdout.trim() !== ""
            ? pathIdentity(result.stdout.trim())
            : Effect.succeed(null),
        ),
      );

    const inspectRepositoryRestore: CheckpointServiceV2Shape["inspectRepositoryRestore"] =
      Effect.fn("CheckpointService.inspectRepositoryRestore")(function* (input) {
        const { repository } = input;
        const unavailable = (
          reason: CheckpointRepositoryUnavailableError["reason"],
          submodulePath?: string,
        ) =>
          new CheckpointRepositoryUnavailableError({
            repository: repository.repository,
            worktreePath: repository.worktreePath,
            reason,
            ...(submodulePath === undefined ? {} : { submodulePath }),
          });
        const sourceCommonDir = (yield* exists(repository.repositoryPath))
          ? yield* commonDirOf(repository.repositoryPath)
          : null;

        if (!(yield* exists(repository.worktreePath))) {
          if (sourceCommonDir === null) return yield* unavailable("source-missing");
          if (repository.branch === null) return yield* unavailable("branch-missing");
          const branchRef = `refs/heads/${repository.branch}`;
          const branch = yield* probe(repository.repositoryPath, "branchExists", [
            "show-ref",
            "--verify",
            "--quiet",
            branchRef,
          ]);
          if (!branch.ok) return yield* unavailable("branch-missing");
          const worktrees = yield* probe(repository.repositoryPath, "listWorktrees", [
            "worktree",
            "list",
            "--porcelain",
          ]);
          // A record whose folder is gone is pruned before the worktree is recreated.
          for (const record of worktrees.stdout.split("\n\n")) {
            const lines = record.split("\n");
            if (
              lines.includes(`branch ${branchRef}`) &&
              !lines.some((line) => line === "prunable" || line.startsWith("prunable "))
            ) {
              return yield* unavailable("branch-in-use");
            }
          }
          if (!(yield* refExists(repository.repositoryPath, input.ref))) {
            return yield* unavailable("checkpoint-missing");
          }
          return { recreate: true };
        }

        const located = yield* probe(repository.worktreePath, "locateWorktree", [
          "rev-parse",
          "--path-format=absolute",
          "--show-toplevel",
          "--git-dir",
          "--git-common-dir",
        ]);
        const [toplevel = "", gitDir = "", commonDir = ""] = located.stdout.trim().split("\n");
        // Only a linked worktree of the same repository, never its source checkout.
        if (
          !located.ok ||
          (yield* pathIdentity(toplevel)) !== (yield* pathIdentity(repository.worktreePath)) ||
          (yield* pathIdentity(gitDir)) === (yield* pathIdentity(commonDir)) ||
          (sourceCommonDir !== null && (yield* pathIdentity(commonDir)) !== sourceCommonDir) ||
          (yield* pathIdentity(repository.worktreePath)) ===
            (yield* pathIdentity(repository.repositoryPath))
        ) {
          return yield* unavailable("worktree-unrelated");
        }
        if (!(yield* refExists(repository.worktreePath, input.ref))) {
          return yield* unavailable("checkpoint-missing");
        }
        for (const change of yield* submoduleAlignment(repository.worktreePath, input.ref)) {
          const problem = yield* submoduleProblem(change);
          if (problem !== null) return yield* unavailable(problem, change.path);
        }
        return { recreate: false };
      });

    const restoreRepository: CheckpointServiceV2Shape["restoreRepository"] = (input) =>
      withWorkspaceLock(
        input.repository.worktreePath,
        Effect.gen(function* () {
          const cwd = input.repository.worktreePath;
          const submodules = yield* prepareSubmoduleAlignment(cwd, input.ref);
          if (submodules.problem !== null) {
            return yield* new CheckpointRepositoryUnavailableError({
              repository: input.repository.repository,
              worktreePath: cwd,
              reason: submodules.problem,
              submodulePath: submodules.path,
            });
          }
          const restored = yield* checkpointStore.restoreCheckpoint({
            cwd,
            checkpointRef: input.ref,
            fallbackToHead: false,
          });
          if (!restored) {
            return yield* new CheckpointRepositoryUnavailableError({
              repository: input.repository.repository,
              worktreePath: cwd,
              reason: "checkpoint-missing",
            });
          }
          yield* submodules.move;
        }),
      ).pipe(
        Effect.mapError((cause) =>
          isCheckpointRepositoryUnavailableError(cause)
            ? cause
            : new CheckpointRepositoryRestoreError({
                repository: input.repository.repository,
                worktreePath: input.repository.worktreePath,
                cause,
              }),
        ),
      );

    const repositoryLeaseKey: CheckpointServiceV2Shape["repositoryLeaseKey"] = Effect.fn(
      "CheckpointService.repositoryLeaseKey",
    )(function* (repository) {
      for (const cwd of [repository.repositoryPath, repository.worktreePath]) {
        if (!(yield* exists(cwd))) continue;
        const commonDir = yield* commonDirOf(cwd);
        if (commonDir !== null) return commonDir;
      }
      return null;
    });

    const restore: CheckpointServiceV2Shape["restore"] = (input) =>
      withWorkspaceLock(
        input.scope.cwd,
        Effect.gen(function* () {
          if (checkpointWorkspaceStatus(input.checkpoint) !== "ready") {
            return yield* new CheckpointRestoreError({
              scopeId: input.scope.id,
              checkpointId: input.checkpoint.id,
              cause: `Checkpoint status is ${checkpointWorkspaceStatus(input.checkpoint)}.`,
            });
          }

          const submodules =
            input.alignSubmodules === true
              ? yield* prepareSubmoduleAlignment(input.scope.cwd, input.checkpoint.ref)
              : null;
          if (submodules !== null && submodules.problem !== null) {
            return yield* new CheckpointRestoreError({
              scopeId: input.scope.id,
              checkpointId: input.checkpoint.id,
              cause: `Submodule ${submodules.path} was not moved: ${submodules.problem}.`,
            });
          }
          const restored = yield* checkpointStore.restoreCheckpoint({
            cwd: input.scope.cwd,
            checkpointRef: input.checkpoint.ref,
            fallbackToHead: false,
          });
          if (!restored) {
            return yield* new CheckpointRestoreError({
              scopeId: input.scope.id,
              checkpointId: input.checkpoint.id,
              cause: "Checkpoint ref is unavailable.",
            });
          }
          if (submodules !== null) yield* submodules.move;
        }),
      ).pipe(
        Effect.mapError((cause) =>
          isCheckpointRestoreError(cause)
            ? cause
            : new CheckpointRestoreError({
                scopeId: input.scope.id,
                checkpointId: input.checkpoint.id,
                cause,
              }),
        ),
      );

    const deleteStaleRepositoryRefs = Effect.fn("CheckpointService.deleteStaleRepositoryRefs")(
      function* (input: {
        readonly checkpoints: ReadonlyArray<OrchestrationV2Checkpoint>;
        readonly keep: ReadonlyArray<Pick<OrchestrationV2Checkpoint, "repositories">>;
      }) {
        // Backfilled checkpoints share a baseline ref with later ones. Entries
        // stored before backfills were marked rely on this.
        const kept = new Set(
          input.keep.flatMap(
            (checkpoint) =>
              checkpoint.repositories?.map((entry) => `${entry.worktreePath}\0${entry.ref}`) ?? [],
          ),
        );
        const byWorktree = new Map<
          string,
          { readonly entry: OrchestrationV2CheckpointRepository; readonly refs: Set<CheckpointRef> }
        >();
        for (const checkpoint of input.checkpoints) {
          for (const entry of checkpoint.repositories ?? []) {
            // It names the snapshot taken when the worktree was attached, which
            // an earlier rewind still restores.
            if (entry.backfilled === true) continue;
            if (kept.has(`${entry.worktreePath}\0${entry.ref}`)) continue;
            const group = byWorktree.get(entry.worktreePath) ?? { entry, refs: new Set() };
            group.refs.add(entry.ref);
            byWorktree.set(entry.worktreePath, group);
          }
        }
        for (const { entry, refs } of byWorktree.values()) {
          const cwd = (yield* exists(entry.worktreePath))
            ? entry.worktreePath
            : (yield* exists(entry.repositoryPath))
              ? entry.repositoryPath
              : null;
          if (cwd === null) continue;
          yield* withWorkspaceLock(
            entry.worktreePath,
            checkpointStore.deleteCheckpointRefs({ cwd, checkpointRefs: [...refs] }),
          ).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("orchestration V2 stale repository refs were kept", {
                worktreePath: entry.worktreePath,
                cause: String(cause),
              }),
            ),
          );
        }
      },
    );

    // Cleanup only: a ref Git refuses to delete is never reused as a baseline
    // (see `isStaleSnapshot`), so the rewind still completes without it.
    const deleteStaleRefs: CheckpointServiceV2Shape["deleteStaleRefs"] = Effect.fn(
      "CheckpointService.deleteStaleRefs",
    )(
      function* (input) {
        const workspaceRefs = input.checkpoints
          .filter((checkpoint) => checkpointWorkspaceStatus(checkpoint) !== "missing")
          .map((checkpoint) => checkpoint.ref);
        if (workspaceRefs.length > 0) {
          yield* withWorkspaceLock(
            input.scope.cwd,
            checkpointStore.deleteCheckpointRefs({
              cwd: input.scope.cwd,
              checkpointRefs: workspaceRefs,
            }),
          ).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("orchestration V2 stale checkpoint refs were kept", {
                scopeId: input.scope.id,
                cause: String(cause),
              }),
            ),
          );
        }
        yield* deleteStaleRepositoryRefs({
          checkpoints: input.checkpoints,
          keep: input.keep ?? [],
        });
      },
      (effect, input) =>
        effect.pipe(
          Effect.mapError(
            (cause) =>
              new CheckpointDeleteStaleRefsError({
                scopeId: input.scope.id,
                checkpointIds: input.checkpoints.map((checkpoint) => checkpoint.id),
                cause,
              }),
          ),
        ),
    );

    return CheckpointServiceV2.of({
      prepareRootRunScope: (input) =>
        makeRootRunScope({ ...input, idAllocator }).pipe(
          Effect.mapError(
            (cause) =>
              new CheckpointRootScopePrepareError({
                threadId: input.threadId,
                runId: input.runId,
                cause,
              }),
          ),
        ),
      captureBaseline,
      captureRepositoryBaseline,
      materializeBaselineCheckpoint,
      capture,
      backfillRepositories,
      resolveRepositorySnapshot: resolveSnapshot,
      inspectRepositoryRestore,
      restoreRepository,
      repositoryLeaseKey,
      restore,
      deleteStaleRefs,
    } satisfies CheckpointServiceV2Shape);
  }),
);
