import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import {
  ActivityIndicator,
  Platform,
  View,
  type LayoutChangeEvent,
  type View as NativeView,
} from "react-native";
import { WebView, type WebViewMessageEvent, type WebViewNavigation } from "react-native-webview";

import { AppText as Text } from "../../components/AppText";
import { LoadingStrip } from "../../components/LoadingStrip";
import { uuidv4 } from "../../lib/uuid";
import type { PreviewSnapshotMarkupSeed } from "./previewReviewModel";
import { createPreviewSnapshotMarkupSeed } from "./previewReviewModel";
import { captureMobilePreviewPng } from "./mobilePreviewCapture";
import {
  decodeMobilePreviewDomErrorMessage,
  decodeMobilePreviewDomMessage,
  mobilePreviewDomCaptureScript,
  type MobilePreviewDomFrame,
} from "./mobilePreviewDomBridge";
import { mobilePreviewAnnotationUrl } from "./mobilePreviewSourceUrl";

const DOM_CAPTURE_TIMEOUT_MS = 5_000;

export interface MobileLivePreviewNavigation {
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly title: string;
  readonly url: string;
}

export interface MobileLivePreviewHandle {
  readonly captureForMarkup: () => Promise<PreviewSnapshotMarkupSeed>;
  readonly goBack: () => void;
  readonly goForward: () => void;
  readonly reload: () => void;
}

interface PendingDomCapture {
  readonly generation: number;
  readonly reject: (cause: Error) => void;
  readonly requestId: string;
  readonly resolve: (capture: MobilePreviewDomCapture) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
}

interface MobilePreviewDomCapture {
  readonly frame: MobilePreviewDomFrame;
  readonly generation: number;
}

export const MobileLivePreview = forwardRef<
  MobileLivePreviewHandle,
  {
    readonly annotationSourceUrl: string;
    readonly isolatedSession: boolean;
    readonly uri: string;
    readonly onGatewayExpired?: () => void;
    readonly onNavigationChange?: (navigation: MobileLivePreviewNavigation) => void;
    readonly onReadyChange?: (ready: boolean) => void;
  }
