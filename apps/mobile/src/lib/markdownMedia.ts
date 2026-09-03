import { resolveMediaSource } from "@t3tools/client-runtime/media-source";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { normalizeNativeMarkdownUrl } from "@t3tools/mobile-markdown-text/links";

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
  const media = resolveMediaSource(href, input);
  if (media === null || media.access === "unavailable") return null;
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
