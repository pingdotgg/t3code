import type { AssetResource, EnvironmentId } from "@t3tools/contracts";

import type { FileBackedComposerAttachment } from "../lib/composerImages";
import type { MediaActionsSource } from "../lib/mediaActionsSource";

interface FilePreviewMetadata {
  readonly kind: "image" | "pdf" | "document";
  readonly mimeType?: string;
  readonly name?: string;
  readonly sourceIdentifier?: string;
  readonly srcFragment?: string;
  readonly actionsSource?: MediaActionsSource;
}

export type FilePreviewItem = FilePreviewMetadata &
  (
    | { readonly uri: string }
    | { readonly attachment: FileBackedComposerAttachment }
    | { readonly environmentId: EnvironmentId; readonly resource: AssetResource }
  );

export type FilePreviewSource = FilePreviewItem & {
  readonly gallery?: readonly FilePreviewItem[];
};

interface ResolvedFilePreviewItem extends FilePreviewMetadata {
  readonly uri: string;
  /** The thumbnail's expo-image cache key, so a preview can open the bytes it already has. */
  readonly imageCacheKey?: string;
}

export interface ResolvedFilePreviewSource extends ResolvedFilePreviewItem {
  readonly gallery?: readonly ResolvedFilePreviewItem[];
}
