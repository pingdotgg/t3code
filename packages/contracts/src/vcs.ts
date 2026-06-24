import * as Schema from "effect/Schema";
import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const VcsDriverKind = Schema.Literals(["git", "jj", "unknown"]);
export type VcsDriverKind = typeof VcsDriverKind.Type;

export const VcsFreshnessSource = Schema.Literals([
  "live-local",
  "cached-local",
  "cached-remote",
  "explicit-remote",
]);
export type VcsFreshnessSource = typeof VcsFreshnessSource.Type;

export const VcsFreshness = Schema.Struct({
  source: VcsFreshnessSource,
  observedAt: Schema.DateTimeUtc,
  expiresAt: Schema.Option(Schema.DateTimeUtc),
});
export type VcsFreshness = typeof VcsFreshness.Type;

export const VcsDriverCapabilities = Schema.Struct({
  kind: VcsDriverKind,
  supportsWorktrees: Schema.Boolean,
  supportsBookmarks: Schema.Boolean,
  supportsAtomicSnapshot: Schema.Boolean,
  supportsPushDefaultRemote: Schema.Boolean,
  ignoreClassifier: Schema.Literals(["native", "git-compatible-fallback"]),
});
export type VcsDriverCapabilities = typeof VcsDriverCapabilities.Type;

export const VcsRepositoryIdentity = Schema.Struct({
  kind: VcsDriverKind,
  rootPath: TrimmedNonEmptyString,
  metadataPath: Schema.NullOr(TrimmedNonEmptyString),
  freshness: VcsFreshness,
});
export type VcsRepositoryIdentity = typeof VcsRepositoryIdentity.Type;

export const VcsListWorkspaceFilesResult = Schema.Struct({
  paths: Schema.Array(TrimmedNonEmptyString),
  truncated: Schema.Boolean,
  freshness: VcsFreshness,
});
export type VcsListWorkspaceFilesResult = typeof VcsListWorkspaceFilesResult.Type;

export const VcsRemote = Schema.Struct({
  name: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  pushUrl: Schema.Option(TrimmedNonEmptyString),
  isPrimary: Schema.Boolean,
});
export type VcsRemote = typeof VcsRemote.Type;

export const VcsListRemotesResult = Schema.Struct({
  remotes: Schema.Array(VcsRemote),
  freshness: VcsFreshness,
});
export type VcsListRemotesResult = typeof VcsListRemotesResult.Type;

export const VcsListRemoteBranchesResult = Schema.Struct({
  branches: Schema.Array(TrimmedNonEmptyString),
  defaultBranch: Schema.NullOr(TrimmedNonEmptyString),
  freshness: VcsFreshness,
});
export type VcsListRemoteBranchesResult = typeof VcsListRemoteBranchesResult.Type;

export interface VcsProcessErrorContext {
  readonly operation: string;
  readonly command: string;
  readonly cwd: string;
  readonly argumentCount?: number;
}

export interface VcsProcessSpawnFailure {
  readonly cause: unknown;
}

export interface VcsProcessTimeoutFailure {
  readonly timeoutMs: number;
}

export const VcsProcessExitFailureKind = Schema.Literals([
  "authentication",
  "not-found",
  "command-failed",
]);
export type VcsProcessExitFailureKind = typeof VcsProcessExitFailureKind.Type;

export interface VcsProcessExitFailure {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stderrTruncated: boolean;
}

export class VcsProcessSpawnError extends Schema.TaggedErrorClass<VcsProcessSpawnError>()(
  "VcsProcessSpawnError",
  {
    operation: Schema.String,
    command: Schema.String,
    cwd: Schema.String,
    argumentCount: Schema.optional(NonNegativeInt),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `VCS process failed to spawn in ${this.operation}: ${this.command} (${this.cwd})`;
  }

  static fromProcessSpawnError(context: VcsProcessErrorContext, error: VcsProcessSpawnFailure) {
    return new VcsProcessSpawnError({
      ...context,
      cause: error.cause,
    });
  }
}

export class VcsProcessExitError extends Schema.TaggedErrorClass<VcsProcessExitError>()(
  "VcsProcessExitError",
  {
    operation: Schema.String,
    command: Schema.String,
    cwd: Schema.String,
    argumentCount: Schema.optional(NonNegativeInt),
    exitCode: Schema.Number,
    detail: Schema.String,
    failureKind: Schema.optional(VcsProcessExitFailureKind),
    stderrLength: Schema.optional(NonNegativeInt),
    stderrTruncated: Schema.optional(Schema.Boolean),
  },
) {
  override get message(): string {
    return `VCS process failed in ${this.operation}: ${this.command} (${this.cwd}) exited with ${this.exitCode} - ${this.detail}`;
  }

  static fromProcessExit(
    context: VcsProcessErrorContext,
    error: VcsProcessExitFailure,
    failureKind: VcsProcessExitFailureKind,
  ) {
    const detail =
      failureKind === "authentication"
        ? "Authentication failed."
        : failureKind === "not-found"
          ? context.command === "glab"
            ? "Merge request not found."
            : context.command === "gh" || context.command === "az"
              ? "Pull request not found."
              : "VCS resource not found."
          : "Process exited with a non-zero status.";

    return new VcsProcessExitError({
      ...context,
      exitCode: error.exitCode,
      detail,
      failureKind,
      stderrLength: error.stderr.length,
      stderrTruncated: error.stderrTruncated,
    });
  }
}

