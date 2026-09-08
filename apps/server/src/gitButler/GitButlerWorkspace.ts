import type {
  GitButlerBranch,
  GitButlerCommit,
  GitButlerFileChange,
  GitButlerReviewStatus,
  GitButlerStack,
  GitButlerWorkspaceStatus,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GitButlerCli from "./GitButlerCli.ts";
import * as GitButlerProjectRegistry from "./GitButlerProjectRegistry.ts";

const GITBUTLER_STATUS_TIMEOUT_MS = 15_000;
const GITBUTLER_STATUS_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const NOT_CONFIGURED_DETAIL =
  "Open this repository in GitButler and configure its target branch before viewing its workspace here.";

const RawFileChange = Schema.Struct({
  filePath: Schema.String,
  changeType: Schema.String,
});

const RawCommit = Schema.Struct({
  commitId: Schema.String,
  createdAt: Schema.String,
  message: Schema.String,
  authorName: Schema.String,
  conflicted: Schema.NullOr(Schema.Boolean),
  reviewId: Schema.NullOr(Schema.String),
  changes: Schema.NullOr(Schema.Array(RawFileChange)),
});

const RawCi = Schema.Struct({
  status: Schema.String,
  conclusion: Schema.String,
});

const RawBranch = Schema.Struct({
  name: Schema.String,
  commits: Schema.Array(RawCommit),
  upstreamCommits: Schema.Array(RawCommit),
  branchStatus: Schema.String,
  reviewId: Schema.NullOr(Schema.String),
  ci: Schema.NullOr(RawCi),
});

const RawStack = Schema.Struct({
  cliId: Schema.String,
  assignedChanges: Schema.Array(RawFileChange),
  branches: Schema.Array(RawBranch),
});

const RawStatus = Schema.fromJsonString(
  Schema.Struct({
    uncommittedChanges: Schema.Array(RawFileChange),
    conflictedFiles: Schema.optionalKey(Schema.Array(Schema.String)),
    stacks: Schema.Array(RawStack),
    mergeBase: RawCommit,
    upstreamState: Schema.Struct({
      behind: Schema.Finite,
      lastFetched: Schema.NullOr(Schema.String),
    }),
  }),
);
const decodeRawStatus = Schema.decodeEffect(RawStatus);

type RawCommitValue = typeof RawCommit.Type;
type RawCiValue = typeof RawCi.Type;
type RawBranchValue = typeof RawBranch.Type;
type RawStackValue = typeof RawStack.Type;

const requiredText = (value: string, fallback: string) => value.trim() || fallback;
const nullableText = (value: string | null) => (value?.trim() ? value.trim() : null);
function toFileChange(change: typeof RawFileChange.Type): GitButlerFileChange | null {
  const filePath = change.filePath.trim();
  const changeType = change.changeType.trim();
  return filePath && changeType ? { filePath, changeType } : null;
}

const toFileChanges = (changes: ReadonlyArray<typeof RawFileChange.Type>) =>
  changes.flatMap((change) => {
    const mapped = toFileChange(change);
    return mapped === null ? [] : [mapped];
  });

function toCommit(commit: RawCommitValue): GitButlerCommit {
  return {
    commitId: requiredText(commit.commitId, "unknown"),
    createdAt: requiredText(commit.createdAt, "Unknown time"),
    message: requiredText(commit.message, "No commit message"),
    authorName: requiredText(commit.authorName, "Unknown author"),
    conflicted: commit.conflicted ?? false,
    reviewId: nullableText(commit.reviewId),
    changes: toFileChanges(commit.changes ?? []),
  };
}

function toReviewStatus(ci: RawCiValue | null): GitButlerReviewStatus | null {
  if (ci === null) return null;
  if (ci.status === "inProgress") return "pending";
  if (ci.conclusion === "success") return "passing";
  if (ci.conclusion === "failure") return "failing";
  return "unknown";
}

function toBranch(branch: RawBranchValue): GitButlerBranch {
  const reviewId = nullableText(branch.reviewId);
  const reviewNumber = reviewId === null ? Number.NaN : Number(/\d+/u.exec(reviewId)?.[0]);
  return {
    name: requiredText(branch.name, "Unnamed branch"),
    branchStatus: requiredText(branch.branchStatus, "unknown"),
    reviewId,
    reviewNumber: Number.isSafeInteger(reviewNumber) && reviewNumber > 0 ? reviewNumber : null,
    reviewStatus: toReviewStatus(branch.ci),
    commits: branch.commits.map(toCommit),
    upstreamCommits: branch.upstreamCommits.map(toCommit),
  };
}

function toStack(stack: RawStackValue): GitButlerStack {
  return {
    id: requiredText(stack.cliId, "unknown"),
    assignedChanges: toFileChanges(stack.assignedChanges),
    branches: stack.branches.map(toBranch),
  };
}

export class GitButlerWorkspace extends Context.Service<
  GitButlerWorkspace,
  {
    readonly read: (cwd: string) => Effect.Effect<GitButlerWorkspaceStatus>;
  }
>()("t3/gitButler/GitButlerWorkspace") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const processRunner = yield* VcsProcess.VcsProcess;
  const projectRegistry = yield* GitButlerProjectRegistry.GitButlerProjectRegistry;

  const read = Effect.fn("GitButlerWorkspace.read")(function* (cwd: string) {
    const versionResult = yield* GitButlerCli.readVersionOutput(
      processRunner,
      cwd,
      "gitbutler.workspace.version",
    ).pipe(
      Effect.map((output) => ({ status: "ok" as const, output })),
      Effect.catch((cause) =>
        Effect.succeed(
          cause._tag === "VcsProcessSpawnError"
            ? { status: "missing" as const }
            : { status: "error" as const },
        ),
      ),
    );

    if (versionResult.status === "missing") {
      return {
        status: "missing" as const,
        minimumVersion: GitButlerCli.MINIMUM_VERSION,
        installHint: "Install the GitButler CLI on this server and ensure `but` is on its PATH.",
      };
    }
    if (versionResult.status === "error") {
      return {
        status: "error" as const,
        detail: "The GitButler version check failed.",
      };
    }

    const compatibility = GitButlerCli.versionCompatibilityFromOutput(versionResult.output);
    if (compatibility.status === "incompatible") {
      return {
        status: "incompatible" as const,
        version: compatibility.version,
        minimumVersion: GitButlerCli.MINIMUM_VERSION,
        detail: compatibility.detail,
      };
    }
    const version = compatibility.version;

    const rootResult = yield* processRunner
      .run({
        operation: "gitbutler.workspace.root",
        command: "git",
        args: ["rev-parse", "--show-toplevel"],
        cwd,
        timeoutMs: 5_000,
        maxOutputBytes: 8_000,
      })
      .pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.orElseSucceed(() => ""),
      );
    if (!rootResult) {
      return {
        status: "notConfigured" as const,
        detail: "GitButler workspace details are only available for Git repositories.",
      };
    }

    const registrationStatus = yield* projectRegistry.registrationStatus(rootResult);
    if (registrationStatus === "error") {
      return {
        status: "error" as const,
        detail: "T3 Code could not read GitButler's local project registry.",
      };
    }
    if (registrationStatus === "unregistered") {
      return { status: "notConfigured" as const, detail: NOT_CONFIGURED_DETAIL };
    }

    const targetRef = yield* processRunner
      .run({
        operation: "gitbutler.workspace.target",
        command: "git",
        args: ["show-ref", "--verify", "--quiet", "refs/heads/gitbutler/target"],
        cwd: rootResult,
        allowNonZeroExit: true,
        timeoutMs: 5_000,
        maxOutputBytes: 8_000,
      })
      .pipe(
        Effect.map((result) => ({ status: "ok" as const, exitCode: result.exitCode })),
        Effect.orElseSucceed(() => ({ status: "error" as const })),
      );
    if (targetRef.status === "error") {
      return { status: "error" as const, detail: "T3 Code could not inspect this Git repository." };
    }
    if (targetRef.exitCode !== 0) {
      return { status: "notConfigured" as const, detail: NOT_CONFIGURED_DETAIL };
    }

    return yield* processRunner
      .run({
        operation: "gitbutler.workspace.status",
        command: "but",
        args: ["status", "-f", "--json"],
        cwd: rootResult,
        env: { NO_BG_TASKS: "1" },
        timeoutMs: GITBUTLER_STATUS_TIMEOUT_MS,
        maxOutputBytes: GITBUTLER_STATUS_MAX_OUTPUT_BYTES,
        outputMode: "error",
      })
      .pipe(
        Effect.flatMap((result) => decodeRawStatus(result.stdout)),
        Effect.map((status): GitButlerWorkspaceStatus => ({
          status: "ready",
          version,
          unassignedChanges: toFileChanges(status.uncommittedChanges),
          conflictedFiles: (status.conflictedFiles ?? [])
            .map((path) => path.trim())
            .filter(Boolean),
          stacks: status.stacks.map(toStack),
          mergeBaseCommitId: requiredText(status.mergeBase.commitId, "unknown"),
          upstreamBehind: Math.max(0, Math.trunc(status.upstreamState.behind)),
          upstreamLastFetched: nullableText(status.upstreamState.lastFetched),
        })),
        Effect.catch((cause) =>
          Effect.succeed({
            status: "error" as const,
            detail:
              cause._tag === "VcsProcessTimeoutError"
                ? "GitButler did not return workspace status before the timeout."
                : "GitButler returned workspace data that T3 Code could not read.",
          }),
        ),
      );
  });

  return GitButlerWorkspace.of({ read });
});

export const layer = Layer.effect(GitButlerWorkspace, make);
