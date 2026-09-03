import * as Schema from "effect/Schema";

import { NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPES,
  ProjectFaviconPath,
} from "./orchestration.ts";

const ASSET_PATH_MAX_LENGTH = 1024;

export const AssetResource = Schema.Union([
  Schema.TaggedStruct("workspace-file", {
    threadId: ThreadId,
    path: TrimmedNonEmptyString.check(Schema.isMaxLength(ASSET_PATH_MAX_LENGTH)),
  }),
  // One file served in place from anywhere the environment host can read:
  // images, videos, HTML, and PDF. An absolute path may lie outside the
  // workspace; a relative one resolves against the thread's workspace.
  Schema.TaggedStruct("media-file", {
    threadId: ThreadId,
    path: TrimmedNonEmptyString.check(Schema.isMaxLength(ASSET_PATH_MAX_LENGTH)),
  }),
  Schema.TaggedStruct("attachment", {
    attachmentId: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
    /** Display name and mime from the `ChatAttachment` the caller holds. The
        server bakes both into the signed URL so downloads carry the real
        filename and Content-Type. Absent on older clients, which fall back to
        an octet-stream download without a filename. */
    fileName: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(255))),
    mimeType: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(100))),
    /** Generic attachments download by default. Document viewers opt into an
        inline response after deciding the file type is safe to preview. */
    disposition: Schema.optionalKey(Schema.Literals(["inline", "attachment"])),
  }),
  Schema.TaggedStruct("project-favicon", {
    cwd: TrimmedNonEmptyString.check(Schema.isMaxLength(ASSET_PATH_MAX_LENGTH)),
    // A cache-key hint only. The server reads the authoritative path from the
    // project projection before it issues the signed URL.
    path: Schema.optional(ProjectFaviconPath),
  }),
]);
export type AssetResource = typeof AssetResource.Type;

export const AssetCreateUrlInput = Schema.Struct({
  resource: AssetResource,
});
export type AssetCreateUrlInput = typeof AssetCreateUrlInput.Type;

export const AssetCreateUrlResult = Schema.Struct({
  relativeUrl: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
  expiresAt: Schema.Number,
  sourcePath: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(ASSET_PATH_MAX_LENGTH)),
  ),
});
export type AssetCreateUrlResult = typeof AssetCreateUrlResult.Type;

export const ATTACHMENT_UPLOAD_URL_TTL_MS = 10 * 60_000;

const ImageAttachmentCreateUploadUrlInput = Schema.Struct({
  type: Schema.optionalKey(Schema.Literal("image")),
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  mimeType: Schema.Literals(PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPES),
  sizeBytes: NonNegativeInt.check(
    Schema.isGreaterThanOrEqualTo(1),
    Schema.isLessThanOrEqualTo(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES),
  ),
});

const FileAttachmentCreateUploadUrlInput = Schema.Struct({
  type: Schema.Literal("file"),
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  mimeType: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
  sizeBytes: NonNegativeInt.check(
    Schema.isGreaterThanOrEqualTo(1),
    Schema.isLessThanOrEqualTo(PROVIDER_SEND_TURN_MAX_FILE_BYTES),
  ),
});

export const AttachmentCreateUploadUrlInput = Schema.Union([
  ImageAttachmentCreateUploadUrlInput,
  FileAttachmentCreateUploadUrlInput,
]);
export type AttachmentCreateUploadUrlInput = typeof AttachmentCreateUploadUrlInput.Type;

export const AttachmentCreateUploadUrlResult = Schema.Struct({
  attachmentId: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  relativeUrl: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
  expiresAt: Schema.Number,
});
export type AttachmentCreateUploadUrlResult = typeof AttachmentCreateUploadUrlResult.Type;

export const AttachmentDeleteInput = Schema.Struct({
  attachmentId: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
});
export type AttachmentDeleteInput = typeof AttachmentDeleteInput.Type;

export class AttachmentUploadSigningKeyError extends Schema.TaggedErrorClass<AttachmentUploadSigningKeyError>()(
  "AttachmentUploadSigningKeyError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to load the attachment upload signing key.";
  }
}

export class AssetWorkspaceContextNotFoundError extends Schema.TaggedErrorClass<AssetWorkspaceContextNotFoundError>()(
  "AssetWorkspaceContextNotFoundError",
  {
    resource: AssetResource,
  },
) {
  override get message(): string {
    return "Workspace context was not found.";
  }
}

