import previewStreamScript from "@t3tools/mobile-preview-stream";
import type { PreviewStreamInput } from "@t3tools/client-runtime/preview/server-browser-stream";
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

import { AppText } from "../../components/AppText";

import {
  previewStreamDocument,
  previewStreamMessage,
  type PreviewStreamConfiguration,
} from "./preview-stream-document";

export interface PreviewStreamRef {
  /** `navigate`, `history`, and `reload` wait for the socket if it is not open yet. */
  readonly command: (input: PreviewStreamInput) => void;
  readonly togglePictureInPicture: () => void;
}

export interface PreviewPictureInPictureState {
  readonly supported: boolean;
  readonly active: boolean;
}

type NativeStreamBridge = {
  readonly ref?: Ref<PreviewStreamRef>;
  /** Refresh stream access; new access remounts the document with a fresh ticket. */
  readonly onUnauthorized: () => void;
  /** The tab was closed on the server. */
  readonly onGone?: () => void;
  readonly onViewport?: (viewport: { readonly width: number; readonly height: number }) => void;
  readonly onPictureInPicture?: (state: PreviewPictureInPictureState, detail?: string) => void;
  /** True while frames show, so commands reach the page. Pass a stable function. */
  readonly onStreamingChange?: (streaming: boolean) => void;
  /** The floating player shows a spinner without text or a reconnect button. */
  readonly compact?: boolean;
};

// Consecutive refused tickets before the view stops and offers Reconnect, e.g. a
// session without operate scope.
const MAX_REFUSALS = 3;

/** A server-hosted preview tab streamed into a WebView that runs the shared transport. */
export function PreviewStreamWebView({
  ref,
  ...props
}: PreviewStreamConfiguration & NativeStreamBridge) {
  const [attempt, setAttempt] = useState(0);
  const [previousAccess, setPreviousAccess] = useState(props.access);
  // Wait for refreshed access, including cookie credentials with unchanged JSON.
  if (props.access !== previousAccess) {
    setPreviousAccess(props.access);
    setAttempt((current) => current + 1);
  }
  const processRetried = useRef(false);
  const unauthorized = useRef(0);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (refreshTimer.current !== null) clearTimeout(refreshTimer.current);
    },
    [],
  );
  const configuration = JSON.stringify({
    access: props.access,
    threadId: props.threadId,
    tabId: props.tabId,
    interactive: props.interactive,
    background: props.background,
  } satisfies PreviewStreamConfiguration);
  return (
    <PreviewStreamDocumentView
      key={`${attempt}:${configuration}`}
      ref={ref}
      configuration={configuration}
      background={props.background}
      compact={props.compact ?? false}
      onGone={props.onGone}
      onViewport={props.onViewport}
      onPictureInPicture={props.onPictureInPicture}
      onStreamingChange={props.onStreamingChange}
      onUnauthorized={() => {
        // The client has stopped. Restart it with a fresh ticket, backing off between refusals.
        const refusals = ++unauthorized.current;
        if (refusals >= MAX_REFUSALS) return false;
        if (refreshTimer.current !== null) clearTimeout(refreshTimer.current);
        refreshTimer.current = setTimeout(
          () => {
            refreshTimer.current = null;
            props.onUnauthorized();
          },
          refusals === 1 ? 0 : 1_000 * 2 ** (refusals - 1),
        );
        return true;
      }}
      onRetry={() => {
        processRetried.current = false;
        unauthorized.current = 0;
        props.onUnauthorized();
      }}
      onStreaming={() => {
        processRetried.current = false;
        unauthorized.current = 0;
      }}
      onRecoverProcess={() => {
        if (processRetried.current) return false;
        processRetried.current = true;
        setAttempt((current) => current + 1);
        return true;
      }}
    />
  );
}

