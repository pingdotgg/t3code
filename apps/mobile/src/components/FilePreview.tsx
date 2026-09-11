import { useEffect, useEffectEvent } from "react";
import { Alert } from "react-native";
import ImageViewing from "react-native-image-viewing";

import { downloadAndShareAttachment, shareLocalAttachment } from "../lib/attachmentDownload";
import type { ResolvedFilePreviewSource } from "./FilePreviewModal";
import { MediaImagePreview } from "./MediaImagePreview";

function PdfPreview(props: {
  readonly source: ResolvedFilePreviewSource;
  readonly onRequestClose: () => void;
}) {
  const { uri, name } = props.source;
  const onRequestClose = useEffectEvent(props.onRequestClose);
  useEffect(() => {
    const controller = new AbortController();
    const input = {
      attachment: { name: name ?? "Document.pdf", mimeType: "application/pdf" },
      signal: controller.signal,
    };
    // Android's system chooser supplies the installed PDF apps.
    const opened =
      uri.startsWith("file:") || uri.startsWith("content:")
        ? shareLocalAttachment({ ...input, uri })
        : downloadAndShareAttachment({ ...input, url: uri });
    void opened
      .catch(() => {
        if (!controller.signal.aborted) Alert.alert("Could not open PDF", "Please try again.");
      })
      .finally(() => {
        if (!controller.signal.aborted) onRequestClose();
      });
    return () => controller.abort();
  }, [uri, name]);
  return null;
}

export function FilePreview(props: {
  readonly source: ResolvedFilePreviewSource;
  readonly onRequestClose: () => void;
}) {
  if (props.source.kind === "pdf") return <PdfPreview {...props} />;
  if (props.source.actionsSource) return <MediaImagePreview {...props} />;
  return (
    <ImageViewing
      images={[{ uri: props.source.uri }]}
      imageIndex={0}
      visible
      onRequestClose={props.onRequestClose}
      swipeToCloseEnabled
      doubleTapToZoomEnabled
    />
  );
}
