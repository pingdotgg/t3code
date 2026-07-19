import {
  VcsWorkflowError,
  type VcsConflict,
  type VcsNamedRef,
  type VcsRevision,
} from "@t3tools/contracts";
import {
  JJ_BOOKMARK_JSON_TEMPLATE,
  JJ_REVISION_JSON_TEMPLATE,
  isJjBookmarkRecord,
  isJjRevisionRecord,
  parseJjJsonLines,
  quoteJjSymbol,
  type JjBookmarkRecord,
  type JjRevisionRecord,
} from "@t3tools/shared/jjCli";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as VcsDriver from "./VcsDriver.ts";
import * as VcsDriverRegistry from "./VcsDriverRegistry.ts";

const METADATA_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const PATCH_MAX_OUTPUT_BYTES = 120_000;
const REMOTE_OPERATION_TIMEOUT_MS = 10 * 60_000;

export type VcsFetchStatus = "updated" | "up-to-date" | "needs-rebase" | "needs-resolution";

export interface VcsFetchResult {
  readonly status: VcsFetchStatus;
  readonly remoteName: string;
  readonly refName: string;
  readonly upstreamRef: string;
  readonly workspaceRevision: VcsRevision;
  readonly conflicts: ReadonlyArray<VcsConflict>;
}

export interface VcsPublishResult {
  readonly status: "pushed";
  readonly remoteName: string;
  readonly publishRef: VcsNamedRef;
}

export interface VcsRangeContext {
  readonly commitSummary: string;
  readonly diffSummary: string;
  readonly diffPatch: string;
}

export class VcsSyncService extends Context.Service<
  VcsSyncService,
  {
    readonly fetch: (input: {
      readonly cwd: string;
      readonly remoteName?: string;
    }) => Effect.Effect<VcsFetchResult, VcsWorkflowError>;
    readonly publish: (input: {
      readonly cwd: string;
      readonly publishRef: VcsNamedRef;
      readonly remoteName?: string;
    }) => Effect.Effect<VcsPublishResult, VcsWorkflowError>;
    readonly readRangeContext: (input: {
      readonly cwd: string;
      readonly baseRevision: string;
      readonly targetRevision: string;
    }) => Effect.Effect<VcsRangeContext, VcsWorkflowError>;
  }
>()("t3/vcs/VcsSyncService") {}

function syncError(input: {
  readonly operation: string;
  readonly detail: string;
  readonly recoverable?: boolean;
}): VcsWorkflowError {
  return new VcsWorkflowError({
    workflow: "sync",
    operation: input.operation,
    kind: "jj",
    detail: input.detail,
    recoverable: input.recoverable ?? false,
  });
}

function errorDetail(cause: unknown): string {
  return cause instanceof Error && cause.message.trim().length > 0 ? cause.message : String(cause);
}

function toRevision(record: JjRevisionRecord): VcsRevision {
  return { commitId: record.commitId, changeId: record.changeId };
}

function remoteBookmarkName(bookmark: Pick<JjBookmarkRecord, "name" | "remote">): string {
  return bookmark.remote ? `${bookmark.name}@${bookmark.remote}` : bookmark.name;
}

function bookmarkConflicts(bookmarks: ReadonlyArray<JjBookmarkRecord>): ReadonlyArray<VcsConflict> {
  return bookmarks
    .filter((bookmark) => bookmark.target.length > 1)
    .map((bookmark) => ({
      kind: "named-ref" as const,
      ref: {
        kind: "bookmark" as const,
        name: bookmark.name,
        ...(bookmark.remote ? { remoteName: bookmark.remote } : {}),
      },
    }));
}

const isVcsWorkflowError = Schema.is(VcsWorkflowError);

