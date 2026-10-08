import { useState } from "react";
import { View } from "react-native";
import WebView from "react-native-webview";
import { sharedLocationMapPreviewUrl } from "@t3tools/shared/sharedLocation";

import { AppText } from "./AppText";
import type { LocationMapPreviewProps } from "./LocationMapPreview.types";

export function LocationMapPreview(props: LocationMapPreviewProps) {
  return <MapPreview key={`${props.location.latitude}:${props.location.longitude}`} {...props} />;
}

function MapPreview({ location }: LocationMapPreviewProps) {
  const uri = sharedLocationMapPreviewUrl(location);
  const [status, setStatus] = useState<"loading" | "ready" | "error">(uri ? "loading" : "error");
  return (
    <View
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      className="relative h-[160px] overflow-hidden rounded-xl bg-subtle"
    >
      {uri ? (
        <WebView
          source={{ uri }}
          style={{ width: "100%", height: "100%" }}
          scrollEnabled={false}
          setSupportMultipleWindows={false}
          onShouldStartLoadWithRequest={(request) =>
            request.url === uri || request.url === "about:blank"
          }
          onLoad={() => setStatus("ready")}
          onError={() => setStatus("error")}
          onHttpError={() => setStatus("error")}
        />
      ) : null}
      {status !== "ready" ? (
        <View className="absolute inset-0 items-center justify-center bg-subtle">
          <AppText className="text-xs text-foreground-secondary">
            {status === "loading" ? "Loading map…" : "Map preview unavailable"}
          </AppText>
        </View>
      ) : null}
    </View>
  );
}
