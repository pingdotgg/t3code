import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

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
}

export interface VcsProcessSpawnFailure {
  readonly cause: unknown;
}

export interface VcsProcessStdinFailure {
  readonly cause: unknown;
}

export interface VcsProcessReadFailure {
  readonly stream: "stdout" | "stderr" | "exitCode";
  readonly cause: unknown;
}

export interface VcsProcessOutputLimitFailure {
  readonly stream: "stdout" | "stderr";
  readonly maxBytes: number;
}

export interface VcsProcessTimeoutFailure {
  readonly timeoutMs: number;
}

export class VcsProcessSpawnError extends Schema.TaggedErrorClass<VcsProcessSpawnError>()(
  "VcsProcessSpawnError",
  {
    operation: Schema.String,
    command: Schema.String,
    cwd: Schema.String,
    cause: Schema.Defect,
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
    exitCode: Schema.Number,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `VCS process failed in ${this.operation}: ${this.command} (${this.cwd}) exited with ${this.exitCode} - ${this.detail}`;
  }
}

export class VcsProcessTimeoutError extends Schema.TaggedErrorClass<VcsProcessTimeoutError>()(
  "VcsProcessTimeoutError",
  {
    operation: Schema.String,
    command: Schema.String,
    cwd: Schema.String,
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

export class VcsOutputDecodeError extends Schema.TaggedErrorClass<VcsOutputDecodeError>()(
  "VcsOutputDecodeError",
  {
    operation: Schema.String,
    command: Schema.String,
    cwd: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `VCS output decode failed in ${this.operation}: ${this.command} (${this.cwd}) - ${this.detail}`;
  }

  static fromProcessStdinError(context: VcsProcessErrorContext, error: VcsProcessStdinFailure) {
    return new VcsOutputDecodeError({
      ...context,
      detail: "failed to write process stdin",
      cause: error.cause,
    });
  }

  static fromProcessReadError(context: VcsProcessErrorContext, error: VcsProcessReadFailure) {
    return new VcsOutputDecodeError({
      ...context,
      detail:
        error.stream === "exitCode"
          ? "failed to read process exit code"
          : `failed to read process ${error.stream}`,
      cause: error.cause,
    });
  }

  static fromProcessOutputLimitError(
    context: VcsProcessErrorContext,
    error: VcsProcessOutputLimitFailure,
  ) {
    return new VcsOutputDecodeError({
      ...context,
      detail: `process ${error.stream} exceeded ${error.maxBytes} bytes`,
    });
  }

  static missingExitCode(context: VcsProcessErrorContext) {
    return new VcsOutputDecodeError({
      ...context,
      detail: "process completed without an exit code",
    });
  }
}

export class VcsRepositoryDetectionError extends Schema.TaggedErrorClass<VcsRepositoryDetectionError>()(
  "VcsRepositoryDetectionError",
  {
    operation: Schema.String,
    cwd: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
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
  VcsOutputDecodeError,
  VcsRepositoryDetectionError,
  VcsUnsupportedOperationError,
]);
export type VcsError = typeof VcsError.Type;