export const make = Effect.gen(function* () {
  const registry = yield* VcsDriverRegistry.VcsDriverRegistry;

  const resolveJjDriver = Effect.fn("VcsSyncService.resolveJjDriver")(function* (cwd: string) {
    const handle = yield* registry.resolve({ cwd });
    if (handle.kind !== "jj") {
      return yield* syncError({
        operation: "resolve-driver",
        detail: `Jujutsu synchronization requires a jj repository; detected ${handle.kind}.`,
      });
    }
    return handle.driver;
  });

  const readRevisions = Effect.fn("VcsSyncService.readRevisions")(function* (
    driver: VcsDriver.VcsDriver["Service"],
    cwd: string,
    revision: string,
  ) {
    const result = yield* driver.execute({
      operation: "VcsSyncService.readRevisions",
      cwd,
      args: ["log", "--no-graph", "--revisions", revision, "--template", JJ_REVISION_JSON_TEMPLATE],
      timeoutMs: 20_000,
      maxOutputBytes: METADATA_MAX_OUTPUT_BYTES,
      appendTruncationMarker: false,
    });
    if (result.stdoutTruncated) {
      return yield* syncError({
        operation: "read-revisions",
        detail: "jj returned truncated revision metadata.",
      });
    }
    const records = yield* Effect.try({
      try: () => parseJjJsonLines(result.stdout),
      catch: (cause) =>
        syncError({
          operation: "read-revisions",
          detail: `jj returned invalid revision metadata: ${errorDetail(cause)}`,
        }),
    });
    if (!records.every(isJjRevisionRecord)) {
      return yield* syncError({
        operation: "read-revisions",
        detail: "jj returned invalid revision metadata.",
      });
    }
    return records as ReadonlyArray<JjRevisionRecord>;
  });

  const readRevision = Effect.fn("VcsSyncService.readRevision")(function* (
    driver: VcsDriver.VcsDriver["Service"],
    cwd: string,
    revision: string,
  ) {
    const records = yield* readRevisions(driver, cwd, revision);
    const record = records[0];
    if (records.length !== 1 || !record) {
      return yield* syncError({
        operation: "read-revision",
        detail: `Expected one jj revision for ${revision}; received ${records.length}.`,
      });
    }
    return record;
  });

  const readBookmarks = Effect.fn("VcsSyncService.readBookmarks")(function* (
    driver: VcsDriver.VcsDriver["Service"],
    cwd: string,
  ) {
    const result = yield* driver.execute({
      operation: "VcsSyncService.readBookmarks",
      cwd,
      args: ["bookmark", "list", "--all-remotes", "--template", JJ_BOOKMARK_JSON_TEMPLATE],
      timeoutMs: 20_000,
      maxOutputBytes: METADATA_MAX_OUTPUT_BYTES,
      appendTruncationMarker: false,
    });
    if (result.stdoutTruncated) {
      return yield* syncError({
        operation: "read-bookmarks",
        detail: "jj returned truncated bookmark metadata.",
      });
    }
    const records = yield* Effect.try({
      try: () => parseJjJsonLines(result.stdout),
      catch: (cause) =>
        syncError({
          operation: "read-bookmarks",
          detail: `jj returned invalid bookmark metadata: ${errorDetail(cause)}`,
        }),
    });
    if (!records.every(isJjBookmarkRecord)) {
      return yield* syncError({
        operation: "read-bookmarks",
        detail: "jj returned invalid bookmark metadata.",
      });
    }
    return records as ReadonlyArray<JjBookmarkRecord>;
  });

  const resolveRemoteName = Effect.fn("VcsSyncService.resolveRemoteName")(function* (
    driver: VcsDriver.VcsDriver["Service"],
    cwd: string,
    requested?: string,
  ) {
    const trimmed = requested?.trim() ?? "";
    if (trimmed.includes("\0")) {
      return yield* syncError({
        operation: "resolve-remote",
        detail: "Remote name cannot contain NUL bytes.",
      });
    }
    if (trimmed.length > 0) return trimmed;
    const remoteName = yield* driver.resolveDefaultRemote(cwd);
    if (!remoteName) {
      return yield* syncError({
        operation: "resolve-remote",
        detail: "No Git remote is configured for this Jujutsu repository.",
      });
    }
    return remoteName;
  });

  const defaultRemoteBookmark = (
    bookmarks: ReadonlyArray<JjBookmarkRecord>,
    remoteName: string,
  ) => {
    const remoteBookmarks = bookmarks.filter((bookmark) => bookmark.remote === remoteName);
    return (
      remoteBookmarks.find((bookmark) => bookmark.name === "main") ??
      remoteBookmarks.find((bookmark) => bookmark.name === "master") ??
      remoteBookmarks.toSorted((left, right) => left.name.localeCompare(right.name))[0] ??
      null
    );
  };

  const isAncestor = Effect.fn("VcsSyncService.isAncestor")(function* (
    driver: VcsDriver.VcsDriver["Service"],
    cwd: string,
    ancestor: string,
    descendant: string,
  ) {
    if (ancestor === descendant) return true;
    const records = yield* readRevisions(
      driver,
      cwd,
      `${quoteJjSymbol(descendant)} & descendants(${quoteJjSymbol(ancestor)})`,
    );
    return records.length === 1 && records[0]?.commitId === descendant;
  });

  const fetch: VcsSyncService["Service"]["fetch"] = Effect.fn("VcsSyncService.fetch")(
    function* (input) {
      yield* Effect.annotateCurrentSpan({
        "vcs.kind": "jj",
        "vcs.workflow": "sync",
        "vcs.operation": "fetch",
      });
      const driver = yield* resolveJjDriver(input.cwd);
      const remoteName = yield* resolveRemoteName(driver, input.cwd, input.remoteName);
      yield* driver.execute({
        operation: "VcsSyncService.fetch.snapshot",
        cwd: input.cwd,
        args: ["util", "snapshot"],
        timeoutMs: 20_000,
        maxOutputBytes: 256 * 1024,
      });
      const [beforeRevision, beforeBookmarks] = yield* Effect.all([
        readRevision(driver, input.cwd, "@"),
        readBookmarks(driver, input.cwd),
      ]);
      const beforeDefault = defaultRemoteBookmark(beforeBookmarks, remoteName);

      yield* driver.execute({
        operation: "VcsSyncService.fetch",
        cwd: input.cwd,
        args: ["git", "fetch", "--remote", remoteName],
        timeoutMs: REMOTE_OPERATION_TIMEOUT_MS,
        maxOutputBytes: 1_000_000,
      });

      let afterRevision = yield* readRevision(driver, input.cwd, "@");
      const afterBookmarks = yield* readBookmarks(driver, input.cwd);
      const afterDefault = defaultRemoteBookmark(afterBookmarks, remoteName);
      const conflicts = bookmarkConflicts(afterBookmarks);
      const refName = afterDefault?.name ?? beforeDefault?.name ?? remoteName;
      const upstreamRef = afterDefault ? remoteBookmarkName(afterDefault) : remoteName;

      if (afterRevision.conflict || conflicts.length > 0) {
        return {
          status: "needs-resolution" as const,
          remoteName,
          refName,
          upstreamRef,
          workspaceRevision: toRevision(afterRevision),
          conflicts,
        };
      }

      const beforeTarget = beforeDefault?.target.length === 1 ? beforeDefault.target[0] : null;
      const afterTarget = afterDefault?.target.length === 1 ? afterDefault.target[0] : null;
      if (!beforeTarget || !afterTarget || beforeTarget === afterTarget) {
        return {
          status: "up-to-date" as const,
          remoteName,
          refName,
          upstreamRef,
          workspaceRevision: toRevision(afterRevision),
          conflicts,
        };
      }

      const basedOnFetchedTarget =
        beforeRevision.parents.length === 1 && beforeRevision.parents[0] === beforeTarget;
      if (!basedOnFetchedTarget) {
        return {
          status: "updated" as const,
          remoteName,
          refName,
          upstreamRef,
          workspaceRevision: toRevision(afterRevision),
          conflicts,
        };
      }

      const safelySuperseded = yield* isAncestor(driver, input.cwd, beforeTarget, afterTarget);
      if (!beforeRevision.empty || !safelySuperseded) {
        return {
          status: "needs-rebase" as const,
          remoteName,
          refName,
          upstreamRef,
          workspaceRevision: toRevision(afterRevision),
          conflicts,
        };
      }

      yield* driver.execute({
        operation: "VcsSyncService.fetch.advanceWorkspace",
        cwd: input.cwd,
        args: [
          "rebase",
          "--revisions",
          quoteJjSymbol(afterRevision.commitId),
          "--destination",
          quoteJjSymbol(afterTarget),
        ],
        timeoutMs: 60_000,
        maxOutputBytes: 1_000_000,
      });
      afterRevision = yield* readRevision(driver, input.cwd, "@");
      return {
        status: "updated" as const,
        remoteName,
        refName,
        upstreamRef,
        workspaceRevision: toRevision(afterRevision),
        conflicts,
      };
    },
    Effect.mapError((cause) =>
      isVcsWorkflowError(cause)
        ? cause
        : syncError({
            operation: "fetch",
            detail: errorDetail(cause),
            recoverable: true,
          }),
    ),
  );

  const publish: VcsSyncService["Service"]["publish"] = Effect.fn("VcsSyncService.publish")(
    function* (input) {
      yield* Effect.annotateCurrentSpan({
        "vcs.kind": "jj",
        "vcs.workflow": "sync",
        "vcs.operation": "publish",
      });
      if (input.publishRef.kind !== "bookmark") {
        return yield* syncError({
          operation: "publish",
          detail: "Jujutsu publishing requires an explicit bookmark.",
        });
      }
      const driver = yield* resolveJjDriver(input.cwd);
      const remoteName = yield* resolveRemoteName(driver, input.cwd, input.remoteName);
      const bookmarks = yield* readBookmarks(driver, input.cwd);
      const local = bookmarks.find(
        (bookmark) => bookmark.remote === undefined && bookmark.name === input.publishRef.name,
      );
      const targetCommit = local?.target.length === 1 ? local.target[0] : undefined;
      if (!targetCommit) {
        return yield* syncError({
          operation: "publish",
          detail: `Publish bookmark ${input.publishRef.name} is missing or conflicted.`,
        });
      }
      if (input.publishRef.target && input.publishRef.target.commitId !== targetCommit) {
        return yield* syncError({
          operation: "publish",
          detail: `Publish bookmark ${input.publishRef.name} moved since this action was prepared.`,
          recoverable: true,
        });
      }

      yield* driver.execute({
        operation: "VcsSyncService.publish",
        cwd: input.cwd,
        args: [
          "git",
          "push",
          "--remote",
          remoteName,
          "--bookmark",
          `exact:${input.publishRef.name}`,
        ],
        timeoutMs: REMOTE_OPERATION_TIMEOUT_MS,
        maxOutputBytes: 1_000_000,
      });

      const revision = yield* readRevision(driver, input.cwd, quoteJjSymbol(targetCommit));
      return {
        status: "pushed" as const,
        remoteName,
        publishRef: {
          kind: "bookmark" as const,
          name: input.publishRef.name,
          remoteName,
          target: toRevision(revision),
        },
      };
    },
    Effect.mapError((cause) =>
      isVcsWorkflowError(cause)
        ? cause
        : syncError({
            operation: "publish",
            detail: errorDetail(cause),
            recoverable: true,
          }),
    ),
  );

  const readRangeContext: VcsSyncService["Service"]["readRangeContext"] = Effect.fn(
    "VcsSyncService.readRangeContext",
  )(
    function* (input) {
      yield* Effect.annotateCurrentSpan({
        "vcs.kind": "jj",
        "vcs.workflow": "sync",
        "vcs.operation": "read-range-context",
      });
      const driver = yield* resolveJjDriver(input.cwd);
      const base = quoteJjSymbol(input.baseRevision);
      const target = quoteJjSymbol(input.targetRevision);
      const revisions = yield* readRevisions(driver, input.cwd, `${base}..${target}`);
      const patchResult = yield* driver.execute({
        operation: "VcsSyncService.readRangeContext.patch",
        cwd: input.cwd,
        args: ["diff", "--git", "--from", base, "--to", target],
        timeoutMs: 30_000,
        maxOutputBytes: PATCH_MAX_OUTPUT_BYTES,
        appendTruncationMarker: true,
      });
      const commitSummary = revisions
        .map((revision) =>
          `${revision.commitId.slice(0, 12)} ${revision.description.split("\n")[0] ?? ""}`.trim(),
        )
        .join("\n");
      return {
        commitSummary,
        diffSummary: `${revisions.length} change${revisions.length === 1 ? "" : "s"} from ${input.baseRevision.slice(0, 12)} to ${input.targetRevision.slice(0, 12)}`,
        diffPatch: patchResult.stdout,
      };
    },
    Effect.mapError((cause) =>
      isVcsWorkflowError(cause)
        ? cause
        : syncError({
            operation: "read-range-context",
            detail: errorDetail(cause),
            recoverable: true,
          }),
    ),
  );

  return VcsSyncService.of({ fetch, publish, readRangeContext });
});

export const layer = Layer.effect(VcsSyncService, make);
