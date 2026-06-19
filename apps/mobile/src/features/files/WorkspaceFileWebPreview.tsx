import { useState } from "react";
import { ActivityIndicator, View } from "react-native";
import { WebView } from "react-native-webview";

import { AppText as Text } from "../../components/AppText";
import { LoadingStrip } from "../../components/LoadingStrip";

export function WorkspaceFileWebPreview(props: { readonly uri: string | null }) {
  const [loadProgress, setLoadProgress] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);

  if (props.uri === null) {
    return (
      <View className="flex-1 items-center justify-center gap-3 bg-card px-6">
        <ActivityIndicator />
        <Text className="text-center text-[13px] text-foreground-muted">Preparing preview...</Text>
      </View>
    );
  }

  return (
    <View className="relative flex-1 bg-card">
      {loadProgress > 0 && loadProgress < 1 ? <LoadingStrip progress={loadProgress} /> : null}
      {loadError ? (
        <View className="border-b border-border bg-card px-4 py-2">
          <Text className="text-[12px] font-t3-bold text-foreground">Preview failed</Text>
          <Text className="mt-0.5 text-[12px] leading-[17px] text-foreground-muted">
            {loadError}
          </Text>
        </View>
      ) : null}
      <WebView
        source={{ uri: props.uri }}
        originWhitelist={["*"]}
        allowsBackForwardNavigationGestures
        allowsFullscreenVideo
        setSupportMultipleWindows={false}
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
            <ActivityIndicator />
          </View>
        )}
        style={{ flex: 1, backgroundColor: "transparent" }}
      />
    </View>
  );
}
