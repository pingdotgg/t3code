import deviceStreamScript from "@t3tools/mobile-device-stream";
import { useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type Ref } from "react";
import { Platform } from "react-native";
import { WebView } from "react-native-webview";

import {
  deviceStreamDocument,
  deviceStreamMessage,
  type DeviceStreamConfiguration,
} from "./device-stream-document";

export interface DeviceStreamRef {
  home: () => void;
  back: () => void;
  appSwitcher: () => void;
  rotate: () => void;
}

type NativeStreamBridge = {
  readonly ref?: Ref<DeviceStreamRef>;
  readonly onUnauthorized: () => Promise<void>;
  readonly onInputConnected: (connected: boolean) => Promise<void>;
};

export function DeviceStreamWebView({
  ref,
  ...props
}: DeviceStreamConfiguration & NativeStreamBridge) {
  const [attempt, setAttempt] = useState(0);
  const configuration = JSON.stringify({
    access: props.access,
    platform: props.platform,
    deviceId: props.deviceId,
    colors: props.colors,
  });
  return (
    <DeviceStreamDocumentView
      key={`${attempt}:${configuration}`}
      ref={ref}
      configuration={configuration}
      background={props.colors.background}
      onUnauthorized={props.onUnauthorized}
      onInputConnected={props.onInputConnected}
      onRetry={() => setAttempt((attempt) => attempt + 1)}
    />
  );
}

function DeviceStreamDocumentView({
  ref,
  configuration,
  background,
  onUnauthorized,
  onInputConnected,
  onRetry,
}: NativeStreamBridge & {
  readonly configuration: string;
  readonly background: string;
  readonly onRetry: () => void;
}) {
  const webView = useRef<WebView>(null);
  const source = useMemo(
    () => ({
      html: deviceStreamDocument(configuration, deviceStreamScript),
      // Android WebCodecs needs a secure document; streams still use the environment's URLs.
      baseUrl: Platform.OS === "android" ? "https://localhost/" : "file:///",
    }),
    [configuration],
  );
  const command = (button: keyof DeviceStreamRef) => {
    webView.current?.injectJavaScript(
      `window.T3DeviceStream?.command(${JSON.stringify(button)}); true;`,
    );
  };
  useImperativeHandle(ref, () => ({
    home: () => command("home"),
    back: () => command("back"),
    appSwitcher: () => command("appSwitcher"),
    rotate: () => command("rotate"),
  }));
  useLayoutEffect(() => {
    const view = webView.current;
    return () => view?.injectJavaScript("window.T3DeviceStream?.stop(); true;");
  }, []);
  return (
    <WebView
      ref={webView}
      source={source}
      originWhitelist={["*"]}
      scrollEnabled={false}
      bounces={false}
      mixedContentMode="always"
      allowUniversalAccessFromFileURLs
      contentInsetAdjustmentBehavior="never"
      setSupportMultipleWindows={false}
      style={{ flex: 1, backgroundColor: background }}
      onLoadStart={() => void onInputConnected(false)}
      onShouldStartLoadWithRequest={(request) =>
        request.url === "about:blank" || request.url === source.baseUrl
      }
      onMessage={(event) => {
        const message = deviceStreamMessage(event.nativeEvent.data);
        if (message?.type === "unauthorized") void onUnauthorized();
        else if (message?.type === "input") void onInputConnected(message.connected);
        else if (message?.type === "retry") onRetry();
      }}
    />
  );
}
