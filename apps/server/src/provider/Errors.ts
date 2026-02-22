import { Schema } from "effect";

/**
 * CheckpointValidationError - Invalid checkpoint API input.
 */
export class CheckpointValidationError extends Schema.TaggedErrorClass<CheckpointValidationError>()(
  "CheckpointValidationError",
  {
    operation: Schema.String,
    issue: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Checkpoint validation failed in ${this.operation}: ${this.issue}`;
  }
}

/**
 * CheckpointGitCommandError - Git command execution failed in checkpoint store.
 */
export class CheckpointGitCommandError extends Schema.TaggedErrorClass<CheckpointGitCommandError>()(
  "CheckpointGitCommandError",
  {
    operation: Schema.String,
    command: Schema.String,
    cwd: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Checkpoint git command failed in ${this.operation}: ${this.command} (${this.cwd}) - ${this.detail}`;
  }
}

/**
 * CheckpointUnavailableError - Expected checkpoint does not exist.
 */
export class CheckpointUnavailableError extends Schema.TaggedErrorClass<CheckpointUnavailableError>()(
  "CheckpointUnavailableError",
  {
    threadId: Schema.String,
    turnCount: Schema.Number,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Checkpoint unavailable for thread ${this.threadId} turn ${this.turnCount}: ${this.detail}`;
  }
}

/**
 * CheckpointRepositoryError - Checkpointing unavailable for cwd/repository.
 */
export class CheckpointRepositoryError extends Schema.TaggedErrorClass<CheckpointRepositoryError>()(
  "CheckpointRepositoryError",
  {
    cwd: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Checkpoint repository error for ${this.cwd}: ${this.detail}`;
  }
}

/**
 * CodexValidationError - Invalid Codex API input.
 */
export class CodexValidationError extends Schema.TaggedErrorClass<CodexValidationError>()(
  "CodexValidationError",
  {
    operation: Schema.String,
    issue: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Codex validation failed in ${this.operation}: ${this.issue}`;
  }
}

/**
 * CodexSessionNotFoundError - Session id is unknown.
 */
export class CodexSessionNotFoundError extends Schema.TaggedErrorClass<CodexSessionNotFoundError>()(
  "CodexSessionNotFoundError",
  {
    sessionId: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Unknown codex session: ${this.sessionId}`;
  }
}

/**
 * CodexSessionClosedError - Session exists but is closed.
 */
export class CodexSessionClosedError extends Schema.TaggedErrorClass<CodexSessionClosedError>()(
  "CodexSessionClosedError",
  {
    sessionId: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Codex session is closed: ${this.sessionId}`;
  }
}

/**
 * CodexProtocolError - Invalid/unexpected JSON-RPC payload from app-server.
 */
export class CodexProtocolError extends Schema.TaggedErrorClass<CodexProtocolError>()(
  "CodexProtocolError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Codex protocol error in ${this.operation}: ${this.detail}`;
  }
}

/**
 * CodexRequestError - JSON-RPC request failed or timed out.
 */
export class CodexRequestError extends Schema.TaggedErrorClass<CodexRequestError>()(
  "CodexRequestError",
  {
    method: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Codex request failed for ${this.method}: ${this.detail}`;
  }
}

/**
 * CodexProcessError - codex app-server process lifecycle failure.
 */
export class CodexProcessError extends Schema.TaggedErrorClass<CodexProcessError>()(
  "CodexProcessError",
  {
    sessionId: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Codex process error for session ${this.sessionId}: ${this.detail}`;
  }
}

/**
 * ProviderValidationError - Invalid provider API input.
 */
export class ProviderValidationError extends Schema.TaggedErrorClass<ProviderValidationError>()(
  "ProviderValidationError",
  {
    operation: Schema.String,
    issue: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Provider validation failed in ${this.operation}: ${this.issue}`;
  }
}

/**
 * ProviderUnsupportedError - Requested provider is not implemented.
 */
export class ProviderUnsupportedError extends Schema.TaggedErrorClass<ProviderUnsupportedError>()(
  "ProviderUnsupportedError",
  {
    provider: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Provider '${this.provider}' is not implemented`;
  }
}

/**
 * ProviderSessionNotFoundError - Provider-facing session not found.
 */
export class ProviderSessionNotFoundError extends Schema.TaggedErrorClass<ProviderSessionNotFoundError>()(
  "ProviderSessionNotFoundError",
  {
    sessionId: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Unknown provider session: ${this.sessionId}`;
  }
}

/**
 * ProviderCheckpointUnavailableError - Checkpointing unavailable for this session.
 */
export class ProviderCheckpointUnavailableError extends Schema.TaggedErrorClass<ProviderCheckpointUnavailableError>()(
  "ProviderCheckpointUnavailableError",
  {
    sessionId: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Provider checkpoint unavailable for session ${this.sessionId}: ${this.detail}`;
  }
}

/**
 * ProviderCheckpointRangeError - Requested checkpoint range is invalid.
 */
export class ProviderCheckpointRangeError extends Schema.TaggedErrorClass<ProviderCheckpointRangeError>()(
  "ProviderCheckpointRangeError",
  {
    sessionId: Schema.String,
    fromTurnCount: Schema.Number,
    toTurnCount: Schema.Number,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Provider checkpoint range error for session ${this.sessionId}: ${this.fromTurnCount}..${this.toTurnCount} (${this.detail})`;
  }
}

/**
 * ProviderFilesystemError - Filesystem checkpoint capture/restore failure.
 */
export class ProviderFilesystemError extends Schema.TaggedErrorClass<ProviderFilesystemError>()(
  "ProviderFilesystemError",
  {
    sessionId: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Provider filesystem checkpoint error for session ${this.sessionId}: ${this.detail}`;
  }
}

export type CheckpointStoreError =
  | CheckpointValidationError
  | CheckpointGitCommandError
  | CheckpointUnavailableError
  | CheckpointRepositoryError;

export type CodexServiceError =
  | CodexValidationError
  | CodexSessionNotFoundError
  | CodexSessionClosedError
  | CodexProtocolError
  | CodexRequestError
  | CodexProcessError;

export type ProviderServiceError =
  | ProviderValidationError
  | ProviderUnsupportedError
  | ProviderSessionNotFoundError
  | ProviderCheckpointUnavailableError
  | ProviderCheckpointRangeError
  | ProviderFilesystemError
  | CodexServiceError
  | CheckpointStoreError;
