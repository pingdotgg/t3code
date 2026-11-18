import { useGT } from "gt-react-native";
import { useState } from "react";
import { View } from "react-native";
import { WebView } from "react-native-webview";

import { FilePreviewLoading, FilePreviewNotice } from "../features/files/FilePreviewFeedback";
import { PdfAppearance } from "./PdfAppearance";
import { webViewDecelerationRate } from "../lib/webViewDecelerationRate";

export function PdfPreview(props: { readonly uri: string }) {
  const gt = useGT();
  const [error, setError] = useState<string | null>(null);
  return (
    <View className="flex-1 bg-card">
      {error ? (
        <FilePreviewNotice title={gt("Could not load PDF")}>{error}</FilePreviewNotice>
      ) : null}
      <PdfAppearance key={props.uri}>
        <WebView
          source={{ uri: props.uri }}
          originWhitelist={["*"]}
          automaticallyAdjustContentInsets={false}
          decelerationRate={webViewDecelerationRate}
          contentInsetAdjustmentBehavior="never"
          startInLoadingState
          onError={(event) =>
            setError(event.nativeEvent.description || gt("The PDF could not be loaded."))
          }
          onHttpError={(event) =>
            setError(
              gt("The server returned HTTP {statusCode}.", {
                statusCode: event.nativeEvent.statusCode,
              }),
            )
          }
          renderLoading={() => (
            <FilePreviewLoading message={gt("Loading PDF...")} background="card" />
          )}
          style={{ flex: 1, backgroundColor: "transparent" }}
        />
      </PdfAppearance>
    </View>
  );
}