function PreviewStreamDocumentView({
  ref,
  configuration,
  background,
  compact,
  onUnauthorized,
  onGone,
  onViewport,
  onPictureInPicture,
  onStreamingChange,
  onRetry,
  onStreaming,
  onRecoverProcess,
}: Omit<NativeStreamBridge, "compact" | "onUnauthorized"> & {
  readonly configuration: string;
  readonly background: string;
  readonly compact: boolean;
  /** False when the view should stop retrying and fail. */
  readonly onUnauthorized: () => boolean;
  readonly onRetry: () => void;
  readonly onStreaming: () => void;
  readonly onRecoverProcess: () => boolean;
}) {
  const webView = useRef<WebView<object>>(null);
  const active = useRef(true);
  const failed = useRef(false);
  const [status, setStatus] = useState<"connecting" | "streaming" | "error">("connecting");
  const [error, setError] = useState<string | null>(null);
  const [gone, setGone] = useState(false);
  const [started, setStarted] = useState(false);
  const fail = (message: string) => {
    if (!active.current || failed.current) return;
    failed.current = true;
    webView.current?.injectJavaScript("window.T3PreviewStream?.stop(); true;");
    onStreamingChange?.(false);
    setError(message);
    setStatus("error");
  };
  // The shared transport owns reconnects once the document acknowledges startup.
  const bootstrapTimedOut = useEffectEvent(() =>
    fail("Browser viewer could not start. Reconnect to try again."),
  );
  useEffect(() => {
    if (started) return;
    const timer = setTimeout(bootstrapTimedOut, 15_000);
    return () => clearTimeout(timer);
  }, [started]);
  const source = useMemo(
    () => ({
      html: previewStreamDocument(configuration, previewStreamScript),
      baseUrl: Platform.OS === "android" ? "https://localhost/" : "file:///",
    }),
    [configuration],
  );
  useImperativeHandle(ref, () => ({
    command: (input) =>
      webView.current?.injectJavaScript(
        `window.T3PreviewStream?.command(${JSON.stringify(input)}); true;`,
      ),
    togglePictureInPicture: () =>
      webView.current?.injectJavaScript("window.T3PreviewStream?.pictureInPicture(); true;"),
  }));
  useLayoutEffect(() => {
    active.current = true;
    const view = webView.current;
    return () => {
      active.current = false;
      view?.injectJavaScript("window.T3PreviewStream?.stop(); true;");
    };
  }, []);
  useEffect(() => () => onStreamingChange?.(false), [onStreamingChange]);
  const processTerminated = () => {
    if (!active.current || failed.current) return;
    if (!onRecoverProcess()) fail("Browser viewer stopped. Reconnect to try again.");
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
        // Picture in picture plays the canvas as an inline muted video, started from native chrome.
        allowsInlineMediaPlayback
        allowsPictureInPictureMediaPlayback
        mediaPlaybackRequiresUserAction={false}
        style={{ flex: 1, backgroundColor: background }}
        onError={() => fail("Browser viewer could not load. Reconnect to try again.")}
        onHttpError={() => fail("Browser viewer could not load. Reconnect to try again.")}
        onContentProcessDidTerminate={processTerminated}
        onRenderProcessGone={processTerminated}
        onShouldStartLoadWithRequest={(request) =>
          request.url === "about:blank" || request.url === source.baseUrl
        }
        onMessage={(event) => {
          if (!active.current || failed.current) return;
          const message = previewStreamMessage(event.nativeEvent.data);
          if (message === null) return;
          switch (message.type) {
            case "unauthorized":
              if (!onUnauthorized()) {
                fail("This session can't open the browser stream. Reconnect to try again.");
              }
              return;
            case "gone":
              setGone(true);
              fail("This tab was closed.");
              onGone?.();
              return;
            case "viewport":
              onViewport?.(message);
              return;
            case "pictureInPicture":
              onPictureInPicture?.(message, message.detail);
              return;
            case "status":
              setStarted(true);
              if (message.status === "error") {
                fail(message.detail ?? "Browser stream failed.");
                return;
              }
              setStatus(message.status);
              onStreamingChange?.(message.status === "streaming");
              if (message.status === "streaming") onStreaming();
          }
        }}
      />
      {status !== "streaming" ? (
        <View
          className="absolute inset-0 items-center justify-center gap-4 px-6"
          style={{ backgroundColor: background }}
        >
          {status === "connecting" ? <ActivityIndicator colorClassName="accent-icon" /> : null}
          {compact ? null : (
            <AppText
              accessibilityLiveRegion="polite"
              className="text-center text-sm text-foreground-muted"
            >
              {status === "error" ? error : "Connecting to browser..."}
            </AppText>
          )}
          {status === "error" && !gone && !compact ? (
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
