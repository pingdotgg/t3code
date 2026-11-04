import * as Dialog from "./ui/Dialog";
import { requireNativeModule } from "expo";
import { useEffect, useEffectEvent, useId } from "react";

import type { ResolvedFilePreviewSource } from "./FilePreviewModal.types";

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
  const { uri, name, sourceIdentifier, gallery } = props.source;
  const identifier = useId();
  const onRequestClose = useEffectEvent(props.onRequestClose);
  const onOpenError = useEffectEvent((error: unknown) => {
    if (props.onOpenError) props.onOpenError(error);
    else Dialog.alert("Could not open preview", "The file could not be loaded. Please try again.");
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- presents the native file preview and dismisses it on cleanup
  useEffect(() => {
    let canceled = false;
    const presentation =
      gallery && gallery.length > 1
        ? NativeControls.presentFiles(
            gallery.map((item) => item.uri),
            gallery.map((item) => item.name ?? "Preview"),
            Math.max(
              0,
              gallery.findIndex((item) => item.uri === uri),
            ),
            gallery.map((item) => item.sourceIdentifier ?? ""),
            identifier,
          )
        : NativeControls.presentFile(uri, name ?? "Preview", sourceIdentifier ?? "", identifier);
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
  }, [uri, name, sourceIdentifier, identifier, gallery]);

  return null;
}

export function FilePreview(props: {
  readonly source: ResolvedFilePreviewSource;
  readonly onRequestClose: () => void;
  readonly onOpenError?: (error: unknown) => void;
}) {
  return <NativeFilePreview {...props} />;
}
