import { Button } from "../../components/ui/Button";
import deviceStreamScript from "@t3tools/mobile-device-stream";
import {
  useEffectEvent,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type Ref,
} from "react";
import { decodeOptions, msg, useGT } from "gt-react-native";
import { Platform, View } from "react-native";
import { WebView } from "react-native-webview";
import type {
  DeviceHardwareButton,
  DeviceStreamStatus,
} from "@t3tools/client-runtime/device/stream";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText } from "../../components/ui/AppText";
import { m, type MessageResolver } from "../../i18n/messages";

import {
  deviceStreamBaseUrl,
  deviceStreamDocument,
  deviceStreamMessage,
  type DeviceStreamConfiguration,
} from "./device-stream-document";

/** Resolves a status detail the WebView left marked, including marked variables inside it. */
function streamDetailText(detail: string, resolve: MessageResolver): string {
  const options = decodeOptions(detail);
  if (typeof options?.$_source !== "string") return detail;
  const { $_source: source, ...variables } = options;
  return resolve(
    source,
    Object.fromEntries(
      Object.entries(variables).map(([key, value]) => [
        key,
        typeof value === "string" && !key.startsWith("$")
          ? streamDetailText(value, resolve)
          : value,
      ]),
    ),
  );
}

export interface DeviceStreamRef {
  pressButton: (button: DeviceHardwareButton) => void;
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
}: Omit<DeviceStreamConfiguration, "labels"> & NativeStreamBridge) {
  const gt = useGT();
  const [attempt, setAttempt] = useState(0);
  const processRetried = useRef(false);
  const configuration = JSON.stringify({
    access: props.access,
    platform: props.platform,
    deviceId: props.deviceId,
    ...(props.serveSimOnly ? { serveSimOnly: true } : {}),
    colors: props.colors,
    labels: {
      screen: props.platform === "ios" ? gt("iOS Simulator screen") : gt("Android Emulator screen"),
      reconnectingControls: gt("Reconnecting device controls..."),
    },
  } satisfies DeviceStreamConfiguration);
  return (
    <DeviceStreamDocumentView
      key={`${attempt}:${configuration}`}
      ref={ref}
      configuration={configuration}
      baseUrl={deviceStreamBaseUrl(Platform.OS, props.platform, props.access.httpBase)}
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
  baseUrl,
  background,
  onUnauthorized,
  onInputConnected,
  onRetry,
  onStreaming,
  onRecoverProcess,
}: NativeStreamBridge & {
  readonly configuration: string;
  readonly baseUrl: string;
  readonly background: string;
  readonly onRetry: () => void;
  readonly onStreaming: () => void;
  readonly onRecoverProcess: () => boolean;
}) {
  const webView = useRef<WebView<object>>(null);
  const gt = useGT();
  const active = useRef(false);
  const failed = useRef(false);
  const bootstrapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [status, setStatus] = useState<DeviceStreamStatus>("connecting");
  const [error, setError] = useState<string | null>(null);
  const clearBootstrapTimer = () => {
    if (bootstrapTimer.current === null) return;
    clearTimeout(bootstrapTimer.current);
    bootstrapTimer.current = null;
  };
  const fail = (message: string) => {
    if (!active.current || failed.current) return;
    failed.current = true;
    clearBootstrapTimer();
    void onInputConnected(false);
    webView.current?.injectJavaScript("window.T3DeviceStream?.stop(); true;");
    setError(message);
    setStatus("error");
  };
  const bootstrapTimedOut = useEffectEvent(() =>
    fail(m(msg("Device viewer could not start. Reconnect to try again."))),
  );
  const resetInput = useEffectEvent(() => void onInputConnected(false));
  // The stream lives exactly as long as this view.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- starts the bootstrap timeout and stops the WebView device stream when this view unmounts
  useLayoutEffect(() => {
    active.current = true;
    resetInput();
    const view = webView.current;
    bootstrapTimer.current = setTimeout(bootstrapTimedOut, 15_000);
    return () => {
      if (bootstrapTimer.current !== null) clearTimeout(bootstrapTimer.current);
      bootstrapTimer.current = null;
      active.current = false;
      view?.injectJavaScript("window.T3DeviceStream?.stop(); true;");
      resetInput();
    };
  }, []);
  const source = {
    html: deviceStreamDocument(
      configuration,
      deviceStreamScript,
      gt("Device viewer stopped unexpectedly."),
    ),
    baseUrl,
  };
  const command = (button: DeviceHardwareButton | "rotate") => {
    webView.current?.injectJavaScript(
      `window.T3DeviceStream?.command(${JSON.stringify(button)}); true;`,
    );
  };
  useImperativeHandle(ref, () => ({
    pressButton: command,
    rotate: () => command("rotate"),
  }));
  const processTerminated = () => {
    if (!active.current || failed.current) return;
    void onInputConnected(false);
    if (!onRecoverProcess()) fail(m(msg("Device viewer stopped. Reconnect to try again.")));
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
        onError={() => fail(m(msg("Device viewer could not load. Reconnect to try again.")))}
        onHttpError={() => fail(m(msg("Device viewer could not load. Reconnect to try again.")))}
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
            clearBootstrapTimer();
            if (message.status === "error")
              fail(
                message.detail === undefined
                  ? m(msg("Device stream failed."))
                  : streamDetailText(message.detail, m),
              );
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
          {status === "connecting" ? <AppActivityIndicator colorClassName="accent-icon" /> : null}
          <AppText
            accessibilityLiveRegion="polite"
            className="text-center text-sm text-foreground-muted"
          >
            {status === "error" ? error : gt("Connecting to device...")}
          </AppText>
          {status === "error" ? (
            <View className="items-center">
              <Button label={gt("Reconnect")} tone="secondary" onPress={onRetry} />
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
