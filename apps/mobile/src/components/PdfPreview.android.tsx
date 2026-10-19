import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import Pdf from "react-native-pdf-jsi";

import { FilePreviewLoading, FilePreviewNotice } from "../features/files/FilePreviewFeedback";
import { pdfInitialPage, pdfLinkUrl, preparePdfPreview } from "../lib/pdfPreview";
import { tryOpenExternalUrl } from "../lib/openExternalUrl";
import { ControlPill } from "./ui/ControlPill";

function NativePdfPreview(props: { readonly uri: string; readonly onRetry: () => void }) {
  const [localUri, setLocalUri] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cached = useRef<Awaited<ReturnType<typeof preparePdfPreview>>>(null);

  useEffect(() => {
    const controller = new AbortController();
    void preparePdfPreview(props.uri, controller.signal)
      .then((file) => {
        if (controller.signal.aborted) file?.dispose();
        else {
          cached.current = file;
          setLocalUri(file?.uri ?? null);
        }
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) {
          setError(cause instanceof Error ? cause.message : "The PDF could not be loaded.");
        }
      });
    return () => {
      controller.abort();
      cached.current?.dispose();
      cached.current = null;
    };
  }, [props.uri]);

  if (error) {
    return (
      <View className="flex-1 gap-4 bg-card">
        <FilePreviewNotice title="Could not load PDF">{error}</FilePreviewNotice>
        <View className="items-center">
          <ControlPill label="Try again" variant="pill" onPress={props.onRetry} />
        </View>
      </View>
    );
  }
  if (localUri === null) return <FilePreviewLoading message="Loading PDF..." background="card" />;

  return (
    <Pdf
      source={{ uri: localUri }}
      page={pdfInitialPage(props.uri)}
      fitPolicy={0}
      trustAllCerts={false}
      enableAnnotationRendering
      enableDoubleTapZoom
      onPressLink={(href) => {
        const url = pdfLinkUrl(href, props.uri);
        if (url !== null) void tryOpenExternalUrl(url, "file-preview");
      }}
      onError={() => {
        cached.current?.dispose();
        cached.current = null;
        setError("The PDF could not be rendered. It may be damaged or password protected.");
      }}
      style={{ flex: 1, width: "100%" }}
    />
  );
}

export function PdfPreview(props: { readonly uri: string }) {
  const [attempt, setAttempt] = useState(0);
  return (
    <NativePdfPreview
      key={`${props.uri}:${attempt}`}
      uri={props.uri}
      onRetry={() => setAttempt((value) => value + 1)}
    />
  );
}
