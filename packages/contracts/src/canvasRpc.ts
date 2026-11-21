/** Canvas hosts render screenshots and open tabs on behalf of the server. */
import { Schema } from "effect";

import { NonNegativeInt, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { CanvasDocumentId, CanvasDocumentSummary, CanvasNodeId, CanvasOpBatch } from "./canvas.ts";

export const CanvasListInput = Schema.Struct({ projectId: ProjectId });
export type CanvasListInput = typeof CanvasListInput.Type;

/** Leaves room for base64 and RPC metadata below the WebSocket message limit. */
export const CANVAS_UPLOAD_MAX_BYTES = 72 * 1024 * 1024;

export const CanvasImportUploadInput = Schema.Struct({
  projectId: ProjectId,
  fileName: TrimmedNonEmptyString,
  name: Schema.optional(Schema.String),
});
export type CanvasImportUploadInput = typeof CanvasImportUploadInput.Type;

export const CanvasImportPayload = Schema.Struct({
  /** Extension picks the importer: `.pen`, `.fig`, or `.zip`. */
  fileName: TrimmedNonEmptyString,
  bytesBase64: Schema.String,
});
export type CanvasImportPayload = typeof CanvasImportPayload.Type;

export const CanvasCreateInput = Schema.Struct({
  projectId: ProjectId,
  /** Defaults to the imported file's name, or "Untitled". */
  name: Schema.optional(Schema.String),
  import: Schema.optional(CanvasImportPayload),
});
export type CanvasCreateInput = typeof CanvasCreateInput.Type;

/** The new document's summary; subscribe for its contents. */
export const CanvasCreateResult = Schema.Struct({
  ...CanvasDocumentSummary.fields,
  /** Parts of an imported file that were skipped or approximated. */
  warnings: Schema.Array(Schema.String),
});
export type CanvasCreateResult = typeof CanvasCreateResult.Type;

export const CanvasDocumentRefInput = Schema.Struct({ documentId: CanvasDocumentId });
export type CanvasDocumentRefInput = typeof CanvasDocumentRefInput.Type;

export const CanvasApplyOpsInput = Schema.Struct({
  documentId: CanvasDocumentId,
  ops: CanvasOpBatch,
  /** Echoed on the resulting `ops` event so the sender can skip its own batch. */
  clientBatchId: Schema.optional(Schema.String),
  /** When set, the batch is rejected unless the document is at this revision. */
  baseRevision: Schema.optional(NonNegativeInt),
});
export type CanvasApplyOpsInput = typeof CanvasApplyOpsInput.Type;

export const CanvasApplyOpsResult = Schema.Struct({ revision: NonNegativeInt });
export type CanvasApplyOpsResult = typeof CanvasApplyOpsResult.Type;

// Canvas hosts

export const CanvasHostRegistration = Schema.Struct({
  /** Stable per client window; a reconnect with the same id replaces the old host. */
  clientId: TrimmedNonEmptyString,
});
export type CanvasHostRegistration = typeof CanvasHostRegistration.Type;

export const CanvasHostUpdate = Schema.Struct({
  clientId: TrimmedNonEmptyString,
  connectionId: TrimmedNonEmptyString,
  /** Whether this client window has focus; focused hosts win routing ties. */
  focused: Schema.Boolean,
  /** Documents with a live engine that can answer screenshot requests. */
  mountedDocumentIds: Schema.Array(CanvasDocumentId),
  /** Threads currently shown by this client, used to route `open` requests. */
  threadIds: Schema.Array(ThreadId),
});
export type CanvasHostUpdate = typeof CanvasHostUpdate.Type;

export const CanvasHostRequest = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("screenshot"),
    requestId: TrimmedNonEmptyString,
    documentId: CanvasDocumentId,
    /** Omit for the whole document. */
    nodeId: Schema.optional(CanvasNodeId),
    /** Device-pixel scale for the PNG. */
    scale: Schema.Number,
  }),
  Schema.Struct({
    type: Schema.Literal("open"),
    requestId: TrimmedNonEmptyString,
    threadId: ThreadId,
    /** Omit to open the canvas tab on the thread's current document. */
    documentId: Schema.optional(CanvasDocumentId),
  }),
]);
export type CanvasHostRequest = typeof CanvasHostRequest.Type;

