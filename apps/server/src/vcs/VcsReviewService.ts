import * as NodeCrypto from "node:crypto";

import { VcsWorkflowError, type ThreadId } from "@t3tools/contracts";
import {
  JJ_BOOKMARK_JSON_TEMPLATE,
  JJ_REVISION_JSON_TEMPLATE,
  JJ_WORKSPACE_JSON_TEMPLATE,
  isJjBookmarkRecord,
  isJjRevisionRecord,
  isJjWorkspaceRecord,
  parseJjJsonLines,
  quoteJjSymbol,
  type JjBookmarkRecord,
  type JjRevisionRecord,
  type JjWorkspaceRecord,
} from "@t3tools/shared/jjCli";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as VcsDriver from "./VcsDriver.ts";
import * as VcsDriverRegistry from "./VcsDriverRegistry.ts";

const METADATA_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const REMOTE_OPERATION_TIMEOUT_MS = 10 * 60_000;

export interface VcsPrepareReviewResult {
  readonly bookmarkName: string;
  readonly remoteName: string;
  readonly workspacePath: string | null;
}

export class VcsReviewService extends Context.Service<
  VcsReviewService,
  {
    readonly prepareReview: (input: {
      readonly cwd: string;
      readonly changeRequestNumber: number;
      readonly headRefName: string;
      readonly mode: "local" | "worktree";
      readonly threadId?: ThreadId;
      readonly remoteName?: string;
      readonly remoteUrl?: string;
    }) => Effect.Effect<VcsPrepareReviewResult, VcsWorkflowError>;
  }
>()("t3/vcs/VcsReviewService") {}

