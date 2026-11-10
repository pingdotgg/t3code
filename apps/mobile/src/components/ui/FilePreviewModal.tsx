import * as Dialog from "./Dialog";
import { requireNativeModule } from "expo";
import { useEffect, useEffectEvent, useId, useRef, useState } from "react";

import type {
  FilePreviewImage,
  FilePreviewModalProps,
  FilePreviewViewerProps,
} from "./FilePreviewModal.types";
import { FilePreviewSession } from "./FilePreviewSession";

export type {
  FilePreviewItem,
  FilePreviewSource,
  ResolvedFilePreviewSource,
} from "./FilePreviewModal.types";

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

function NativeFilePreview(props: FilePreviewViewerProps) {
  const identifier = useId();
  // Later URLs reach the open viewer through updateFile instead of presenting again.
  const [presented] = useState(props.source);
  const delivered = useRef<(string | null | undefined)[]>([]);
  const onRequestClose = useEffectEvent(props.onRequestClose);
  const onOpenError = useEffectEvent((error: unknown) => {
    if (props.onOpenError) {
      props.onOpenError(error);
      return;
    }
    Dialog.alert("Could not open preview", "The file could not be loaded. Please try again.");
    onRequestClose();
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- presents the native file preview and dismisses it on cleanup
  useEffect(() => {
    let canceled = false;
    // Images open while still loading; other files must download first so Quick Look can refuse them.
    // Native serializes Quick Look presents and buffers updateFile until this call is enqueued.
    const presentation =
      presented.kind === "image"
        ? (() => {
            const { images, selectedIndex } = presented;
            delivered.current = images.map((image) => image.uri);
            return NativeControls.presentFiles(
              images.map((image) => image.uri ?? null),
              images.map((image) => image.name ?? "Preview"),
              selectedIndex,
              images.map((image) => image.sourceIdentifier ?? ""),
              identifier,
            );
          })()
        : NativeControls.presentFile(
            presented.uri,
            presented.name ?? "Preview",
            presented.sourceIdentifier ?? "",
            identifier,
          );

    void (async () => {
      try {
        await presentation;
        if (!canceled) onRequestClose();
      } catch (error: unknown) {
        // Custom handlers own dismissal so Cancel / Try again can keep the modal mounted.
        if (!canceled) onOpenError(error);
      }
    })();

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

/** Shows images, PDFs and documents full screen in the native viewer (Android: FilePreviewModal.android.tsx). */
export function FilePreviewModal(props: FilePreviewModalProps) {
  return <FilePreviewSession {...props} progressiveGallery Viewer={NativeFilePreview} />;
}
