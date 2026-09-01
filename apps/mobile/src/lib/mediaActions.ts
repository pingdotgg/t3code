import { useNavigation } from "@react-navigation/native";
import type { MediaReference } from "@t3tools/client-runtime/media-reference";
import type { AssetResource, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { normalizeNativeMarkdownUrl } from "@t3tools/mobile-markdown-text/links";
import { useEffect, useRef, useState } from "react";
import { Alert } from "react-native";

import { useRefreshAssetUrl } from "../state/assets";
import { downloadAndShareAttachment, shareLocalAttachment } from "./attachmentDownload";
import { copyTextWithHaptic } from "./copyTextWithHaptic";

/** Authored source metadata is kept separate from temporary preview/download URLs. */
export type MediaActionsSource = {
  readonly reference?: MediaReference;
  readonly name: string;
  readonly mimeType: string;
} & (
  | { readonly uri: string }
  | {
      readonly environmentId: EnvironmentId;
      readonly threadId: ThreadId;
      readonly resource: AssetResource;
    }
);

export function useMediaActions(source: MediaActionsSource | undefined, onOpenFile?: () => void) {
  const navigation = useNavigation();
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
      const uri = "uri" in source ? normalizeNativeMarkdownUrl(source.uri) : await refresh();
      if (request.signal.aborted) return;
      if (uri === null) throw new Error("The file could not be loaded. Reconnect and try again.");
      const input = {
        attachment: { name: source.name, mimeType: source.mimeType },
        signal: request.signal,
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
  const actions: { id: string; title: string; run: () => void; disabled?: boolean }[] = source
    ? [
        ...(reference?.kind === "file"
          ? [
              {
                id: "copy-path",
                title: "Copy full path",
                run: () => copyTextWithHaptic(reference.path),
              },
              ...(reference.relativePath
                ? [
                    {
                      id: "copy-relative-path",
                      title: "Copy relative path",
                      run: () => copyTextWithHaptic(reference.relativePath!),
                    },
                  ]
                : []),
              ...(reference.relativePath && source && "environmentId" in source
                ? [
                    {
                      id: "open-file",
                      title: "Open in file viewer",
                      run: () => {
                        onOpenFile?.();
                        navigation.navigate("ThreadFile", {
                          environmentId: String(source.environmentId),
                          threadId: String(source.threadId),
                          path: reference.relativePath!.split("/"),
                        });
                      },
                    },
                  ]
                : []),
            ]
          : reference
            ? [{ id: "copy-url", title: "Copy URL", run: () => copyTextWithHaptic(reference.url) }]
            : []),
        {
          id: "share",
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
