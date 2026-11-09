import { Button } from "./Button";
import * as Dialog from "./Dialog";
import { createContext, useContext, useEffect, useEffectEvent, useState } from "react";
import { Modal, View } from "react-native";
import ImageViewing from "react-native-image-viewing";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { openAttachmentInViewer } from "../../lib/attachmentDownload";
import { useMediaActions } from "../../state/mediaActions";
import type {
  FilePreviewImages,
  FilePreviewModalProps,
  FilePreviewViewerProps,
  ResolvedFilePreviewDocument,
} from "./FilePreviewModal.types";
import { FilePreviewSession } from "./FilePreviewSession";
import { imageViewingProps } from "./mediaImageViewingProps";
import { MediaPreviewHeader } from "../MediaPreviewHeader";

export type {
  FilePreviewItem,
  FilePreviewSource,
  ResolvedFilePreviewSource,
} from "./FilePreviewModal.types";
import { PdfPreview } from "../PdfPreview";
import { SheetHeader } from "./SheetHeader";
import { AppText as Text } from "./AppText";

function PdfDocumentPreview(props: {
  readonly source: ResolvedFilePreviewDocument;
  readonly onRequestClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const media = useMediaActions(props.source.actionsSource);
  const save = media.actions.find((action) => action.id === "save");
  return (
    <Modal
      animationType="slide"
      onRequestClose={props.onRequestClose}
      statusBarTranslucent
      navigationBarTranslucent
    >
      <View
        className="flex-1 bg-card"
        style={{ paddingTop: insets.top, paddingBottom: insets.bottom }}
      >
        <SheetHeader
          presentation="inline"
          title={props.source.name ?? "PDF"}
          onClose={props.onRequestClose}
          actions={
            save
              ? [
                  {
                    accessibilityLabel: "Save or share",
                    icon: "square.and.arrow.up",
                    disabled: save.disabled,
                    loading: media.sharing,
                    onPress: () => void save.run(),
                  },
                ]
              : []
          }
        />
        <PdfPreview uri={props.source.uri} />
      </View>
    </Modal>
  );
}

function DocumentPreview(props: {
  readonly source: ResolvedFilePreviewDocument;
  readonly onRequestClose: () => void;
  readonly onOpenError?: (error: unknown) => void;
}) {
  const { uri, name } = props.source;
  const onRequestClose = useEffectEvent(props.onRequestClose);
  const onOpenError = useEffectEvent((error: unknown) => {
    if (props.onOpenError) props.onOpenError(error);
    else
      Dialog.alert(
        "Could not open document",
        "A compatible viewer must be installed. Check your connection and try again.",
      );
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- opens the attachment in an external viewer and aborts the open on cleanup
  useEffect(() => {
    const controller = new AbortController();
    const input = {
      uri,
      attachment: {
        name: name ?? "Document",
        mimeType:
          props.source.mimeType ??
          (props.source.kind === "pdf" ? "application/pdf" : "application/octet-stream"),
      },
      signal: controller.signal,
    };
    const opened = openAttachmentInViewer(input);
    void opened
      .catch((error: unknown) => {
        if (!controller.signal.aborted) onOpenError(error);
      })
      .finally(() => {
        if (!controller.signal.aborted) onRequestClose();
      });
    return () => controller.abort();
  }, [uri, name, props.source.mimeType, props.source.kind]);
  return (
    <Modal transparent animationType="fade" onRequestClose={props.onRequestClose}>
      <View className="flex-1 items-center justify-center bg-backdrop p-6">
        <View className="w-full max-w-sm gap-4 rounded-2xl bg-sheet-solid p-6">
          <Text className="font-t3-semibold text-foreground">Opening document…</Text>
          <Text className="text-foreground-muted" numberOfLines={2}>
            {name ?? "Document"}
          </Text>
          <View className="items-end">
            <Button label="Cancel" tone="text" onPress={props.onRequestClose} />
          </View>
        </View>
      </View>
    </Modal>
  );
}

type ImagePreviewProps = {
  readonly source: FilePreviewImages;
  readonly onRequestClose: () => void;
};

const ImagePreviewContext = createContext<ImagePreviewProps | null>(null);

function ImagePreviewHeader(header: { readonly imageIndex: number }) {
  const props = useContext(ImagePreviewContext)!;
  const source = props.source.images[header.imageIndex];
  const insets = useSafeAreaInsets();
  const mediaActions = useMediaActions(source?.actionsSource, props.onRequestClose);
  return (
    <View className="bg-black/70" style={{ paddingTop: insets.top }}>
      <MediaPreviewHeader
        title={source?.failed ? "Couldn't load image" : (source?.name ?? "Image")}
        media={mediaActions}
        closeAccessibilityLabel="Close image"
        onClose={props.onRequestClose}
      />
    </View>
  );
}

function ImagePreview(props: ImagePreviewProps) {
  const [uriSources] = useState(() => new Map<string, { readonly uri: string }>());
  const [pendingSources] = useState(() => new Map<number, Record<string, never>>());
  return (
    <ImagePreviewContext value={props}>
      <ImageViewing
        {...imageViewingProps(props.source, uriSources, pendingSources)}
        visible
        presentationStyle="fullScreen"
        onRequestClose={props.onRequestClose}
        swipeToCloseEnabled={false}
        doubleTapToZoomEnabled
        HeaderComponent={ImagePreviewHeader}
      />
    </ImagePreviewContext>
  );
}

function AndroidFilePreview(props: FilePreviewViewerProps) {
  const { source } = props;
  if (source.kind === "pdf") return <PdfDocumentPreview {...props} source={source} />;
  if (source.kind !== "image") return <DocumentPreview {...props} source={source} />;
  return <ImagePreview source={source} onRequestClose={props.onRequestClose} />;
}

/** Shows images, PDFs and documents full screen. */
export function FilePreviewModal(props: FilePreviewModalProps) {
  return <FilePreviewSession {...props} progressiveGallery Viewer={AndroidFilePreview} />;
}