export class AssetWorkspaceContextResolutionError extends Schema.TaggedErrorClass<AssetWorkspaceContextResolutionError>()(
  "AssetWorkspaceContextResolutionError",
  {
    resource: AssetResource,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to resolve workspace context.";
  }
}

export class AssetWorkspaceRootNormalizationError extends Schema.TaggedErrorClass<AssetWorkspaceRootNormalizationError>()(
  "AssetWorkspaceRootNormalizationError",
  {
    resource: AssetResource,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to normalize the workspace root.";
  }
}

export class AssetWorkspacePathValidationError extends Schema.TaggedErrorClass<AssetWorkspacePathValidationError>()(
  "AssetWorkspacePathValidationError",
  {
    resource: AssetResource,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Workspace file path must be relative to the project root.";
  }
}

export class AssetPreviewTypeValidationError extends Schema.TaggedErrorClass<AssetPreviewTypeValidationError>()(
  "AssetPreviewTypeValidationError",
  {
    resource: AssetResource,
  },
) {
  override get message(): string {
    return this.resource._tag === "media-file"
      ? "Only images, videos, HTML, and PDF files can be previewed."
      : "Only browser documents and images can be previewed.";
  }
}

export class AssetWorkspaceAssetInspectionError extends Schema.TaggedErrorClass<AssetWorkspaceAssetInspectionError>()(
  "AssetWorkspaceAssetInspectionError",
  {
    resource: AssetResource,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return this.resource._tag === "media-file"
      ? "Failed to inspect the media file."
      : "Failed to inspect the workspace asset.";
  }
}

export class AssetWorkspaceAssetNotFoundError extends Schema.TaggedErrorClass<AssetWorkspaceAssetNotFoundError>()(
  "AssetWorkspaceAssetNotFoundError",
  {
    resource: AssetResource,
  },
) {
  override get message(): string {
    return this.resource._tag === "media-file"
      ? "Media file was not found."
      : "Workspace asset was not found.";
  }
}

export class AssetWorkspaceResolutionError extends Schema.TaggedErrorClass<AssetWorkspaceResolutionError>()(
  "AssetWorkspaceResolutionError",
  {
    resource: AssetResource,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to resolve workspace.";
  }
}

export class AssetAttachmentNotFoundError extends Schema.TaggedErrorClass<AssetAttachmentNotFoundError>()(
  "AssetAttachmentNotFoundError",
  {
    resource: AssetResource,
  },
) {
  override get message(): string {
    return "Attachment was not found.";
  }
}

export class AssetProjectFaviconResolutionError extends Schema.TaggedErrorClass<AssetProjectFaviconResolutionError>()(
  "AssetProjectFaviconResolutionError",
  {
    resource: AssetResource,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to resolve project favicon.";
  }
}

export class AssetProjectFaviconInspectionError extends Schema.TaggedErrorClass<AssetProjectFaviconInspectionError>()(
  "AssetProjectFaviconInspectionError",
  {
    resource: AssetResource,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to inspect the project favicon.";
  }
}

export class AssetProjectFaviconNotFoundError extends Schema.TaggedErrorClass<AssetProjectFaviconNotFoundError>()(
  "AssetProjectFaviconNotFoundError",
  {
    resource: AssetResource,
  },
) {
  override get message(): string {
    return "Project favicon was not found.";
  }
}

export class AssetSigningKeyLoadError extends Schema.TaggedErrorClass<AssetSigningKeyLoadError>()(
  "AssetSigningKeyLoadError",
  {
    resource: AssetResource,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to load the asset signing key.";
  }
}

export const AssetAccessError = Schema.Union([
  AssetWorkspaceContextNotFoundError,
  AssetWorkspaceContextResolutionError,
  AssetWorkspaceRootNormalizationError,
  AssetWorkspacePathValidationError,
  AssetPreviewTypeValidationError,
  AssetWorkspaceAssetInspectionError,
  AssetWorkspaceAssetNotFoundError,
  AssetWorkspaceResolutionError,
  AssetAttachmentNotFoundError,
  AssetProjectFaviconResolutionError,
  AssetProjectFaviconInspectionError,
  AssetProjectFaviconNotFoundError,
  AssetSigningKeyLoadError,
]);
export type AssetAccessError = typeof AssetAccessError.Type;