export const CanvasHostStreamEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("connected"), connectionId: TrimmedNonEmptyString }),
  Schema.Struct({ type: Schema.Literal("request"), request: CanvasHostRequest }),
]);
export type CanvasHostStreamEvent = typeof CanvasHostStreamEvent.Type;

export const CanvasHostScreenshot = Schema.Struct({
  pngBase64: Schema.String,
  width: NonNegativeInt,
  height: NonNegativeInt,
});
export type CanvasHostScreenshot = typeof CanvasHostScreenshot.Type;

export const CanvasHostResponse = Schema.Struct({
  clientId: TrimmedNonEmptyString,
  connectionId: TrimmedNonEmptyString,
  requestId: TrimmedNonEmptyString,
  ok: Schema.Boolean,
  /** Required for a successful `screenshot` request. */
  screenshot: Schema.optional(CanvasHostScreenshot),
  /** Short human-readable reason when `ok` is false. */
  error: Schema.optional(Schema.String.check(Schema.isMaxLength(500))),
});
export type CanvasHostResponse = typeof CanvasHostResponse.Type;

// Errors

export class CanvasProjectNotFoundError extends Schema.TaggedError<CanvasProjectNotFoundError>()(
  "CanvasProjectNotFoundError",
  { projectId: ProjectId },
) {
  override get message(): string {
    return `Project ${this.projectId} was not found.`;
  }
}

export class CanvasDocumentNotFoundError extends Schema.TaggedError<CanvasDocumentNotFoundError>()(
  "CanvasDocumentNotFoundError",
  { documentId: Schema.String },
) {
  override get message(): string {
    return `Canvas ${this.documentId} was not found.`;
  }
}

export class CanvasNodeNotFoundError extends Schema.TaggedError<CanvasNodeNotFoundError>()(
  "CanvasNodeNotFoundError",
  { documentId: Schema.String, nodeId: Schema.String },
) {
  override get message(): string {
    return `Node ${this.nodeId} was not found in canvas ${this.documentId}.`;
  }
}

export class CanvasOpRejectedError extends Schema.TaggedError<CanvasOpRejectedError>()(
  "CanvasOpRejectedError",
  { documentId: Schema.String, reason: Schema.String },
) {
  override get message(): string {
    return `Canvas edit rejected: ${this.reason}`;
  }
}

export class CanvasRevisionConflictError extends Schema.TaggedError<CanvasRevisionConflictError>()(
  "CanvasRevisionConflictError",
  { documentId: Schema.String, baseRevision: NonNegativeInt, revision: NonNegativeInt },
) {
  override get message(): string {
    return `Canvas ${this.documentId} is at revision ${this.revision}, not ${this.baseRevision}.`;
  }
}

export class CanvasImportError extends Schema.TaggedError<CanvasImportError>()(
  "CanvasImportError",
  { fileName: Schema.String, reason: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return `Could not import ${this.fileName}: ${this.reason}`;
  }
}

export class CanvasStorageError extends Schema.TaggedError<CanvasStorageError>()(
  "CanvasStorageError",
  {
    operation: Schema.Literals(["read", "write", "delete", "list"]),
    documentId: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Canvas storage ${this.operation} failed${this.documentId === undefined ? "" : ` for ${this.documentId}`}.`;
  }
}

export class CanvasHostUnavailableError extends Schema.TaggedError<CanvasHostUnavailableError>()(
  "CanvasHostUnavailableError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

export class CanvasHostRequestFailedError extends Schema.TaggedError<CanvasHostRequestFailedError>()(
  "CanvasHostRequestFailedError",
  { requestType: Schema.String, reason: Schema.String },
) {
  override get message(): string {
    return `The client could not complete the canvas ${this.requestType}: ${this.reason}`;
  }
}

export const CanvasError = Schema.Union([
  CanvasProjectNotFoundError,
  CanvasDocumentNotFoundError,
  CanvasNodeNotFoundError,
  CanvasOpRejectedError,
  CanvasRevisionConflictError,
  CanvasImportError,
  CanvasStorageError,
  CanvasHostUnavailableError,
  CanvasHostRequestFailedError,
]);
export type CanvasError = typeof CanvasError.Type;
