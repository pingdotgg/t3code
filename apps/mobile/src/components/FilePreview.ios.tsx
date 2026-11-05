import * as Dialog from "./ui/Dialog";
import { requireNativeModule } from "expo";
import { useEffect, useEffectEvent, useId, useRef, useState } from "react";

import type { FilePreviewImage, ResolvedFilePreviewSource } from "./FilePreviewModal.types";

const NativeControls = requireNativeModule<{
  presentFile(
    uri: string,
    name: string,
    sourceIdentifier: string,
    identifier: string,
  ): Promise<void>;
  presentFiles(
    uris: readonly (string | null)[],
    names: readonly string[],
    selectedIndex: number,
    sourceIdentifiers: readonly string[],
    identifier: string,
  ): Promise<void>;
  updateFile(identifier: string, index: number, uri: string | null): Promise<void>;
  dismissFile(identifier: string): Promise<void>;
}>("T3NativeControls");

// Null tells the viewer an image failed; undefined means its URL has not arrived yet.
const nativeUri = (image: FilePreviewImage) => (image.failed ? null : image.uri);

function NativeFilePreview(props: {
  readonly source: ResolvedFilePreviewSource;
  readonly onRequestClose: () => void;
  readonly onOpenError?: (error: unknown) => void;
}) {
  const identifier = useId();
  // Later URLs reach the open viewer through updateFile instead of presenting again.
  const [presented] = useState(props.source);
  const delivered = useRef<(string | null | undefined)[]>([]);
  const onRequestClose = useEffectEvent(props.onRequestClose);
  const onOpenError = useEffectEvent((error: unknown) => {
    if (props.onOpenError) props.onOpenError(error);
    else Dialog.alert("Could not open preview", "The file could not be loaded. Please try again.");
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- presents the native file preview and dismisses it on cleanup
  useEffect(() => {
    let canceled = false;
    let presentation: Promise<void>;
    // Images open while still loading; other files must download first so Quick Look can refuse them.
    if (presented.kind === "image") {
      const { images, selectedIndex } = presented;
      delivered.current = images.map((image) => image.uri);
      presentation = NativeControls.presentFiles(
        images.map((image) => image.uri ?? null),
        images.map((image) => image.name ?? "Preview"),
        selectedIndex,
        images.map((image) => image.sourceIdentifier ?? ""),
        identifier,
      );
    } else {
      const { uri, name, sourceIdentifier } = presented;
      presentation = NativeControls.presentFile(
        uri,
        name ?? "Preview",
        sourceIdentifier ?? "",
        identifier,
      );
    }
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
  }, [presented, identifier]);

  const images = props.source.kind === "image" ? props.source.images : undefined;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- hands image URLs that resolve after opening to the native viewer
  useEffect(() => {
    images?.forEach((image, index) => {
      const uri = nativeUri(image);
      if (uri === undefined || delivered.current[index] === uri) return;
      delivered.current[index] = uri;
      void NativeControls.updateFile(identifier, index, uri).catch(() => undefined);
    });
  }, [images, identifier]);

  return null;
}

export function FilePreview(props: {
  readonly source: ResolvedFilePreviewSource;
  readonly onRequestClose: () => void;
  readonly onOpenError?: (error: unknown) => void;
}) {
  return <NativeFilePreview {...props} />;
}
