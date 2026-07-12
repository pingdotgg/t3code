import * as Schema from "effect/Schema";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

const ASSET_PATH_MAX_LENGTH = 1024;
const TEXT_ATTACHMENT_CONTENT_MAX_LENGTH = 1024 * 1024;
const TEXT_ATTACHMENT_DRAFT_OWNER_ID_MAX_LENGTH = 256;

const TextAttachmentDraftOwnerId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(TEXT_ATTACHMENT_DRAFT_OWNER_ID_MAX_LENGTH),
);

export const AssetResource = Schema.Union([
  Schema.TaggedStruct("workspace-file", {
    threadId: ThreadId,
    path: TrimmedNonEmptyString.check(Schema.isMaxLength(ASSET_PATH_MAX_LENGTH)),
  }),
  Schema.TaggedStruct("attachment", {
    attachmentId: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  }),
  Schema.TaggedStruct("project-favicon", {
    cwd: TrimmedNonEmptyString.check(Schema.isMaxLength(ASSET_PATH_MAX_LENGTH)),
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
});
export type AssetCreateUrlResult = typeof AssetCreateUrlResult.Type;

export const AssetWriteTextAttachmentInput = Schema.Struct({
  fileName: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  contents: Schema.String.check(Schema.isMaxLength(TEXT_ATTACHMENT_CONTENT_MAX_LENGTH)),
  draftOwnerId: TextAttachmentDraftOwnerId,
});
export type AssetWriteTextAttachmentInput = typeof AssetWriteTextAttachmentInput.Type;

export const AssetWriteTextAttachmentResult = Schema.Struct({
  path: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
});
export type AssetWriteTextAttachmentResult = typeof AssetWriteTextAttachmentResult.Type;

export const AssetClaimTextAttachmentInput = Schema.Struct({
  path: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
  draftOwnerId: TextAttachmentDraftOwnerId,
});
export type AssetClaimTextAttachmentInput = typeof AssetClaimTextAttachmentInput.Type;

export const AssetClaimTextAttachmentResult = Schema.Struct({
  claimed: Schema.Boolean,
});
export type AssetClaimTextAttachmentResult = typeof AssetClaimTextAttachmentResult.Type;

export const AssetReleaseTextAttachmentInput = AssetClaimTextAttachmentInput;
export type AssetReleaseTextAttachmentInput = typeof AssetReleaseTextAttachmentInput.Type;

export const AssetReleaseTextAttachmentResult = Schema.Struct({
  released: Schema.Boolean,
});
export type AssetReleaseTextAttachmentResult = typeof AssetReleaseTextAttachmentResult.Type;

export class AssetTextAttachmentWriteError extends Schema.TaggedErrorClass<AssetTextAttachmentWriteError>()(
  "AssetTextAttachmentWriteError",
  {
    fileName: TrimmedNonEmptyString,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to store text attachment '${this.fileName}'.`;
  }
}

export class AssetTextAttachmentClaimError extends Schema.TaggedErrorClass<AssetTextAttachmentClaimError>()(
  "AssetTextAttachmentClaimError",
  {
    path: TrimmedNonEmptyString,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to claim text attachment.";
  }
}

export class AssetTextAttachmentReleaseError extends Schema.TaggedErrorClass<AssetTextAttachmentReleaseError>()(
  "AssetTextAttachmentReleaseError",
  {
    path: TrimmedNonEmptyString,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to release text attachment.";
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
    return "Only browser documents and images can be previewed.";
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
    return "Failed to inspect the workspace asset.";
  }
}

export class AssetWorkspaceAssetNotFoundError extends Schema.TaggedErrorClass<AssetWorkspaceAssetNotFoundError>()(
  "AssetWorkspaceAssetNotFoundError",
  {
    resource: AssetResource,
  },
) {
  override get message(): string {
    return "Workspace asset was not found.";
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