export class VcsProcessTimeoutError extends Schema.TaggedErrorClass<VcsProcessTimeoutError>()(
  "VcsProcessTimeoutError",
  {
    operation: Schema.String,
    command: Schema.String,
    cwd: Schema.String,
    argumentCount: Schema.optional(NonNegativeInt),
    timeoutMs: Schema.Number,
  },
) {
  override get message(): string {
    return `VCS process timed out in ${this.operation}: ${this.command} (${this.cwd}) after ${this.timeoutMs}ms`;
  }

  static fromProcessTimeoutError(context: VcsProcessErrorContext, error: VcsProcessTimeoutFailure) {
    return new VcsProcessTimeoutError({
      ...context,
      timeoutMs: error.timeoutMs,
    });
  }
}

const VcsProcessBoundaryErrorFields = {
  operation: Schema.String,
  command: Schema.String,
  cwd: Schema.String,
  argumentCount: Schema.optional(NonNegativeInt),
};

export class VcsProcessStdinWriteError extends Schema.TaggedErrorClass<VcsProcessStdinWriteError>()(
  "VcsProcessStdinWriteError",
  {
    ...VcsProcessBoundaryErrorFields,
    stdinBytes: NonNegativeInt,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `VCS process failed to write ${this.stdinBytes} bytes to stdin in ${this.operation}: ${this.command} (${this.cwd})`;
  }
}

export class VcsProcessOutputReadError extends Schema.TaggedErrorClass<VcsProcessOutputReadError>()(
  "VcsProcessOutputReadError",
  {
    ...VcsProcessBoundaryErrorFields,
    stream: Schema.Literals(["stdout", "stderr", "exitCode"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `VCS process failed to read ${this.stream} in ${this.operation}: ${this.command} (${this.cwd})`;
  }
}

export class VcsProcessOutputLimitError extends Schema.TaggedErrorClass<VcsProcessOutputLimitError>()(
  "VcsProcessOutputLimitError",
  {
    ...VcsProcessBoundaryErrorFields,
    stream: Schema.Literals(["stdout", "stderr"]),
    maxBytes: NonNegativeInt,
    observedBytes: NonNegativeInt,
  },
) {
  override get message(): string {
    return `VCS process ${this.stream} produced ${this.observedBytes} bytes in ${this.operation}: ${this.command} (${this.cwd}), exceeding the ${this.maxBytes} byte limit`;
  }
}

export class VcsProcessMissingExitCodeError extends Schema.TaggedErrorClass<VcsProcessMissingExitCodeError>()(
  "VcsProcessMissingExitCodeError",
  VcsProcessBoundaryErrorFields,
) {
  override get message(): string {
    return `VCS process completed without an exit code in ${this.operation}: ${this.command} (${this.cwd})`;
  }
}

export const VcsOutputDecodeError = Schema.Union([
  VcsProcessStdinWriteError,
  VcsProcessOutputReadError,
  VcsProcessOutputLimitError,
  VcsProcessMissingExitCodeError,
]);
export type VcsOutputDecodeError = typeof VcsOutputDecodeError.Type;

export class VcsRepositoryDetectionError extends Schema.TaggedErrorClass<VcsRepositoryDetectionError>()(
  "VcsRepositoryDetectionError",
  {
    operation: Schema.String,
    cwd: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `VCS repository detection failed in ${this.operation}: ${this.cwd} - ${this.detail}`;
  }
}

export class VcsUnsupportedOperationError extends Schema.TaggedErrorClass<VcsUnsupportedOperationError>()(
  "VcsUnsupportedOperationError",
  {
    operation: Schema.String,
    kind: VcsDriverKind,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `VCS operation is unsupported for ${this.kind} in ${this.operation}: ${this.detail}`;
  }
}

export const VcsError = Schema.Union([
  VcsProcessSpawnError,
  VcsProcessExitError,
  VcsProcessTimeoutError,
  VcsProcessStdinWriteError,
  VcsProcessOutputReadError,
  VcsProcessOutputLimitError,
  VcsProcessMissingExitCodeError,
  VcsRepositoryDetectionError,
  VcsUnsupportedOperationError,
]);
export type VcsError = typeof VcsError.Type;
