import * as Schema from "effect/Schema";

/** JSON-RPC error codes used by vibe-app-server (string-valued enum on the wire). */
export const VibeErrorCode = Schema.Literals([
  "parse_error",
  "invalid_request",
  "method_not_found",
  "invalid_params",
  "internal_error",
  "not_initialized",
  "conflict",
  "unauthorized",
  "forbidden",
  "not_found",
  "server_error",
]);
export type VibeErrorCode = typeof VibeErrorCode.Type;

export class VibeAppServerRequestError extends Schema.TaggedError<VibeAppServerRequestError>()(
  "VibeAppServerRequestError",
  {
    method: Schema.String,
    code: Schema.String,
    detail: Schema.String,
    data: Schema.optional(Schema.Unknown),
  },
) {
  override get message(): string {
    return `${this.method} failed (${this.code}): ${this.detail}`;
  }
}

export class VibeAppServerProtocolError extends Schema.TaggedError<VibeAppServerProtocolError>()(
  "VibeAppServerProtocolError",
  {
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `vibe-app-server protocol error: ${this.detail}`;
  }
}

export class VibeAppServerTerminatedError extends Schema.TaggedError<VibeAppServerTerminatedError>()(
  "VibeAppServerTerminatedError",
  {
    exitCode: Schema.NullOr(Schema.Number),
    stderrTail: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `vibe-app-server exited (code ${this.exitCode ?? "unknown"}).`;
  }
}

export type VibeAppServerError =
  | VibeAppServerRequestError
  | VibeAppServerProtocolError
  | VibeAppServerTerminatedError;