function reviewError(input: {
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

const isVcsWorkflowError = Schema.is(VcsWorkflowError);

export const make = Effect.gen(function* () {
  const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { worktreesDir } = yield* ServerConfig.ServerConfig;

  const resolveJjDriver = Effect.fn("VcsReviewService.resolveJjDriver")(function* (cwd: string) {
    const handle = yield* registry.resolve({ cwd });
    if (handle.kind !== "jj") {
      return yield* reviewError({
        operation: "resolve-driver",
        detail: `Jujutsu review preparation requires a jj repository; detected ${handle.kind}.`,
      });
    }
    return { driver: handle.driver, repositoryRoot: handle.repository.rootPath };
  });

  const readRecords = Effect.fn("VcsReviewService.readRecords")(function* <T>(input: {
    readonly driver: VcsDriver.VcsDriver["Service"];
    readonly cwd: string;
    readonly operation: string;
    readonly args: ReadonlyArray<string>;
    readonly label: string;
    readonly guard: (value: unknown) => value is T;
  }) {
    const result = yield* input.driver.execute({
      operation: input.operation,
      cwd: input.cwd,
      args: input.args,
      timeoutMs: 20_000,
      maxOutputBytes: METADATA_MAX_OUTPUT_BYTES,
      appendTruncationMarker: false,
    });
    if (result.stdoutTruncated) {
      return yield* reviewError({
        operation: input.operation,
        detail: `jj returned truncated ${input.label} metadata.`,
      });
    }
    const records = yield* Effect.try({
      try: () => parseJjJsonLines(result.stdout),
      catch: (cause) =>
        reviewError({
          operation: input.operation,
          detail: `jj returned invalid ${input.label} metadata: ${errorDetail(cause)}`,
        }),
    });
    if (!records.every(input.guard)) {
      return yield* reviewError({
        operation: input.operation,
        detail: `jj returned invalid ${input.label} metadata.`,
      });
    }
    return records as ReadonlyArray<T>;
  });

  const readRevision = Effect.fn("VcsReviewService.readRevision")(function* (
    driver: VcsDriver.VcsDriver["Service"],
    cwd: string,
    revision: string,
  ) {
    const records = yield* readRecords({
      driver,
      cwd,
      operation: "VcsReviewService.readRevision",
      args: ["log", "--no-graph", "--revisions", revision, "--template", JJ_REVISION_JSON_TEMPLATE],
      label: "revision",
      guard: isJjRevisionRecord,
    });
    if (records.length !== 1) {
      return yield* reviewError({
        operation: "read-revision",
        detail: `Expected one jj revision for ${revision}; received ${records.length}.`,
      });
    }
    return records[0] as JjRevisionRecord;
  });

  const readBookmarks = Effect.fn("VcsReviewService.readBookmarks")(function* (
    driver: VcsDriver.VcsDriver["Service"],
    cwd: string,
  ) {
    return yield* readRecords<JjBookmarkRecord>({
      driver,
      cwd,
      operation: "VcsReviewService.readBookmarks",
      args: ["bookmark", "list", "--all-remotes", "--template", JJ_BOOKMARK_JSON_TEMPLATE],
      label: "bookmark",
      guard: isJjBookmarkRecord,
    });
  });

  const readWorkspaces = Effect.fn("VcsReviewService.readWorkspaces")(function* (
    driver: VcsDriver.VcsDriver["Service"],
    cwd: string,
  ) {
    return yield* readRecords<JjWorkspaceRecord>({
      driver,
      cwd,
      operation: "VcsReviewService.readWorkspaces",
      args: ["workspace", "list", "--template", JJ_WORKSPACE_JSON_TEMPLATE],
      label: "workspace",
      guard: isJjWorkspaceRecord,
    });
  });

  const resolveRemoteName = Effect.fn("VcsReviewService.resolveRemoteName")(function* (
    driver: VcsDriver.VcsDriver["Service"],
    cwd: string,
    requested?: string,
  ) {
    const trimmed = requested?.trim() ?? "";
    if (trimmed.length > 0) return trimmed;
    const remoteName = yield* driver.resolveDefaultRemote(cwd);
    if (!remoteName) {
      return yield* reviewError({
        operation: "resolve-remote",
        detail: "No Git remote is configured for this Jujutsu repository.",
      });
    }
    return remoteName;
  });

  const prepareReview: VcsReviewService["Service"]["prepareReview"] = Effect.fn(
    "VcsReviewService.prepareReview",
  )(
    function* (input) {
      yield* Effect.annotateCurrentSpan({
        "vcs.kind": "jj",
        "vcs.workflow": "sync",
        "vcs.operation": "prepare-review",
      });
      const { driver, repositoryRoot } = yield* resolveJjDriver(input.cwd);
      const bookmarkName = `t3code-review-${input.changeRequestNumber}`;
      let remoteName = input.remoteName?.trim() ?? "";

      if (input.remoteUrl) {
        const remotes = yield* driver.listRemotes(input.cwd);
        const matchingRemote = remotes.remotes.find((remote) => remote.url === input.remoteUrl);
        if (matchingRemote) {
          remoteName = matchingRemote.name;
        } else {
          const preferredName = remoteName || bookmarkName;
          const collision = remotes.remotes.find((remote) => remote.name === preferredName);
          remoteName = collision
            ? `${preferredName}-${NodeCrypto.createHash("sha256").update(input.remoteUrl).digest("hex").slice(0, 8)}`
            : preferredName;
          yield* driver.addRemote({ cwd: input.cwd, name: remoteName, url: input.remoteUrl });
        }
      } else {
        remoteName = yield* resolveRemoteName(driver, input.cwd, remoteName || undefined);
      }

      yield* driver.execute({
        operation: "VcsReviewService.prepareReview.fetch",
        cwd: input.cwd,
        args: ["git", "fetch", "--remote", remoteName],
        timeoutMs: REMOTE_OPERATION_TIMEOUT_MS,
        maxOutputBytes: 1_000_000,
      });
      const bookmarks = yield* readBookmarks(driver, input.cwd);
      const remoteBookmark = bookmarks.find(
        (bookmark) => bookmark.remote === remoteName && bookmark.name === input.headRefName,
      );
      const target = remoteBookmark?.target.length === 1 ? remoteBookmark.target[0] : undefined;
      if (!target) {
        return yield* reviewError({
          operation: "prepare-review",
          detail: `Remote bookmark ${input.headRefName}@${remoteName} is missing or conflicted.`,
          recoverable: true,
        });
      }

      yield* driver.execute({
        operation: "VcsReviewService.prepareReview.bookmark",
        cwd: input.cwd,
        args: ["bookmark", "set", bookmarkName, "--revision", quoteJjSymbol(target)],
        timeoutMs: 20_000,
        maxOutputBytes: 256 * 1024,
      });

      if (input.mode === "local") {
        const current = yield* readRevision(driver, input.cwd, "@");
        if (!(current.empty && current.parents.length === 1 && current.parents[0] === target)) {
          yield* driver.execute({
            operation: "VcsReviewService.prepareReview.new",
            cwd: input.cwd,
            args: ["new", quoteJjSymbol(target)],
            timeoutMs: 20_000,
            maxOutputBytes: 256 * 1024,
          });
        }
        return { bookmarkName, remoteName, workspacePath: null };
      }

      if (!input.threadId) {
        return yield* reviewError({
          operation: "prepare-review",
          detail: "A thread id is required for an isolated Jujutsu workspace.",
        });
      }
      const workspaceName = `t3code-${NodeCrypto.createHash("sha256")
        .update(input.threadId, "utf8")
        .digest("hex")
        .slice(0, 20)}`;
      const workspacePath = path.join(worktreesDir, path.basename(repositoryRoot), workspaceName);
      if (yield* fileSystem.exists(workspacePath)) {
        const existing = yield* readRevision(driver, workspacePath, "@").pipe(Effect.option);
        if (existing._tag === "None") {
          return yield* reviewError({
            operation: "prepare-review",
            detail: `Refusing to replace invalid workspace path '${workspacePath}'.`,
            recoverable: true,
          });
        }
        return { bookmarkName, remoteName, workspacePath };
      }

      const workspaces = yield* readWorkspaces(driver, input.cwd);
      if (workspaces.some((workspace) => workspace.name === workspaceName)) {
        yield* driver.execute({
          operation: "VcsReviewService.prepareReview.forgetMissing",
          cwd: input.cwd,
          args: ["workspace", "forget", workspaceName],
          timeoutMs: 20_000,
          maxOutputBytes: 256 * 1024,
        });
      }
      yield* fileSystem.makeDirectory(path.dirname(workspacePath), { recursive: true });
      yield* driver.execute({
        operation: "VcsReviewService.prepareReview.workspace",
        cwd: input.cwd,
        args: [
          "workspace",
          "add",
          workspacePath,
          "--name",
          workspaceName,
          "--revision",
          quoteJjSymbol(target),
        ],
        timeoutMs: 120_000,
        maxOutputBytes: 1_000_000,
      });
      return { bookmarkName, remoteName, workspacePath };
    },
    Effect.mapError((cause) =>
      isVcsWorkflowError(cause)
        ? cause
        : reviewError({
            operation: "prepare-review",
            detail: errorDetail(cause),
            recoverable: true,
          }),
    ),
  );

  return VcsReviewService.of({ prepareReview });
});

export const layer = Layer.effect(VcsReviewService, make);
