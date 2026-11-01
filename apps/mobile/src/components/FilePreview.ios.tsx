import * as Dialog from "./ui/Dialog";
import { requireNativeModule } from "expo";
import { Image } from "expo-image";
import { useEffect, useEffectEvent, useId } from "react";

import type { ResolvedFilePreviewSource } from "./FilePreviewModal.types";

/** Quick Look copies a local file instead of downloading the image a second time. */
async function cachedImageUri(
  item: Pick<ResolvedFilePreviewSource, "uri" | "imageCacheKey">,
): Promise<string> {
  if (item.imageCacheKey === undefined) return item.uri;
  const path = await Image.getCachePathAsync(item.imageCacheKey).catch(() => null);
  return path ? `file://${encodeURI(path)}` : item.uri;
}

const NativeControls = requireNativeModule<{
  presentFile(
    uri: string,
    name: string,
    sourceIdentifier: string,
    identifier: string,
  ): Promise<void>;
  presentFiles(
    uris: readonly string[],
    names: readonly string[],
    selectedIndex: number,
    sourceIdentifiers: readonly string[],
    identifier: string,
  ): Promise<void>;
  dismissFile(identifier: string): Promise<void>;
}>("T3NativeControls");

function NativeFilePreview(props: {
  readonly source: ResolvedFilePreviewSource;
  readonly onRequestClose: () => void;
  readonly onOpenError?: (error: unknown) => void;
}) {
  const { uri, name, sourceIdentifier, imageCacheKey, gallery } = props.source;
  const identifier = useId();
  const onRequestClose = useEffectEvent(props.onRequestClose);
  const onOpenError = useEffectEvent((error: unknown) => {
    if (props.onOpenError) props.onOpenError(error);
    else Dialog.alert("Could not open preview", "The file could not be loaded. Please try again.");
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- presents the native file preview and dismisses it on cleanup
  useEffect(() => {
    let canceled = false;
    const items = gallery && gallery.length > 1 ? gallery : [{ uri, imageCacheKey }];
    const present = (uris: readonly string[]) =>
      gallery && gallery.length > 1
        ? NativeControls.presentFiles(
            uris,
            gallery.map((item) => item.name ?? "Preview"),
            Math.max(
              0,
              gallery.findIndex((item) => item.uri === uri),
            ),
            gallery.map((item) => item.sourceIdentifier ?? ""),
            identifier,
          )
        : NativeControls.presentFile(
            uris[0]!,
            name ?? "Preview",
            sourceIdentifier ?? "",
            identifier,
          );
    const presentation = Promise.all(items.map(cachedImageUri)).then((uris) => {
      if (canceled) return;
      return present(uris).catch((error: unknown) => {
        // expo-image can evict a cached file before native copies it; the remote URL still works.
        if (canceled || uris.every((cached, index) => cached === items[index]!.uri)) throw error;
        return present(items.map((item) => item.uri));
      });
    });
    void presentation
      .catch((error: unknown) => {
        if (!canceled) onOpenError(error);
      })
      .finally(() => {
        if (!canceled) onRequestClose();
      });
    return () => {
      canceled = true;
      void NativeControls.dismissFile(identifier).catch(() => undefined);
    };
  }, [uri, name, sourceIdentifier, imageCacheKey, identifier, gallery]);

  return null;
}

export function FilePreview(props: {
  readonly source: ResolvedFilePreviewSource;
  readonly onRequestClose: () => void;
  readonly onOpenError?: (error: unknown) => void;
}) {
  return <NativeFilePreview {...props} />;
}
