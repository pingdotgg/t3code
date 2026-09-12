import type { AssetResource, ChatFileAttachment, EnvironmentId } from "@t3tools/contracts";
import { videoMimeType } from "@t3tools/shared/video";

import type { DraftComposerFileAttachment } from "./composerImages";
import type { MediaActionsSource } from "./mediaActions";

export type MediaVideoPreviewSource = {
  readonly type: "media";
  readonly name: string;
  readonly mimeType: string;
  readonly sourceIdentifier?: string;
  readonly srcFragment?: string;
  readonly actionsSource?: MediaActionsSource;
} & (
  | { readonly uri: string }
  | {
      readonly environmentId: EnvironmentId;
      readonly resource: Extract<AssetResource, { readonly _tag: "attachment" | "media-file" }>;
    }
);

/** Resolves the current capability without making it the identity of the video. */
export function mediaVideoPreviewUri(
  source: MediaVideoPreviewSource,
  assetUrl: string | null,
): string | null {
  if ("uri" in source) return source.uri;
  return assetUrl === null ? null : assetUrl + (source.srcFragment ?? "");
}

/** Keeps thumbnails independent of refreshed asset signatures and scoped to their environment. */
export function mediaVideoThumbnailKey(source: MediaVideoPreviewSource): string {
  return JSON.stringify(
    "uri" in source
      ? ["media-video", source.uri]
      : source.resource._tag === "attachment"
        ? ["media-video", source.environmentId, "attachment", source.resource.attachmentId]
        : [
            "media-video",
            source.environmentId,
            source.resource.threadId,
            source.resource.path,
            source.srcFragment ?? "",
          ],
  );
}

export interface LocalVideoPreviewSource {
  readonly type: "local";
  readonly attachment: DraftComposerFileAttachment;
  readonly sourceIdentifier?: string;
}

export type VideoPreviewSource = LocalVideoPreviewSource | MediaVideoPreviewSource;

export function attachmentVideoPreviewSource(
  environmentId: EnvironmentId,
  attachment: ChatFileAttachment,
  sourceIdentifier?: string,
): MediaVideoPreviewSource {
  const mimeType = videoMimeType(attachment) ?? attachment.mimeType;
  const resource = {
    _tag: "attachment" as const,
    attachmentId: attachment.id,
    fileName: attachment.name,
    mimeType,
  };
  return {
    type: "media",
    name: attachment.name,
    mimeType,
    ...(sourceIdentifier ? { sourceIdentifier } : {}),
    environmentId,
    resource,
    actionsSource: {
      name: attachment.name,
      mimeType,
      ...(sourceIdentifier ? { sourceIdentifier } : {}),
      environmentId,
      resource,
    },
  };
}
