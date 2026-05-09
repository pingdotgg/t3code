import * as Schema from "effect/Schema";

export interface CodexAppServerProtocolErrorShape {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export class CodexAppServerSpawnError extends Schema.TaggedErrorClass<CodexAppServerSpawnError>()(
  "CodexAppServerSpawnError",
  {
    command: Schema.optional(Schema.String),
    cause: Schema.Defect,
  },
) {
  override get message() {
    return this.command
      ? `Failed to spawn Codex App Server process for command: ${this.command}`
      : "Failed to spawn Codex App Server process";
  }
}

export class CodexAppServerProcessExitedError extends Schema.TaggedErrorClass<CodexAppServerProcessExitedError>()(
  "CodexAppServerProcessExitedError",
  {
    code: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message() {
    return this.code === undefined
      ? "Codex App Server process exited"
      : `Codex App Server process exited with code ${this.code}`;
  }
}

export class CodexAppServerProtocolParseError extends Schema.TaggedErrorClass<CodexAppServerProtocolParseError>()(
  "CodexAppServerProtocolParseError",
  {
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message() {
    return `Failed to parse Codex App Server protocol message: ${this.detail}`;
  }
}

export class CodexAppServerTransportError extends Schema.TaggedErrorClass<CodexAppServerTransportError>()(
  "CodexAppServerTransportError",
  {
    detail: Schema.String,
    cause: Schema.Defect,
  },
) {
  override get message() {
    return this.detail;
  }
}

export class CodexAppServerRequestError extends Schema.TaggedErrorClass<CodexAppServerRequestError>()(
  "CodexAppServerRequestError",
  {
    code: Schema.Number,
    errorMessage: Schema.String,
    data: Schema.optional(Schema.Unknown),
  },
) {
  override get message() {
    return this.errorMessage;
  }

  static fromProtocolError(error: CodexAppServerProtocolErrorShape) {
    return new CodexAppServerRequestError({
      code: error.code,
      errorMessage: error.message,
      ...(error.data !== undefined ? { data: error.data } : {}),
    });
  }

  static parseError(message = "Parse error", data?: unknown) {
    return new CodexAppServerRequestError({
      code: -32700,
      errorMessage: message,
      ...(data !== undefined ? { data } : {}),
    });
  }

  static invalidRequest(message = "Invalid request", data?: unknown) {
    return new CodexAppServerRequestError({
      code: -32600,
      errorMessage: message,
      ...(data !== undefined ? { data } : {}),
    });
  }

  static methodNotFound(method: string) {
    return new CodexAppServerRequestError({
      code: -32601,
      errorMessage: `Method not found: ${method}`,
    });
  }

  static invalidParams(message = "Invalid params", data?: unknown) {
    return new CodexAppServerRequestError({
      code: -32602,
      errorMessage: message,
      ...(data !== undefined ? { data } : {}),
    });
  }

  static internalError(message = "Internal error", data?: unknown) {
    return new CodexAppServerRequestError({
      code: -32603,
      errorMessage: message,
      ...(data !== undefined ? { data } : {}),
    });
  }

  static overloaded(message = "Server overloaded; retry later.", data?: unknown) {
    return new CodexAppServerRequestError({
      code: -32001,
      errorMessage: message,
      ...(data !== undefined ? { data } : {}),
    });
  }

  toProtocolError(): CodexAppServerProtocolErrorShape {
    return {
      code: this.code,
      message: this.errorMessage,
      ...(this.data !== undefined ? { data: this.data } : {}),
    };
  }
}

export const CodexAppServerError = Schema.Union([
  CodexAppServerRequestError,
  CodexAppServerSpawnError,
  CodexAppServerProcessExitedError,
  CodexAppServerProtocolParseError,
  CodexAppServerTransportError,
]);

export type CodexAppServerError = typeof CodexAppServerError.Type;
const isCodexAppServerRequestError = Schema.is(CodexAppServerRequestError);

export function normalizeToRequestError(error: CodexAppServerError): CodexAppServerRequestError {
  return isCodexAppServerRequestError(error)
    ? error
    : CodexAppServerRequestError.internalError(error.message);
}
