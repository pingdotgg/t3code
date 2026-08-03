import { EnvironmentId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import * as Schema from "effect/Schema";

const FILE_UPLOAD_PATH_MAX_LENGTH = 1024;
const FILE_UPLOAD_NAME_MAX_LENGTH = 256;
const FILE_UPLOAD_CONTENT_TYPE_MAX_LENGTH = 128;

export const FileUploadInput = Schema.Struct({
  path: TrimmedNonEmptyString.check(Schema.isMaxLength(FILE_UPLOAD_PATH_MAX_LENGTH)),
  name: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(FILE_UPLOAD_NAME_MAX_LENGTH)),
  ),
  contentType: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(FILE_UPLOAD_CONTENT_TYPE_MAX_LENGTH)),
  ),
});
export type FileUploadInput = typeof FileUploadInput.Type;

export const FileUploadActionInput = Schema.Struct({
  action: Schema.Literal("invoke"),
  name: Schema.Literal("file-upload"),
  input: FileUploadInput,
});
export type FileUploadActionInput = typeof FileUploadActionInput.Type;

export const FileUploadResult = Schema.Struct({
  url: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(FILE_UPLOAD_NAME_MAX_LENGTH)),
  contentType: TrimmedNonEmptyString.check(Schema.isMaxLength(FILE_UPLOAD_CONTENT_TYPE_MAX_LENGTH)),
  size: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  sha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
});
export type FileUploadResult = typeof FileUploadResult.Type;

const FileUploadScopeFields = {
  environmentId: EnvironmentId,
  threadId: ThreadId,
  providerSessionId: TrimmedNonEmptyString,
  providerInstanceId: ProviderInstanceId,
};

export class FileUploadCapabilityUnavailableError extends Schema.TaggedErrorClass<FileUploadCapabilityUnavailableError>()(
  "FileUploadCapabilityUnavailableError",
  {
    ...FileUploadScopeFields,
  },
) {
  override get message(): string {
    return "MCP credential does not grant the file-upload capability.";
  }
}

export class FileUploadWorkspaceContextNotFoundError extends Schema.TaggedErrorClass<FileUploadWorkspaceContextNotFoundError>()(
  "FileUploadWorkspaceContextNotFoundError",
  {
    ...FileUploadScopeFields,
  },
) {
  override get message(): string {
    return "The active thread workspace could not be found.";
  }
}

export class FileUploadWorkspaceResolutionError extends Schema.TaggedErrorClass<FileUploadWorkspaceResolutionError>()(
  "FileUploadWorkspaceResolutionError",
  {
    ...FileUploadScopeFields,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "The active thread workspace could not be resolved.";
  }
}

export class FileUploadPathValidationError extends Schema.TaggedErrorClass<FileUploadPathValidationError>()(
  "FileUploadPathValidationError",
  {
    path: Schema.String,
    reason: Schema.Literals([
      "absolute-path",
      "path-traversal",
      "outside-workspace",
      "symlink",
      "not-a-file",
      "unreadable",
    ]),
  },
) {
  override get message(): string {
    return `The upload path is not a safe workspace file (${this.reason}).`;
  }
}

export class FileUploadMimeTypeNotAllowedError extends Schema.TaggedErrorClass<FileUploadMimeTypeNotAllowedError>()(
  "FileUploadMimeTypeNotAllowedError",
  {
    path: Schema.String,
    detectedContentType: Schema.String,
    requestedContentType: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return `The file type '${this.detectedContentType}' is not an allowed image or video.`;
  }
}

export class FileUploadSizeLimitError extends Schema.TaggedErrorClass<FileUploadSizeLimitError>()(
  "FileUploadSizeLimitError",
  {
    path: Schema.String,
    size: Schema.Number,
    maxBytes: Schema.Number,
  },
) {
  override get message(): string {
    return `The file is too large to upload (${this.size} bytes; maximum ${this.maxBytes}).`;
  }
}

export class FileUploadStorageConfigurationError extends Schema.TaggedErrorClass<FileUploadStorageConfigurationError>()(
  "FileUploadStorageConfigurationError",
  {
    missing: Schema.Array(Schema.String),
    invalid: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return "The file-upload storage backend is not configured.";
  }
}

export class FileUploadStorageError extends Schema.TaggedErrorClass<FileUploadStorageError>()(
  "FileUploadStorageError",
  {
    operation: Schema.Literal("put"),
    status: Schema.optional(Schema.Number),
  },
) {
  override get message(): string {
    return "The file could not be uploaded to object storage.";
  }
}

export const FileUploadError = Schema.Union([
  FileUploadCapabilityUnavailableError,
  FileUploadWorkspaceContextNotFoundError,
  FileUploadWorkspaceResolutionError,
  FileUploadPathValidationError,
  FileUploadMimeTypeNotAllowedError,
  FileUploadSizeLimitError,
  FileUploadStorageConfigurationError,
  FileUploadStorageError,
]);
export type FileUploadError = typeof FileUploadError.Type;
