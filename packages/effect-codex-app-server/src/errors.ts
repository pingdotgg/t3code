import * as Schema from "effect/Schema";
import type * as SchemaIssue from "effect/SchemaIssue";

export const CodexAppServerRequestOperation = Schema.Literals([
  "decode-payload",
  "encode-payload",
  "handle-request",
  "receive-response",
]);
export type CodexAppServerRequestOperation = typeof CodexAppServerRequestOperation.Type;

export const CodexAppServerSchemaIssueKind = Schema.Literals([
  "Filter",
  "Encoding",
  "Pointer",
  "Composite",
  "AnyOf",
  "InvalidType",
  "InvalidValue",
  "MissingKey",
  "UnexpectedKey",
  "Forbidden",
  "OneOf",
]);
export type CodexAppServerSchemaIssueKind = typeof CodexAppServerSchemaIssueKind.Type;

export interface CodexAppServerSchemaIssueDiagnostics {
  readonly issueCount: number;
  readonly issueKinds: ReadonlyArray<CodexAppServerSchemaIssueKind>;
  readonly maximumPathDepth: number;
}

const schemaIssueDiagnostics = (root: SchemaIssue.Issue): CodexAppServerSchemaIssueDiagnostics => {
  let issueCount = 0;
  let maximumPathDepth = 0;
  const issueKinds = new Set<CodexAppServerSchemaIssueKind>();

  const visit = (issue: SchemaIssue.Issue, pathDepth: number): void => {
    issueCount += 1;
    issueKinds.add(issue._tag);
    maximumPathDepth = Math.max(maximumPathDepth, pathDepth);
    switch (issue._tag) {
      case "Filter":
      case "Encoding":
        visit(issue.issue, pathDepth);
        break;
      case "Pointer":
        visit(issue.issue, pathDepth + issue.path.length);
        break;
      case "Composite":
      case "AnyOf":
        for (const child of issue.issues) visit(child, pathDepth);
        break;
    }
  };

  visit(root, 0);
  return {
    issueCount,
    issueKinds: [...issueKinds],
    maximumPathDepth,
  };
};

export const CodexAppServerPayloadKind = Schema.Literals([
  "null",
  "array",
  "string",
  "number",
  "boolean",
  "bigint",
  "object",
  "symbol",
  "function",
  "undefined",
]);
export type CodexAppServerPayloadKind = typeof CodexAppServerPayloadKind.Type;

const payloadKind = (payload: unknown): CodexAppServerPayloadKind => {
  if (payload === null) return "null";
  if (Array.isArray(payload)) return "array";
  return typeof payload;
};

const protocolMessageFields = ["id", "method", "params", "result", "error"] as const;

export const CodexAppServerProtocolMessageField = Schema.Literals(protocolMessageFields);
export type CodexAppServerProtocolMessageField = typeof CodexAppServerProtocolMessageField.Type;

export interface CodexAppServerRequestDiagnostics {
  readonly method?: string;
  readonly requestId?: string;
  readonly operation?: CodexAppServerRequestOperation;
  readonly cause?: unknown;
  readonly issueCount?: number;
  readonly issueKinds?: ReadonlyArray<CodexAppServerSchemaIssueKind>;
  readonly maximumPathDepth?: number;
  readonly payloadKind?: CodexAppServerPayloadKind;
}

export const CodexAppServerProtocolParseOperation = Schema.Literals([
  "encode-wire-message",
  "decode-wire-message",
  "route-wire-message",
  "decode-notification-payload",
  "decode-request-payload",
  "decode-response-payload",
]);
export type CodexAppServerProtocolParseOperation = typeof CodexAppServerProtocolParseOperation.Type;

export const CodexAppServerTransportOperation = Schema.Literals([
  "read-input-stream",
  "read-process-exit-status",
]);
export type CodexAppServerTransportOperation = typeof CodexAppServerTransportOperation.Type;

export const CodexAppServerIdentifierPurpose = Schema.Literals([
  "provider-event",
  "command-approval-request",
  "file-change-approval-request",
  "user-input-request",
]);
export type CodexAppServerIdentifierPurpose = typeof CodexAppServerIdentifierPurpose.Type;

