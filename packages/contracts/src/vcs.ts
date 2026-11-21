import * as Schema from "effect/Schema";
import { msg } from "gt-i18n";
import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { errorMessage } from "./errorMessage.ts";

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
  "rate-limited",
  "command-failed",
]);
export type VcsProcessExitFailureKind = typeof VcsProcessExitFailureKind.Type;

export interface VcsProcessExitFailure {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stderrTruncated: boolean;
}

export class VcsProcessSpawnError extends Schema.TaggedError<VcsProcessSpawnError>()(
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
    return errorMessage(
      msg("VCS process failed to spawn in {operation}: {command} ({cwd})", {
        operation: this.operation,
        command: this.command,
        cwd: this.cwd,
      }),
    );
  }

  static fromProcessSpawnError(context: VcsProcessErrorContext, error: VcsProcessSpawnFailure) {
    return new VcsProcessSpawnError({
      ...context,
      cause: error.cause,
    });
  }
}

export class VcsProcessExitError extends Schema.TaggedError<VcsProcessExitError>()(
  "VcsProcessExitError",
  {
    operation: Schema.String,
    command: Schema.String,
    cwd: Schema.String,
    argumentCount: Schema.optional(NonNegativeInt),
    exitCode: Schema.Number,
    detail: Schema.String,
    failureKind: Schema.optional(VcsProcessExitFailureKind),
    retryable: Schema.optional(Schema.Boolean),
    stderrLength: Schema.optional(NonNegativeInt),
    stderrTruncated: Schema.optional(Schema.Boolean),
  },
) {
  override get message(): string {
    return errorMessage(
      msg(
        "VCS process failed in {operation}: {command} ({cwd}) exited with {exitCode} - {detail}",
        {
          operation: this.operation,
          command: this.command,
          cwd: this.cwd,
          exitCode: this.exitCode,
          detail: this.detail,
        },
      ),
    );
  }

  static fromProcessExit(
    context: VcsProcessErrorContext,
    error: VcsProcessExitFailure,
    failureKind: VcsProcessExitFailureKind,
    options?: { readonly retryable?: boolean; readonly notFoundDetail?: string },
  ) {
    const detail =
      failureKind === "authentication"
        ? errorMessage(msg("Authentication failed."))
        : failureKind === "rate-limited"
          ? errorMessage(msg("API rate limit exceeded."))
          : failureKind === "not-found"
            ? (options?.notFoundDetail ?? errorMessage(msg("VCS resource not found.")))
            : errorMessage(msg("Process exited with a non-zero status."));

    return new VcsProcessExitError({
      ...context,
      exitCode: error.exitCode,
      detail,
      failureKind,
      ...(options?.retryable === true ? { retryable: true } : {}),
      stderrLength: error.stderr.length,
      stderrTruncated: error.stderrTruncated,
    });
  }
}

export class VcsProcessTimeoutError extends Schema.TaggedError<VcsProcessTimeoutError>()(
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
    return errorMessage(
      msg("VCS process timed out in {operation}: {command} ({cwd}) after {timeoutMs}ms", {
        operation: this.operation,
        command: this.command,
        cwd: this.cwd,
        timeoutMs: this.timeoutMs,
      }),
    );
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

export class VcsProcessStdinWriteError extends Schema.TaggedError<VcsProcessStdinWriteError>()(
  "VcsProcessStdinWriteError",
  {
    ...VcsProcessBoundaryErrorFields,
    stdinBytes: NonNegativeInt,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return errorMessage(
      msg(
        "VCS process failed to write {stdinBytes} bytes to stdin in {operation}: {command} ({cwd})",
        {
          stdinBytes: this.stdinBytes,
          operation: this.operation,
          command: this.command,
          cwd: this.cwd,
        },
      ),
    );
  }
}

export class VcsProcessOutputReadError extends Schema.TaggedError<VcsProcessOutputReadError>()(
  "VcsProcessOutputReadError",
  {
    ...VcsProcessBoundaryErrorFields,
    stream: Schema.Literals(["stdout", "stderr", "exitCode"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return errorMessage(
      msg("VCS process failed to read {stream} in {operation}: {command} ({cwd})", {
        stream: this.stream,
        operation: this.operation,
        command: this.command,
        cwd: this.cwd,
      }),
    );
  }
}

export class VcsProcessOutputLimitError extends Schema.TaggedError<VcsProcessOutputLimitError>()(
  "VcsProcessOutputLimitError",
  {
    ...VcsProcessBoundaryErrorFields,
    stream: Schema.Literals(["stdout", "stderr"]),
    maxBytes: NonNegativeInt,
    observedBytes: NonNegativeInt,
  },
) {
  override get message(): string {
    return errorMessage(
      msg(
        "VCS process {stream} produced {observedBytes} bytes in {operation}: {command} ({cwd}), exceeding the {maxBytes} byte limit",
        {
          stream: this.stream,
          observedBytes: this.observedBytes,
          operation: this.operation,
          command: this.command,
          cwd: this.cwd,
          maxBytes: this.maxBytes,
        },
      ),
    );
  }
}

export class VcsProcessMissingExitCodeError extends Schema.TaggedError<VcsProcessMissingExitCodeError>()(
  "VcsProcessMissingExitCodeError",
  VcsProcessBoundaryErrorFields,
) {
  override get message(): string {
    return errorMessage(
      msg("VCS process completed without an exit code in {operation}: {command} ({cwd})", {
        operation: this.operation,
        command: this.command,
        cwd: this.cwd,
      }),
    );
  }
}

export class VcsRepositoryDetectionError extends Schema.TaggedError<VcsRepositoryDetectionError>()(
  "VcsRepositoryDetectionError",
  {
    operation: Schema.String,
    cwd: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return errorMessage(
      msg("VCS repository detection failed in {operation}: {cwd} - {detail}", {
        operation: this.operation,
        cwd: this.cwd,
        detail: this.detail,
      }),
    );
  }
}

export class VcsUnsupportedOperationError extends Schema.TaggedError<VcsUnsupportedOperationError>()(
  "VcsUnsupportedOperationError",
  {
    operation: Schema.String,
    kind: VcsDriverKind,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return errorMessage(
      msg("VCS operation is unsupported for {kind} in {operation}: {detail}", {
        kind: this.kind,
        operation: this.operation,
        detail: this.detail,
      }),
    );
  }
}

export class VcsCheckpointStorageError extends Schema.TaggedError<VcsCheckpointStorageError>()(
  "VcsCheckpointStorageError",
  {
    operation: Schema.String,
    cwd: Schema.String,
    stage: Schema.Literals(["isolate", "publish"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return this.stage === "isolate"
      ? errorMessage(msg("Could not isolate checkpoint objects."))
      : errorMessage(msg("Could not publish checkpoint objects."));
  }
}

export const VcsError = Schema.Union([
  VcsCheckpointStorageError,
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
