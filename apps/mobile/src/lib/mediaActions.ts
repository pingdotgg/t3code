import { useNavigation } from "@react-navigation/native";
import type { MediaActionId } from "@t3tools/client-runtime/media-actions";
import type { MediaReference } from "@t3tools/client-runtime/media-reference";
import type { AssetResource, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { normalizeNativeMarkdownUrl } from "@t3tools/mobile-markdown-text/links";
import { createContext, use, useEffect, useRef, useState } from "react";
import { Alert } from "react-native";

import { useRefreshAssetUrl } from "../state/assets";
import { downloadAndShareAttachment, shareLocalAttachment } from "./attachmentDownload";
import type { FileBackedComposerAttachment } from "./composerImages";
import { copyTextWithHaptic } from "./copyTextWithHaptic";
import { loadLocalAttachmentPreview } from "./localAttachmentPreview";

/** Authored source metadata is kept separate from temporary preview/download URLs. */
export type MediaActionsSource = {
  readonly reference?: MediaReference;
  readonly name: string;
  readonly mimeType: string;
  /** Anchors the iOS share sheet to the view that opened the menu. */
  readonly sourceIdentifier?: string;
} & (
  | { readonly uri: string }
  | { readonly attachment: FileBackedComposerAttachment }
  | {
      readonly environmentId: EnvironmentId;
      readonly threadId?: ThreadId;
      readonly resource: AssetResource;
    }
);

/**
 * Opens region selection for an image and cites it into the thread that owns the surface.
 * Null outside a thread, where no composer can receive the crop.
 */
export const ImageCiteContext = createContext<((source: MediaActionsSource) => void) | null>(null);

/** Images the native cropper can decode. An SVG has no pixels until something renders it. */
function isCitableImageMimeType(mimeType: string): boolean {
  const type = mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return type.startsWith("image/") && type !== "image/svg+xml";
}

/** `onLeavePreview` closes the preview that hosts the menu before an action opens another view. */
export function useMediaActions(
  source: MediaActionsSource | undefined,
  onLeavePreview?: () => void,
) {
  const navigation = useNavigation();
  const citeImage = use(ImageCiteContext);
  const refresh = useRefreshAssetUrl(
    source && "environmentId" in source ? source.environmentId : null,
    source && "resource" in source ? source.resource : null,
  );
  const controller = useRef<AbortController | null>(null);
  const [sharing, setSharing] = useState(false);
  useEffect(() => () => controller.current?.abort(), []);

  const share = () => {
    if (!source || controller.current) return;
    const request = new AbortController();
    controller.current = request;
    setSharing(true);
    void (async () => {
      if ("attachment" in source) {
        const preview = await loadLocalAttachmentPreview(source.attachment, request.signal);
        if (!preview) return;
        try {
          await preview.share(request.signal, source.sourceIdentifier);
        } finally {
          preview.dispose();
        }
        return;
      }
      const uri = "uri" in source ? normalizeNativeMarkdownUrl(source.uri) : await refresh();
      if (request.signal.aborted) return;
      if (uri === null) throw new Error("The file could not be loaded. Reconnect and try again.");
      const input = {
        attachment: { name: source.name, mimeType: source.mimeType },
        signal: request.signal,
        sourceIdentifier: source.sourceIdentifier,
      };
      if (/^(file|content):/i.test(uri)) await shareLocalAttachment({ ...input, uri });
      else await downloadAndShareAttachment({ ...input, url: uri });
    })()
      .catch((error: unknown) => {
        if (!request.signal.aborted) {
          Alert.alert(
            "Could not share file",
            error instanceof Error ? error.message : "Try again.",
          );
        }
      })
      .finally(() => {
        if (controller.current === request) {
          controller.current = null;
          if (!request.signal.aborted) setSharing(false);
        }
      });
  };

  const reference = source?.reference;
  const relativePath = reference?.kind === "file" ? reference.relativePath : undefined;
  const threadId = source && "threadId" in source ? source.threadId : undefined;
  const actions: { id: MediaActionId; title: string; run: () => void; disabled?: boolean }[] =
    source
      ? [
          ...(citeImage && isCitableImageMimeType(source.mimeType)
            ? [
                {
                  id: "cite-region" as const,
                  title: "Cite region",
                  run: () => {
                    onLeavePreview?.();
                    citeImage(source);
                  },
                },
              ]
            : []),
          ...(reference?.kind === "file"
            ? [
                {
                  id: "copy-full-path" as const,
                  title: "Copy full path",
                  run: () => copyTextWithHaptic(reference.path),
                },
              ]
            : []),
          ...(relativePath
            ? [
                {
                  id: "copy-relative-path" as const,
                  title: "Copy relative path",
                  run: () => copyTextWithHaptic(relativePath),
                },
              ]
            : []),
          ...(reference?.kind === "url"
            ? [
                {
                  id: "copy-url" as const,
                  title: "Copy URL",
                  run: () => copyTextWithHaptic(reference.url),
                },
              ]
            : []),
          ...(relativePath && "environmentId" in source && threadId !== undefined
            ? [
                {
                  id: "open-file" as const,
                  title: "Open in file viewer",
                  run: () => {
                    onLeavePreview?.();
                    navigation.navigate("ThreadFile", {
                      environmentId: String(source.environmentId),
                      threadId: String(threadId),
                      path: relativePath.split("/"),
                    });
                  },
                },
              ]
            : []),
          {
            id: "save" as const,
            title: sharing ? "Opening share sheet…" : "Save or share",
            run: share,
            disabled: sharing,
          },
        ]
      : [];
  return {
    title: reference?.kind === "file" ? reference.path : reference?.url,
    actions,
    sharing,
    share,
  };
}