export interface CodexAppServerProtocolErrorShape {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export class CodexAppServerSpawnError extends Schema.TaggedErrorClass<CodexAppServerSpawnError>()(
  "CodexAppServerSpawnError",
  {
    command: Schema.optional(Schema.String),
    cause: Schema.Defect(),
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
    pid: Schema.optionalKey(Schema.Int),
    cause: Schema.optional(Schema.Defect()),
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
    operation: CodexAppServerProtocolParseOperation,
    method: Schema.optionalKey(Schema.String),
    requestId: Schema.optionalKey(Schema.String),
    payloadKind: Schema.optionalKey(CodexAppServerPayloadKind),
    presentFields: Schema.optionalKey(Schema.Array(CodexAppServerProtocolMessageField)),
    issueCount: Schema.optionalKey(Schema.Number),
    issueKinds: Schema.optionalKey(Schema.Array(CodexAppServerSchemaIssueKind)),
    maximumPathDepth: Schema.optionalKey(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    const method = this.method === undefined ? "" : ` for method '${this.method}'`;
    return `Codex App Server protocol operation '${this.operation}' failed${method}.`;
  }

  static fromSchemaError(
    operation: CodexAppServerProtocolParseOperation,
    cause: Schema.SchemaError,
    context: { readonly method?: string; readonly requestId?: string } = {},
  ) {
    return new CodexAppServerProtocolParseError({
      operation,
      ...context,
      ...schemaIssueDiagnostics(cause.issue),
      cause,
    });
  }

  static fromRequestError(
    operation: CodexAppServerProtocolParseOperation,
    method: string,
    cause: CodexAppServerRequestError,
  ) {
    return new CodexAppServerProtocolParseError({
      operation,
      method,
      ...(cause.issueCount === undefined ? {} : { issueCount: cause.issueCount }),
      ...(cause.issueKinds === undefined ? {} : { issueKinds: cause.issueKinds }),
      ...(cause.maximumPathDepth === undefined ? {} : { maximumPathDepth: cause.maximumPathDepth }),
      cause,
    });
  }

  static fromUnroutableMessage(message: unknown) {
    const diagnostics = { payloadKind: payloadKind(message) };
    if (typeof message !== "object" || message === null || Array.isArray(message)) {
      return new CodexAppServerProtocolParseError({
        operation: "route-wire-message",
        ...diagnostics,
      });
    }

    const presentFields = protocolMessageFields.filter((field) => field in message);
    const method =
      "method" in message && typeof message.method === "string" ? message.method : undefined;
    const requestId =
      "id" in message && (typeof message.id === "string" || typeof message.id === "number")
        ? String(message.id)
        : undefined;
    return new CodexAppServerProtocolParseError({
      operation: "route-wire-message",
      ...diagnostics,
      presentFields,
      ...(method === undefined ? {} : { method }),
      ...(requestId === undefined ? {} : { requestId }),
    });
  }
}

export class CodexAppServerTransportError extends Schema.TaggedErrorClass<CodexAppServerTransportError>()(
  "CodexAppServerTransportError",
  {
    operation: CodexAppServerTransportOperation,
    pid: Schema.optionalKey(Schema.Int),
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return `Codex App Server transport operation '${this.operation}' failed.`;
  }
}

export class CodexAppServerIdentifierGenerationError extends Schema.TaggedErrorClass<CodexAppServerIdentifierGenerationError>()(
  "CodexAppServerIdentifierGenerationError",
  {
    purpose: CodexAppServerIdentifierPurpose,
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return `Failed to generate Codex App Server identifier for ${this.purpose}.`;
  }
}

export class CodexAppServerInputStreamEndedError extends Schema.TaggedErrorClass<CodexAppServerInputStreamEndedError>()(
  "CodexAppServerInputStreamEndedError",
  {},
) {
  override get message() {
    return "Codex App Server input stream ended.";
  }
}

export class CodexAppServerRequestError extends Schema.TaggedErrorClass<CodexAppServerRequestError>()(
  "CodexAppServerRequestError",
  {
    code: Schema.Number,
    errorMessage: Schema.String,
    data: Schema.optional(Schema.Unknown),
    method: Schema.optionalKey(Schema.String),
    requestId: Schema.optionalKey(Schema.String),
    operation: Schema.optionalKey(CodexAppServerRequestOperation),
    issueCount: Schema.optionalKey(Schema.Number),
    issueKinds: Schema.optionalKey(Schema.Array(CodexAppServerSchemaIssueKind)),
    maximumPathDepth: Schema.optionalKey(Schema.Number),
    payloadKind: Schema.optionalKey(CodexAppServerPayloadKind),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message() {
    return this.errorMessage;
  }

  static fromProtocolError(
    error: CodexAppServerProtocolErrorShape,
    method: string,
    requestId: string,
  ) {
    return new CodexAppServerRequestError({
      code: error.code,
      errorMessage: error.message,
      ...(error.data !== undefined ? { data: error.data } : {}),
      method,
      requestId,
      operation: "receive-response",
      cause: error,
    });
  }

  static fromAppServerError(error: CodexAppServerError, method: string) {
    if (error._tag === "CodexAppServerRequestError") {
      return error;
    }
    return CodexAppServerRequestError.internalError(
      `Codex App Server request handler failed for method '${method}'`,
      undefined,
      {
        method,
        operation: "handle-request",
        cause: error,
      },
    );
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

  static invalidParams(
    message = "Invalid params",
    data?: unknown,
    diagnostics: CodexAppServerRequestDiagnostics = {},
  ) {
    return new CodexAppServerRequestError({
      code: -32602,
      errorMessage: message,
      ...(data !== undefined ? { data } : {}),
      ...diagnostics,
    });
  }

  static invalidPayload(
    method: string,
    operation: "decode-payload" | "encode-payload",
    cause: Schema.SchemaError,
  ) {
    const diagnostics = schemaIssueDiagnostics(cause.issue);
    return new CodexAppServerRequestError({
      code: -32602,
      errorMessage: `Invalid payload for method '${method}' during '${operation}'`,
      data: diagnostics,
      method,
      operation,
      ...diagnostics,
      cause,
    });
  }

  static unexpectedPayload(
    method: string,
    operation: "decode-payload" | "encode-payload",
    payload: unknown,
  ) {
    const diagnostics = { payloadKind: payloadKind(payload) };
    return new CodexAppServerRequestError({
      code: -32602,
      errorMessage: `Method '${method}' does not accept a payload during '${operation}'`,
      data: diagnostics,
      method,
      operation,
      ...diagnostics,
    });
  }

  static internalError(
    message = "Internal error",
    data?: unknown,
    diagnostics: CodexAppServerRequestDiagnostics = {},
  ) {
    return new CodexAppServerRequestError({
      code: -32603,
      errorMessage: message,
      ...(data !== undefined ? { data } : {}),
      ...diagnostics,
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
  CodexAppServerIdentifierGenerationError,
  CodexAppServerInputStreamEndedError,
]);

export type CodexAppServerError = typeof CodexAppServerError.Type;
