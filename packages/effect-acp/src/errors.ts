import * as Schema from "effect/Schema";
import * as SchemaAST from "effect/SchemaAST";
import type * as SchemaIssue from "effect/SchemaIssue";

import * as AcpSchema from "./_generated/schema.gen.ts";

const AcpRequestOperation = Schema.Literals([
  "decode-extension-request-payload",
  "encode-extension-response",
  "handle-request",
  "handle-extension-request",
  "receive-response",
  "receive-streaming-response",
]);
type AcpRequestOperation = typeof AcpRequestOperation.Type;

export const AcpRequestId = Schema.Union([Schema.String, Schema.Number]);
export type AcpRequestId = typeof AcpRequestId.Type;

const AcpSchemaIssueKind = Schema.Literals([
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
type AcpSchemaIssueKind = typeof AcpSchemaIssueKind.Type;

interface AcpSchemaIssueDiagnostics {
  readonly issueCount: number;
  readonly issueKinds: ReadonlyArray<AcpSchemaIssueKind>;
  readonly maximumPathDepth: number;
}

const MAX_SUMMARY_ISSUES = 3;
const MAX_SUMMARY_PATH_SEGMENTS = 8;

const summaryPathSegment = (segment: PropertyKey): string =>
  typeof segment === "number" || /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(String(segment))
    ? String(segment)
    : "*";

const summaryPath = (path: ReadonlyArray<PropertyKey>): string => {
  if (path.length === 0) return "payload";
  const shown = path.slice(0, MAX_SUMMARY_PATH_SEGMENTS).map(summaryPathSegment).join(".");
  return path.length > MAX_SUMMARY_PATH_SEGMENTS ? `${shown}…` : shown;
};

const summaryReason = (issue: SchemaIssue.Issue): string => {
  switch (issue._tag) {
    case "MissingKey":
      return "missing";
    case "UnexpectedKey":
      return "unexpected";
    case "InvalidType":
      return "wrong type";
    default:
      return "invalid";
  }
};

const isCatchAllMember = (issue: SchemaIssue.Issue) =>
  "ast" in issue && SchemaAST.resolveTitle(issue.ast) === "other";

/**
 * ACP unions end in a member titled "other" that admits custom and future
 * variants; it fails only because the discriminator names a known variant, so
 * the known variant's issues are the ones reported.
 */
const schemaIssueSummary = (root: SchemaIssue.Issue): string => {
  const entries = new Set<string>();
  const visit = (issue: SchemaIssue.Issue, path: ReadonlyArray<PropertyKey>): void => {
    switch (issue._tag) {
      case "Filter":
      case "Encoding":
        visit(issue.issue, path);
        return;
      case "Pointer":
        visit(issue.issue, [...path, ...issue.path]);
        return;
      case "Composite":
      case "AnyOf": {
        const known = issue.issues.filter((child) => !isCatchAllMember(child));
        const children = known.length > 0 ? known : issue.issues;
        if (children.length === 0) entries.add(`${summaryPath(path)} ${summaryReason(issue)}`);
        for (const child of children) visit(child, path);
        return;
      }
      default:
        entries.add(`${summaryPath(path)} ${summaryReason(issue)}`);
    }
  };
  visit(root, []);
  const shown = [...entries].slice(0, MAX_SUMMARY_ISSUES);
  const hidden = entries.size - shown.length;
  return hidden > 0 ? `${shown.join(", ")} (+${hidden} more)` : shown.join(", ");
};

const schemaIssueDiagnostics = (root: SchemaIssue.Issue): AcpSchemaIssueDiagnostics => {
  let issueCount = 0;
  let maximumPathDepth = 0;
  const issueKinds = new Set<AcpSchemaIssueKind>();

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

export interface AcpRequestDiagnostics {
  readonly method?: string;
  readonly requestId?: AcpRequestId;
  readonly operation?: AcpRequestOperation;
  readonly cause?: unknown;
  readonly issueCount?: number;
  readonly issueKinds?: ReadonlyArray<AcpSchemaIssueKind>;
  readonly maximumPathDepth?: number;
}

export class AcpSpawnError extends Schema.TaggedError<AcpSpawnError>()("AcpSpawnError", {
  command: Schema.optional(Schema.String),
  cause: Schema.Defect(),
}) {
  override get message() {
    return this.command
      ? `Failed to spawn ACP process for command: ${this.command}`
      : "Failed to spawn ACP process";
  }
}

export class AcpProcessExitedError extends Schema.TaggedError<AcpProcessExitedError>()(
  "AcpProcessExitedError",
  {
    code: Schema.optional(Schema.Number),
    signal: Schema.optionalKey(Schema.String),
    pid: Schema.optionalKey(Schema.Int),
    stderr: Schema.optionalKey(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    const base =
      this.signal !== undefined
        ? `ACP process exited after signal ${this.signal}`
        : this.code === undefined
          ? "ACP process exited"
          : `ACP process exited with code ${this.code}`;
    const excerpt = this.stderr?.trim();
    return excerpt && excerpt.length > 0 ? `${base}\n${excerpt}` : base;
  }
}

export const AcpProtocolParseOperation = Schema.Literals([
  "encode-message",
  "decode-wire-message",
  "decode-notification-payload",
]);
export type AcpProtocolParseOperation = typeof AcpProtocolParseOperation.Type;

export class AcpProtocolParseError extends Schema.TaggedError<AcpProtocolParseError>()(
  "AcpProtocolParseError",
  {
    operation: AcpProtocolParseOperation,
    method: Schema.optionalKey(Schema.String),
    requestId: Schema.optionalKey(AcpRequestId),
    issueCount: Schema.optionalKey(Schema.Number),
    issueKinds: Schema.optionalKey(Schema.Array(AcpSchemaIssueKind)),
    maximumPathDepth: Schema.optionalKey(Schema.Number),
    issueSummary: Schema.optionalKey(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message() {
    const method = this.method === undefined ? "" : ` for method '${this.method}'`;
    const summary = this.issueSummary === undefined ? "" : `: ${this.issueSummary}`;
    return `ACP protocol operation '${this.operation}' failed${method}${summary}.`;
  }

  static fromSchemaError(
    operation: AcpProtocolParseOperation,
    method: string,
    cause: Schema.SchemaError,
  ) {
    return new AcpProtocolParseError({
      operation,
      method,
      ...schemaIssueDiagnostics(cause.issue),
      issueSummary: schemaIssueSummary(cause.issue),
      cause,
    });
  }

  static fromEncodingError(
    method: string | undefined,
    requestId: AcpRequestId | undefined,
    cause: unknown,
  ) {
    return new AcpProtocolParseError({
      operation: "encode-message",
      ...(method === undefined ? {} : { method }),
      ...(requestId === undefined ? {} : { requestId }),
      cause,
    });
  }
}

export class AcpTransportError extends Schema.TaggedError<AcpTransportError>()(
  "AcpTransportError",
  {
    operation: Schema.optional(
      Schema.Literals(["call-rpc", "read-input-stream", "read-process-exit-status"]),
    ),
    method: Schema.optional(Schema.String),
    detail: Schema.optional(Schema.String),
    pid: Schema.optionalKey(Schema.Int),
    cause: Schema.Defect(),
  },
) {
  override get message() {
    const operation = this.operation ? ` ${this.operation}` : "";
    const method = this.method ? ` for method ${this.method}` : "";
    // Callers often pass a sentence; strip its period so the message ends with exactly one.
    const detail = this.detail ? `: ${this.detail.replace(/\.$/, "")}` : "";
    return `ACP transport operation${operation} failed${method}${detail}.`;
  }
}

export class AcpInputStreamEndedError extends Schema.TaggedError<AcpInputStreamEndedError>()(
  "AcpInputStreamEndedError",
  {},
) {
  override get message() {
    return "ACP input stream ended.";
  }
}

export class AcpRequestError extends Schema.TaggedError<AcpRequestError>()("AcpRequestError", {
  code: AcpSchema.ErrorCode,
  errorMessage: Schema.String,
  data: Schema.optional(Schema.Unknown),
  method: Schema.optionalKey(Schema.String),
  requestId: Schema.optionalKey(AcpRequestId),
  operation: Schema.optionalKey(AcpRequestOperation),
  issueCount: Schema.optionalKey(Schema.Number),
  issueKinds: Schema.optionalKey(Schema.Array(AcpSchemaIssueKind)),
  maximumPathDepth: Schema.optionalKey(Schema.Number),
  cause: Schema.optionalKey(Schema.Defect()),
}) {
  override get message() {
    return this.errorMessage;
  }

  static fromProtocolError(
    error: AcpSchema.Error,
    context: {
      readonly method: string;
      readonly requestId?: AcpRequestId;
      readonly cause?: unknown;
    },
  ) {
    return new AcpRequestError({
      code: error.code,
      errorMessage: error.message,
      ...(error.data !== undefined ? { data: error.data } : {}),
      method: context.method,
      ...(context.requestId === undefined ? {} : { requestId: context.requestId }),
      operation: "receive-response",
      cause: context.cause ?? error,
    });
  }

  static fromExtensionResponseFailure(method: string, requestId: AcpRequestId, cause: unknown) {
    return AcpRequestError.internalError("Extension request failed", undefined, {
      method,
      requestId,
      operation: "receive-response",
      cause,
    });
  }

  static fromExtensionResponseEncodingError(
    method: string,
    requestId: AcpRequestId,
    cause: AcpProtocolParseError,
  ) {
    return AcpRequestError.internalError("Internal error", undefined, {
      method,
      requestId,
      operation: "encode-extension-response",
      cause,
    });
  }

  static unsupportedStreamingResponse(method: string, requestId: AcpRequestId) {
    return AcpRequestError.internalError(
      "Streaming extension responses are not supported",
      undefined,
      {
        method,
        requestId,
        operation: "receive-streaming-response",
      },
    );
  }

  static fromCoreHandlerError(error: AcpError, method: string) {
    if (error._tag === "AcpRequestError") {
      return error;
    }
    return AcpRequestError.internalError(
      `ACP request handler failed for method '${method}'`,
      undefined,
      {
        method,
        operation: "handle-request",
        cause: error,
      },
    );
  }

  static fromExtensionHandlerError(error: AcpError, method: string) {
    if (error._tag === "AcpRequestError") {
      return error;
    }
    return AcpRequestError.internalError(
      `ACP extension request handler failed for method '${method}'`,
      undefined,
      {
        method,
        operation: "handle-extension-request",
        cause: error,
      },
    );
  }

  static parseError(message = "Parse error", data?: unknown) {
    return new AcpRequestError({
      code: -32700,
      errorMessage: message,
      ...(data !== undefined ? { data } : {}),
    });
  }

  static invalidRequest(message = "Invalid request", data?: unknown) {
    return new AcpRequestError({
      code: -32600,
      errorMessage: message,
      ...(data !== undefined ? { data } : {}),
    });
  }

  static methodNotFound(method: string) {
    return new AcpRequestError({
      code: -32601,
      errorMessage: `Method not found: ${method}`,
    });
  }

  static invalidParams(message = "Invalid params", data?: unknown) {
    return new AcpRequestError({
      code: -32602,
      errorMessage: message,
      ...(data !== undefined ? { data } : {}),
    });
  }

  static invalidExtensionPayload(method: string, cause: Schema.SchemaError) {
    const diagnostics = schemaIssueDiagnostics(cause.issue);
    return new AcpRequestError({
      code: -32602,
      errorMessage: `Invalid payload for ACP extension method '${method}'.`,
      data: diagnostics,
      method,
      operation: "decode-extension-request-payload",
      ...diagnostics,
      cause,
    });
  }

  static internalError(
    message = "Internal error",
    data?: unknown,
    diagnostics: AcpRequestDiagnostics = {},
  ) {
    return new AcpRequestError({
      code: -32603,
      errorMessage: message,
      ...(data !== undefined ? { data } : {}),
      ...diagnostics,
    });
  }

  static authRequired(message = "Authentication required", data?: unknown) {
    return new AcpRequestError({
      code: -32000,
      errorMessage: message,
      ...(data !== undefined ? { data } : {}),
    });
  }

  static resourceNotFound(message = "Resource not found", data?: unknown) {
    return new AcpRequestError({
      code: -32002,
      errorMessage: message,
      ...(data !== undefined ? { data } : {}),
    });
  }

  toProtocolError() {
    return AcpSchema.Error.make({
      code: this.code,
      message: this.errorMessage,
      ...(this.data !== undefined ? { data: this.data } : {}),
    });
  }
}

export const AcpError = Schema.Union([
  AcpRequestError,
  AcpSpawnError,
  AcpProcessExitedError,
  AcpProtocolParseError,
  AcpTransportError,
  AcpInputStreamEndedError,
]);

export type AcpError = typeof AcpError.Type;
