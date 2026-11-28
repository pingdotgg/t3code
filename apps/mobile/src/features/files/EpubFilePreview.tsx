import { epubPreviewUrl } from "@t3tools/shared/filePreview";
import { useGT } from "gt-react-native";
import { useState } from "react";
import { View } from "react-native";
import { WebView } from "react-native-webview";
import { useContentBottomInset, useContentTopInset } from "../../components/ui/useBarInset";
import { tryOpenWebLink } from "../../lib/openExternalUrl";
import { FilePreviewLoading, FilePreviewNotice } from "./FilePreviewFeedback";

export function EpubFilePreview(props: { readonly uri: string | null; readonly name: string }) {
  const gt = useGT();
  const header = useContentTopInset();
  const bottom = useContentBottomInset();
  const url = props.uri ? epubPreviewUrl(props.uri, props.name) : null;
  const [failed, setFailed] = useState(false);
  if (!props.uri) return <FilePreviewLoading message={gt("Loading file...")} />;
  if (!url || failed) {
    return (
      <View className="flex-1 bg-sheet" style={{ paddingTop: header }}>
        <FilePreviewNotice title={gt("No preview for this file")}>
          {gt("The file could not be rendered.")}
        </FilePreviewNotice>
      </View>
    );
  }
  const page = url.split("#", 1)[0];
  return (
    <View
      className="flex-1 bg-sheet"
      style={{ flex: 1, paddingTop: header, paddingBottom: bottom }}
    >
      <WebView
        source={{ uri: url }}
        originWhitelist={["*"]}
        accessibilityLabel={props.name}
        allowsInlineMediaPlayback
        mediaPlaybackRequiresUserAction
        allowFileAccess={false}
        mixedContentMode="never"
        textZoom={100}
        injectedJavaScript={
          'window.ReactNativeWebView.postMessage(document.getElementById("t3-epub-preview") ? "ready" : "unavailable"); true;'
        }
        onMessage={(event) => {
          if (event.nativeEvent.data === "unavailable") setFailed(true);
        }}
        onShouldStartLoadWithRequest={(request) =>
          request.url === "about:srcdoc" ||
          request.url === "about:blank" ||
          request.url.split("#", 1)[0] === page
        }
        onOpenWindow={(event) => {
          void tryOpenWebLink(event.nativeEvent.targetUrl, "file-preview");
        }}
        onError={() => setFailed(true)}
        onHttpError={(event) => {
          if (event.nativeEvent.url.split("#", 1)[0] === page) setFailed(true);
        }}
        startInLoadingState
        renderLoading={() => <FilePreviewLoading message={gt("Loading file...")} />}
        style={{ flex: 1, backgroundColor: "transparent" }}
      />
    </View>
  );
}
