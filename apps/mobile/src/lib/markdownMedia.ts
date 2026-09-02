import {
  classifyMarkdownImageSource,
  markdownImageSourceFragment,
} from "@t3tools/client-runtime/markdown-images";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { normalizeNativeMarkdownUrl } from "@t3tools/mobile-markdown-text/links";
import { mediaMimeType, mediaMimeTypeFromExtension } from "@t3tools/shared/filePreview";
import {
  mediaFileReference,
  mediaReferenceFileName,
  mediaUrlReference,
} from "@t3tools/client-runtime/media-reference";

import type { FilePreviewSource } from "../components/FilePreviewModal";
import type { MediaVideoPreviewSource } from "./videoPreviewSource";
import type { MediaActionsSource } from "./mediaActions";

/** Resolves only explicit media references. Ordinary links keep their existing navigation. */
export function resolveMarkdownMediaPreview(
  href: string,
  input: {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
    readonly workspaceRoot: string | null | undefined;
    /** Image syntax can target an endpoint without a recognizable extension. */
    readonly imageEmbed?: boolean;
  },
):
  | { readonly kind: "image"; readonly source: FilePreviewSource }
  | { readonly kind: "video"; readonly source: MediaVideoPreviewSource }
  | null {
  const classified = classifyMarkdownImageSource(href, input.workspaceRoot);
  if (classified._tag === "Blocked") return null;
  const path =
    classified._tag === "WorkspaceFile"
      ? classified.path.replace(/:\d+(?::\d+)?$/, "")
      : classified.uri.split(/[?#]/, 1)[0]!;
  const basename = path.split(/[\\/]/).at(-1) ?? "";
  const extensionIndex = basename.lastIndexOf(".");
  // Local paths have already been decoded. Do not interpret literal #, ?, or % characters again.
  const detectedMimeType =
    classified._tag === "Direct"
      ? mediaMimeType(classified.uri)
      : extensionIndex < 0
        ? null
        : mediaMimeTypeFromExtension(basename.slice(extensionIndex));
  const mimeType = detectedMimeType ?? (input.imageEmbed ? "image/*" : null);
  if (mimeType === null) return null;
  const kind = mimeType.startsWith("video/") ? "video" : "image";
  const reference =
    classified._tag === "Direct"
      ? mediaUrlReference(classified.uri)
      : mediaFileReference(path, input.workspaceRoot);
  const name =
    (reference && mediaReferenceFileName(reference)) || (kind === "video" ? "Video" : "Image");
  const srcFragment = markdownImageSourceFragment(href);
  const target =
    classified._tag === "Direct"
      ? { uri: normalizeNativeMarkdownUrl(classified.uri) }
      : {
          environmentId: input.environmentId,
          resource: {
            _tag: "media-file" as const,
            threadId: input.threadId,
            path,
          },
          ...(srcFragment ? { srcFragment } : {}),
        };
  const actionsSource: MediaActionsSource =
    classified._tag === "Direct"
      ? { reference, uri: classified.uri, name, mimeType }
      : {
          reference,
          environmentId: input.environmentId,
          threadId: input.threadId,
          resource: { _tag: "media-file", threadId: input.threadId, path },
          name,
          mimeType,
        };
  return kind === "video"
    ? {
        kind,
        source: { type: "media", name, mimeType, ...target, actionsSource },
      }
    : {
        kind,
        source: { kind, name, ...target, actionsSource },
      };
}