>(function MobileLivePreview(props, forwardedRef) {
  const webViewRef = useRef<WebView>(null);
  const captureViewRef = useRef<NativeView>(null);
  const pendingDomCaptureRef = useRef<PendingDomCapture | null>(null);
  const navigationGenerationRef = useRef(0);
  const mountedRef = useRef(true);
  const readyRef = useRef(false);
  const onReadyChangeRef = useRef(props.onReadyChange);
  const layoutRef = useRef({ width: 0, height: 0 });
  const captureInProgressRef = useRef(false);
  const gatewayExpiredRef = useRef(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [captureInProgress, setCaptureInProgress] = useState(false);
  // Android's RN WebView incognito mode clears the process-wide cookie jar.
  // Gateway previews are iOS-only, and this guard keeps that invariant safe if
  // the component is reused elsewhere.
  const useIncognitoCookieStore = props.isolatedSession && Platform.OS === "ios";
  onReadyChangeRef.current = props.onReadyChange;

  const setReady = useCallback((ready: boolean) => {
    readyRef.current = ready;
    onReadyChangeRef.current?.(ready);
  }, []);

  const rejectPendingDomCapture = useCallback((message: string) => {
    const pending = pendingDomCaptureRef.current;
    if (!pending) return;
    pendingDomCaptureRef.current = null;
    clearTimeout(pending.timeout);
    pending.reject(new Error(message));
  }, []);

  useEffect(
    () => () => {
      mountedRef.current = false;
      onReadyChangeRef.current?.(false);
      rejectPendingDomCapture("Browser closed before it could be captured.");
    },
    [rejectPendingDomCapture],
  );

  const requestDomFrame = useCallback((): Promise<MobilePreviewDomCapture> => {
    const webView = webViewRef.current;
    if (!webView || !readyRef.current) {
      return Promise.reject(new Error("Wait for Browser to finish loading."));
    }
    rejectPendingDomCapture("A newer browser capture replaced this one.");
    const requestId = uuidv4();
    const generation = navigationGenerationRef.current;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = pendingDomCaptureRef.current;
        if (pending?.requestId !== requestId) return;
        pendingDomCaptureRef.current = null;
        reject(new Error("The page did not respond to the markup capture request."));
      }, DOM_CAPTURE_TIMEOUT_MS);
      pendingDomCaptureRef.current = {
        generation,
        reject,
        requestId,
        resolve,
        timeout,
      };
      try {
        webView.injectJavaScript(mobilePreviewDomCaptureScript(requestId));
      } catch (cause) {
        pendingDomCaptureRef.current = null;
        clearTimeout(timeout);
        reject(
          cause instanceof Error ? cause : new Error("The page could not be inspected for markup."),
        );
      }
    });
  }, [rejectPendingDomCapture]);

  const captureForMarkup = useCallback(async (): Promise<PreviewSnapshotMarkupSeed> => {
    if (captureInProgressRef.current) {
      throw new Error("A browser capture is already in progress.");
    }
    const layout = layoutRef.current;
    if (layout.width <= 0 || layout.height <= 0) {
      throw new Error("Browser has not finished laying out.");
    }
    captureInProgressRef.current = true;
    setCaptureInProgress(true);
    try {
      const { frame, generation } = await requestDomFrame();
      if (navigationGenerationRef.current !== generation) {
        throw new Error("Browser navigated while it was being captured.");
      }
      const screenshot = await captureMobilePreviewPng({
        viewRef: captureViewRef,
        layout,
        viewport: frame.viewport,
      });
      if (navigationGenerationRef.current !== generation) {
        throw new Error("Browser navigated while it was being captured.");
      }
      const snapshotId = uuidv4();
      return createPreviewSnapshotMarkupSeed({
        snapshot: {
          snapshotId,
          pageRevision: `mobile:${generation}:${snapshotId}`,
          capturedAt: new Date().toISOString(),
          url: mobilePreviewAnnotationUrl({
            documentUrl: frame.url,
            gatewayUrl: props.uri,
            sourceUrl: props.annotationSourceUrl,
            isolatedGateway: props.isolatedSession,
          }),
          title: frame.title,
          viewport: frame.viewport,
          screenshot,
          elements: frame.elements,
        },
        attachmentId: uuidv4(),
        annotationId: uuidv4(),
      });
    } finally {
      captureInProgressRef.current = false;
      if (mountedRef.current) setCaptureInProgress(false);
    }
  }, [props.annotationSourceUrl, props.isolatedSession, props.uri, requestDomFrame]);

  useImperativeHandle(
    forwardedRef,
    () => ({
      captureForMarkup,
      goBack: () => webViewRef.current?.goBack(),
      goForward: () => webViewRef.current?.goForward(),
      reload: () => webViewRef.current?.reload(),
    }),
    [captureForMarkup],
  );

  const handleMessage = useCallback((event: WebViewMessageEvent) => {
    const pending = pendingDomCaptureRef.current;
    if (!pending) return;
    const raw = event.nativeEvent.data;
    const frame = decodeMobilePreviewDomMessage(raw, pending.requestId);
    if (frame) {
      pendingDomCaptureRef.current = null;
      clearTimeout(pending.timeout);
      if (pending.generation !== navigationGenerationRef.current) {
        pending.reject(new Error("Browser navigated before it could be captured."));
        return;
      }
      pending.resolve({ frame, generation: pending.generation });
      return;
    }
    const pageError = decodeMobilePreviewDomErrorMessage(raw, pending.requestId);
    if (!pageError) return;
    pendingDomCaptureRef.current = null;
    clearTimeout(pending.timeout);
    pending.reject(new Error(pageError));
  }, []);

  const handleNavigation = useCallback(
    (navigation: WebViewNavigation) => {
      props.onNavigationChange?.({
        canGoBack: navigation.canGoBack,
        canGoForward: navigation.canGoForward,
        title: navigation.title,
        url: mobilePreviewAnnotationUrl({
          documentUrl: navigation.url,
          gatewayUrl: props.uri,
          sourceUrl: props.annotationSourceUrl,
          isolatedGateway: props.isolatedSession,
        }),
      });
    },
    [props.annotationSourceUrl, props.isolatedSession, props.onNavigationChange, props.uri],
  );

  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    layoutRef.current = {
      width: event.nativeEvent.layout.width,
      height: event.nativeEvent.layout.height,
    };
  }, []);

  return (
    <View className="relative min-h-0 flex-1 bg-card">
      {progress > 0 && progress < 1 ? <LoadingStrip progress={progress} /> : null}
      {error ? (
        <View className="border-b border-border bg-card px-3 py-2">
          <Text className="text-xs font-t3-bold text-foreground">Browser failed</Text>
          <Text className="mt-0.5 text-xs leading-snug text-foreground-muted">{error}</Text>
        </View>
      ) : null}
      <View
        ref={captureViewRef}
        collapsable={false}
        className="min-h-0 flex-1 bg-card"
        onLayout={handleLayout}
      >
        <WebView
          ref={webViewRef}
          source={{ uri: props.uri }}
          originWhitelist={["http://*", "https://*"]}
          allowsBackForwardNavigationGestures
          allowsFullscreenVideo
          cacheEnabled
          domStorageEnabled
          incognito={useIncognitoCookieStore}
          setSupportMultipleWindows={false}
          sharedCookiesEnabled={false}
          thirdPartyCookiesEnabled={!props.isolatedSession}
          useSharedProcessPool={!props.isolatedSession}
          webviewDebuggingEnabled={__DEV__}
          startInLoadingState
          onContentProcessDidTerminate={() => {
            navigationGenerationRef.current += 1;
            rejectPendingDomCapture("The browser process restarted during capture.");
            setReady(false);
            webViewRef.current?.reload();
          }}
          onRenderProcessGone={() => {
            navigationGenerationRef.current += 1;
            rejectPendingDomCapture("The browser process restarted during capture.");
            setReady(false);
            webViewRef.current?.reload();
          }}
          onLoadProgress={(event) => setProgress(event.nativeEvent.progress)}
          onLoadStart={() => {
            navigationGenerationRef.current += 1;
            rejectPendingDomCapture("Browser navigated during capture.");
            setReady(false);
            setProgress(0.05);
            setError(null);
          }}
          onLoad={() => {
            setProgress(0);
            setReady(true);
          }}
          onLoadEnd={() => setProgress(0)}
          onNavigationStateChange={handleNavigation}
          onMessage={handleMessage}
          onHttpError={(event) => {
            const status = event.nativeEvent.statusCode;
            if (props.isolatedSession && status === 511 && !gatewayExpiredRef.current) {
              gatewayExpiredRef.current = true;
              setReady(false);
              props.onGatewayExpired?.();
            }
          }}
          onError={(event) => {
            setReady(false);
            setProgress(0);
            setError(event.nativeEvent.description || "The page could not be loaded.");
          }}
          renderLoading={() => (
            <View className="absolute inset-0 items-center justify-center bg-card">
              <ActivityIndicator />
            </View>
          )}
          style={{ flex: 1, backgroundColor: "transparent" }}
        />
      </View>
      {captureInProgress ? (
        <View
          accessibilityLabel="Freezing browser for markup"
          className="absolute inset-0 items-center justify-center bg-black/10"
        >
          <ActivityIndicator />
        </View>
      ) : null}
    </View>
  );
});
