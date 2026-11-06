import {
  classifyMarkdownImageSource,
  markdownImageSourceFragment,
} from "@t3tools/client-runtime/markdown-images";
import {
  audioMimeTypeFromExtension,
  mediaMimeTypeFromExtension,
} from "@t3tools/shared/mediaPreview";
import { splitFilePathPosition } from "@t3tools/shared/fileLinks";
import { parseMarkdownFileLink } from "@t3tools/shared/markdownLinks";
import {
  mediaFileReference,
  mediaUrlReference,
  mediaReferenceFileName,
} from "@t3tools/client-runtime/media-reference";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { normalizeNativeMarkdownUrl, resolveMarkdownLinkPresentation } from "./markdownLinks";
import { resolveMobileMarkdownMediaSource } from "./markdownMediaSource";

import type { FilePreviewSource } from "../components/FilePreviewModal";
import type { MediaVideoPreviewSource } from "./videoPreviewSource";
import type { MediaActionsSource } from "./mediaActionsSource";

const DOCUMENT_MIME_TYPES: Readonly<Record<string, string>> = {
  ".pdf": "application/pdf",
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

export function resolveMarkdownMediaPreview(
  href: string,
  input: {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId | undefined;
    readonly workspaceRoot: string | null | undefined;
    readonly captured?: boolean;
    readonly imageEmbed?: boolean;
  },
):
  | { readonly kind: "image"; readonly source: FilePreviewSource }
  | { readonly kind: "pdf" | "audio" | "document" | "file"; readonly source: FilePreviewSource }
  | { readonly kind: "video"; readonly source: MediaVideoPreviewSource }
  | null {
  if (parseMarkdownFileLink(href)?.line !== undefined) return null;
  const classified = classifyMarkdownImageSource(href, input.workspaceRoot);
  if (classified._tag === "Direct" && /^data:(?!image\/|video\/)/i.test(classified.uri))
    return null;
  if (classified._tag !== "Blocked") {
    const path =
      classified._tag === "Direct" ? classified.uri : splitFilePathPosition(classified.path).path;
    const reference =
      classified._tag === "Direct"
        ? mediaUrlReference(path)
        : mediaFileReference(path, input.workspaceRoot);
    const name = reference && mediaReferenceFileName(reference);
    const extension = name?.slice(name.lastIndexOf(".")).toLowerCase() ?? "";
    const isFile = classified._tag === "WorkspaceFile" || /^\.[a-z0-9]+$/i.test(extension);
    if (
      name &&
      isFile &&
      mediaMimeTypeFromExtension(extension) === null &&
      (classified._tag !== "Direct" ||
        Object.hasOwn(DOCUMENT_MIME_TYPES, extension) ||
        audioMimeTypeFromExtension(extension) !== null)
    ) {
      const audioMimeType = audioMimeTypeFromExtension(extension);
      const kind = audioMimeType
        ? "audio"
        : extension === ".pdf"
          ? "pdf"
          : classified._tag === "WorkspaceFile"
            ? "file"
            : "document";
      const mimeType =
        audioMimeType ??
        (kind === "file" ? "text/plain" : DOCUMENT_MIME_TYPES[extension]) ??
        "application/octet-stream";
      const common = {
        kind: kind === "pdf" ? ("pdf" as const) : ("document" as const),
        name,
        mimeType,
      };
      if (classified._tag === "Direct") {
        const uri = normalizeNativeMarkdownUrl(path);
        return {
          kind,
          source: {
            ...common,
            uri,
            actionsSource: {
              ...(reference ? { reference } : {}),
              uri,
              name,
              mimeType: common.mimeType,
            },
          },
        };
      }
      if (input.captured) return null;
      const resource = input.threadId
        ? { _tag: "media-file" as const, threadId: input.threadId, path }
        : input.workspaceRoot
          ? { _tag: "draft-workspace-file" as const, cwd: input.workspaceRoot, path }
          : null;
      if (!resource) return null;
      return {
        kind,
        source: {
          ...common,
          environmentId: input.environmentId,
          resource,
          srcFragment: markdownImageSourceFragment(href),
          actionsSource: {
            ...(reference ? { reference } : {}),
            environmentId: input.environmentId,
            threadId: input.threadId,
            resource,
            name,
            mimeType: common.mimeType,
          },
        },
      };
    }
  }
  const media = resolveMobileMarkdownMediaSource(href, input);
  if (media === null || media.access === "unavailable") return null;
  if (input.captured && media.access !== "direct") return null;
  const { kind, name, mimeType, reference, srcFragment } = media;

  const target =
    media.access === "direct"
      ? { uri: normalizeNativeMarkdownUrl(media.uri) }
      : {
          environmentId: input.environmentId,
          resource: media.resource,
          ...(srcFragment ? { srcFragment } : {}),
        };
  const actionsSource: MediaActionsSource =
    media.access === "direct"
      ? { reference, uri: media.uri, name, mimeType }
      : {
          reference,
          environmentId: input.environmentId,
          threadId: input.threadId,
          resource: media.resource,
          name,
          mimeType,
        };
  return kind === "video"
    ? { kind, source: { type: "media", name, mimeType, ...target, actionsSource } }
    : { kind, source: { kind, name, ...target, actionsSource } };
}

export function markdownFileEmbedLabel(
  href: string,
  input: Parameters<typeof resolveMarkdownMediaPreview>[1],
  standalone: boolean,
): string | null {
  const media = resolveMarkdownMediaPreview(href, { ...input, imageEmbed: true });
  if (media) {
    if (
      media.kind === "image" ||
      ((media.kind === "video" || media.kind === "audio") && standalone)
    )
      return null;
    return media.source.name ?? null;
  }
  const file = resolveMarkdownLinkPresentation(href);
  if (file.kind === "file" && file.line === undefined) {
    if (mediaMimeTypeFromExtension(file.path.slice(file.path.lastIndexOf("."))) !== null)
      return null;
  }
  return file.kind === "file" ? file.label : null;
}
