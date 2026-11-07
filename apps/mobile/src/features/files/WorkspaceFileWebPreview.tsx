import { useState } from "react";
import { View } from "react-native";
import { WebView } from "react-native-webview";
import { SafeAreaView } from "react-native-safe-area-context";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText as Text } from "../../components/ui/AppText";
import { FilePreviewLoading } from "./FilePreviewFeedback";
import { LoadingStrip } from "../../components/ui/LoadingStrip";
import { PdfPreview } from "../../components/PdfPreview";
import { ControlPill } from "../../components/ui/ControlPill";
import { useHardwareBack } from "../../lib/backHandler";
import { isPdfPreviewUri } from "../../lib/pdfPreview";
import { useContentTopInset } from "../../components/ui/useBarInset";

export function WorkspaceFileWebPreview(props: { readonly uri: string | null }) {
  if (props.uri === null) {
    return <FilePreviewLoading message="Preparing preview..." background="card" />;
  }
  return <DocumentWebPreview key={props.uri} uri={props.uri} />;
}

function DocumentWebPreview(props: { readonly uri: string }) {
  const headerInset = useContentTopInset();
  const [loadProgress, setLoadProgress] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [linkedPdf, setLinkedPdf] = useState<string | null>(null);

  useHardwareBack(linkedPdf !== null, () => {
    setLinkedPdf(null);
    return true;
  });

  if (isPdfPreviewUri(props.uri)) {
    return (
      <View className="flex-1" style={{ paddingTop: headerInset }}>
        <PdfPreview uri={props.uri} />
      </View>
    );
  }

  return (
    <View className="relative flex-1 bg-card">
      {linkedPdf ? (
        <View className="flex-1" style={{ paddingTop: headerInset }}>
          <PdfPreview key={linkedPdf} uri={linkedPdf} />
          <SafeAreaView edges={["bottom"]} className="border-t border-border px-4 py-2">
            <ControlPill
              label="Back to document"
              variant="pill"
              onPress={() => setLinkedPdf(null)}
            />
          </SafeAreaView>
        </View>
      ) : null}
      <View className="flex-1" style={linkedPdf ? { display: "none" } : undefined}>
        <WebView
          source={{ uri: props.uri }}
          // react-native-webview defaults to "never", which starts the page under the header.
          contentInsetAdjustmentBehavior="automatic"
          originWhitelist={["*"]}
          allowsBackForwardNavigationGestures
          allowsFullscreenVideo
          allowsInlineMediaPlayback
          setSupportMultipleWindows={false}
          onShouldStartLoadWithRequest={(request) => {
            if (request.isTopFrame !== false && isPdfPreviewUri(request.url)) {
              setLinkedPdf(request.url);
              return false;
            }
            return true;
          }}
          startInLoadingState
          onLoadProgress={(event) => {
            setLoadProgress(event.nativeEvent.progress);
          }}
          onLoadStart={() => {
            setLoadProgress(0.05);
            setLoadError(null);
          }}
          onLoadEnd={() => {
            setLoadProgress(0);
          }}
          onError={(event) => {
            setLoadProgress(0);
            setLoadError(event.nativeEvent.description || "The file could not be rendered.");
          }}
          renderLoading={() => (
            <View className="absolute inset-0 items-center justify-center bg-card">
              <AppActivityIndicator />
            </View>
          )}
          style={{ flex: 1, backgroundColor: "transparent" }}
        />
        <View pointerEvents="box-none" className="absolute inset-x-0" style={{ top: headerInset }}>
          {loadProgress > 0 && loadProgress < 1 ? <LoadingStrip progress={loadProgress} /> : null}
          {loadError ? (
            <View className="border-b border-border bg-card px-4 py-2">
              <Text className="text-xs font-t3-bold text-foreground">Preview failed</Text>
              <Text className="mt-0.5 text-xs leading-snug text-foreground-muted">{loadError}</Text>
            </View>
          ) : null}
        </View>
      </View>
    </View>
  );
}
