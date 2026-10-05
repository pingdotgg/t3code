import deviceStreamScript from "@t3tools/mobile-device-stream";
import {
  useEffect,
  useEffectEvent,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Ref,
} from "react";
import { ActivityIndicator, Platform, Pressable, View } from "react-native";
import { WebView } from "react-native-webview";
import type { DeviceStreamStatus } from "@t3tools/client-runtime/device/stream";

import { AppText } from "../../components/AppText";

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
  const processRetried = useRef(false);
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
      onRetry={() => {
        processRetried.current = false;
        setAttempt((attempt) => attempt + 1);
        void props.onUnauthorized();
      }}
      onStreaming={() => {
        processRetried.current = false;
      }}
      onRecoverProcess={() => {
        if (processRetried.current) return false;
        processRetried.current = true;
        setAttempt((attempt) => attempt + 1);
        void props.onUnauthorized();
        return true;
      }}
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
  onStreaming,
  onRecoverProcess,
}: NativeStreamBridge & {
  readonly configuration: string;
  readonly background: string;
  readonly onRetry: () => void;
  readonly onStreaming: () => void;
  readonly onRecoverProcess: () => boolean;
}) {
  const webView = useRef<WebView<object>>(null);
  const active = useRef(true);
  const failed = useRef(false);
  const [status, setStatus] = useState<DeviceStreamStatus>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState(false);
  const fail = (message: string) => {
    if (!active.current || failed.current) return;
    failed.current = true;
    void onInputConnected(false);
    webView.current?.injectJavaScript("window.T3DeviceStream?.stop(); true;");
    setError(message);
    setStatus("error");
  };
  // The shared transport owns video timeouts once the document acknowledges startup.
  const bootstrapTimedOut = useEffectEvent(() =>
    fail("Device viewer could not start. Reconnect to try again."),
  );
  useEffect(() => {
    if (started) return;
    const timer = setTimeout(bootstrapTimedOut, 15_000);
    return () => clearTimeout(timer);
  }, [started]);
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
  const resetInput = useEffectEvent(() => void onInputConnected(false));
  useLayoutEffect(() => {
    active.current = true;
    resetInput();
    const view = webView.current;
    return () => {
      active.current = false;
      view?.injectJavaScript("window.T3DeviceStream?.stop(); true;");
    };
  }, []);
  const processTerminated = () => {
    if (!active.current || failed.current) return;
    void onInputConnected(false);
    if (!onRecoverProcess()) fail("Device viewer stopped. Reconnect to try again.");
  };
  return (
    <View className="flex-1" style={{ backgroundColor: background }}>
      <WebView<object>
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
        onError={() => fail("Device viewer could not load. Reconnect to try again.")}
        onHttpError={() => fail("Device viewer could not load. Reconnect to try again.")}
        onContentProcessDidTerminate={processTerminated}
        onRenderProcessGone={processTerminated}
        onShouldStartLoadWithRequest={(request) =>
          request.url === "about:blank" || request.url === source.baseUrl
        }
        onMessage={(event) => {
          if (!active.current || failed.current) return;
          const message = deviceStreamMessage(event.nativeEvent.data);
          if (message?.type === "unauthorized") void onUnauthorized();
          else if (message?.type === "input") void onInputConnected(message.connected);
          else if (message?.type === "retry") onRetry();
          else if (message?.type === "status") {
            setStarted(true);
            if (message.status === "error") fail(message.detail ?? "Device stream failed.");
            else {
              setStatus(message.status);
              if (message.status === "streaming") onStreaming();
            }
          }
        }}
      />
      {status !== "streaming" ? (
        <View
          className="absolute inset-0 items-center justify-center gap-4 px-6"
          style={{ backgroundColor: background }}
        >
          {status === "connecting" ? <ActivityIndicator colorClassName="accent-icon" /> : null}
          <AppText
            accessibilityLiveRegion="polite"
            className="text-center text-sm text-foreground-muted"
          >
            {status === "error" ? error : "Connecting to device..."}
          </AppText>
          {status === "error" ? (
            <Pressable
              accessibilityRole="button"
              className="rounded-full border border-secondary-border bg-secondary px-6 py-3"
              onPress={onRetry}
            >
              <AppText className="text-secondary-foreground">Reconnect</AppText>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
