import { Schema } from "effect";

import type { CheckpointServiceError } from "../checkpointing/Errors.ts";

/**
 * ProviderAdapterValidationError - Invalid adapter API input.
 */
export class ProviderAdapterValidationError extends Schema.TaggedErrorClass<ProviderAdapterValidationError>()(
  "ProviderAdapterValidationError",
  {
    provider: Schema.String,
    operation: Schema.String,
    issue: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Provider adapter validation failed (${this.provider}) in ${this.operation}: ${this.issue}`;
  }
}

/**
 * ProviderAdapterSessionNotFoundError - Adapter-owned session id is unknown.
 */
export class ProviderAdapterSessionNotFoundError extends Schema.TaggedErrorClass<ProviderAdapterSessionNotFoundError>()(
  "ProviderAdapterSessionNotFoundError",
  {
    provider: Schema.String,
    sessionId: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Unknown ${this.provider} adapter session: ${this.sessionId}`;
  }
}

/**
 * ProviderAdapterSessionClosedError - Adapter session exists but is closed.
 */
export class ProviderAdapterSessionClosedError extends Schema.TaggedErrorClass<ProviderAdapterSessionClosedError>()(
  "ProviderAdapterSessionClosedError",
  {
    provider: Schema.String,
    sessionId: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `${this.provider} adapter session is closed: ${this.sessionId}`;
  }
}

/**
 * ProviderAdapterProtocolError - Invalid/unexpected provider protocol payload.
 */
export class ProviderAdapterProtocolError extends Schema.TaggedErrorClass<ProviderAdapterProtocolError>()(
  "ProviderAdapterProtocolError",
  {
    provider: Schema.String,
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Provider adapter protocol error (${this.provider}) in ${this.operation}: ${this.detail}`;
  }
}

/**
 * ProviderAdapterRequestError - Provider protocol request failed or timed out.
 */
export class ProviderAdapterRequestError extends Schema.TaggedErrorClass<ProviderAdapterRequestError>()(
  "ProviderAdapterRequestError",
  {
    provider: Schema.String,
    method: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Provider adapter request failed (${this.provider}) for ${this.method}: ${this.detail}`;
  }
}

/**
 * ProviderAdapterProcessError - Provider process lifecycle failure.
 */
export class ProviderAdapterProcessError extends Schema.TaggedErrorClass<ProviderAdapterProcessError>()(
  "ProviderAdapterProcessError",
  {
    provider: Schema.String,
    sessionId: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Provider adapter process error (${this.provider}) for session ${this.sessionId}: ${this.detail}`;
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
 * ProviderSessionDirectoryPersistenceError - Session directory persistence failure.
 */
export class ProviderSessionDirectoryPersistenceError extends Schema.TaggedErrorClass<ProviderSessionDirectoryPersistenceError>()(
  "ProviderSessionDirectoryPersistenceError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Provider session directory persistence error in ${this.operation}: ${this.detail}`;
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

export type ProviderAdapterError =
  | ProviderAdapterValidationError
  | ProviderAdapterSessionNotFoundError
  | ProviderAdapterSessionClosedError
  | ProviderAdapterProtocolError
  | ProviderAdapterRequestError
  | ProviderAdapterProcessError;

export type ProviderServiceError =
  | ProviderValidationError
  | ProviderUnsupportedError
  | ProviderSessionNotFoundError
  | ProviderSessionDirectoryPersistenceError
  | ProviderCheckpointUnavailableError
  | ProviderCheckpointRangeError
  | ProviderFilesystemError
  | ProviderAdapterError
  | CheckpointServiceError;
