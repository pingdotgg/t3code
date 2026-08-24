import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import type { DiscoveredLocalServer, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { PREVIEW_PROXY_EXIT_PATH } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Image, Platform, Pressable, ScrollView, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { captureRef } from "react-native-view-shot";
import { WebView } from "react-native-webview";

import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { ControlPill } from "../../components/ControlPill";
import { LoadingStrip } from "../../components/LoadingStrip";
import { cn } from "../../lib/cn";
import { useThemeColor } from "../../lib/useThemeColor";
import { previewEnvironment } from "../../state/preview";
import { useEnvironmentQuery } from "../../state/query";
import { usePreparedConnection } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  appendReviewCommentToDraft,
  useThreadDraftForThread,
} from "../../state/use-thread-composer-state";
import { useThreadSelection } from "../../state/use-thread-selection";
import {
  addBoxMarker,
  addPinMarker,
  buildPreviewAnnotationAttachment,
  buildPreviewAnnotationText,
  removeMarker,
  updateMarkerNote,
  type PreviewAnnotationMarker,
} from "./previewAnnotation";

type ThreadPreviewRouteScreenProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
}>;

interface PreviewSession {
  readonly server: DiscoveredLocalServer;
  readonly entryUrl: string;
}

interface CapturedShot {
  readonly uri: string;
  readonly width: number;
  readonly height: number;
}

/** Shown page for annotation notes: the dev server origin plus the proxied path. */
function resolveAnnotationPageUrl(
  server: DiscoveredLocalServer,
  proxiedUrl: string | null,
): string {
  if (proxiedUrl === null) return server.url;
  try {
    const parsed = new URL(proxiedUrl);
    return new URL(`${parsed.pathname}${parsed.search}`, server.url).toString();
  } catch {
    return server.url;
  }
}

export function ThreadPreviewRouteScreen(_props: ThreadPreviewRouteScreenProps) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { selectedThread } = useThreadSelection();
  const environmentId = selectedThread?.environmentId ?? null;
  const threadId = selectedThread?.id ?? null;
  const preparedConnection = usePreparedConnection(environmentId);
  const httpBaseUrl = Option.isSome(preparedConnection)
    ? preparedConnection.value.httpBaseUrl
    : null;

  const serversQuery = useEnvironmentQuery(
    environmentId === null ? null : previewEnvironment.localServers({ environmentId, input: {} }),
  );
  const createProxyTicket = useAtomCommand(previewEnvironment.createProxyTicket, "preview ticket");

  const [session, setSession] = useState<PreviewSession | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [openingUrl, setOpeningUrl] = useState<string | null>(null);
  const [loadProgress, setLoadProgress] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [proxiedUrl, setProxiedUrl] = useState<string | null>(null);
  const [canGoBack, setCanGoBack] = useState(false);
  const [capture, setCapture] = useState<CapturedShot | null>(null);
  const webViewRef = useRef<WebView>(null);
  const webShotRef = useRef<View>(null);
  const sessionRef = useRef<PreviewSession | null>(null);
  sessionRef.current = session;
  const httpBaseUrlRef = useRef<string | null>(null);
  httpBaseUrlRef.current = httpBaseUrl;

  const endSessionOnServer = useCallback(() => {
    const baseUrl = httpBaseUrlRef.current;
    if (baseUrl === null) return;
    // Clears the HttpOnly preview cookie; the WebView and app fetch share the
    // cookie jar on Android, so this signs the whole client out of the proxy.
    fetch(new URL(PREVIEW_PROXY_EXIT_PATH, baseUrl).toString()).catch(() => undefined);
  }, []);

  useEffect(
    () => () => {
      if (sessionRef.current !== null) {
        endSessionOnServer();
      }
    },
    [endSessionOnServer],
  );

  const handleOpenServer = useCallback(
    (server: DiscoveredLocalServer) => {
      if (environmentId === null || httpBaseUrl === null) return;
      setSessionError(null);
      setOpeningUrl(server.url);
      void createProxyTicket({ environmentId, input: { url: server.url } }).then((result) => {
        setOpeningUrl(null);
        if (result._tag !== "Success") {
          setSessionError("The preview could not be opened. Is the dev server still running?");
          return;
        }
        const entryUrl = new URL(result.value.entryPath, httpBaseUrl);
        entryUrl.searchParams.set("to", "/");
        setLoadError(null);
        setProxiedUrl(null);
        setCanGoBack(false);
        setSession({ server, entryUrl: entryUrl.toString() });
      });
    },
    [createProxyTicket, environmentId, httpBaseUrl],
  );

  const handleCloseSession = useCallback(() => {
    endSessionOnServer();
    setSession(null);
    setCapture(null);
  }, [endSessionOnServer]);

  const handleCapture = useCallback(() => {
    void (async () => {
      try {
        const uri = await captureRef(webShotRef, {
          format: "png",
          quality: 1,
          result: "tmpfile",
        });
        const size = await new Promise<{ width: number; height: number }>((resolve, reject) => {
          Image.getSize(
            uri,
            (width, height) => resolve({ width, height }),
            (error) => reject(error instanceof Error ? error : new Error(String(error))),
          );
        });
        setCapture({ uri, ...size });
      } catch (error) {
        console.warn("[preview] capture failed", error);
        setLoadError("The preview could not be captured.");
      }
    })();
  }, []);

  const handleAnnotationDone = useCallback(() => {
    setCapture(null);
    navigation.goBack();
  }, [navigation]);

  if (environmentId === null || threadId === null || httpBaseUrl === null) {
    return (
      <View className="flex-1 items-center justify-center gap-3 bg-screen px-6">
        <ActivityIndicator />
        <Text className="text-center text-sm text-foreground-muted">Connecting...</Text>
      </View>
    );
  }

  if (capture !== null) {
    return (
      <PreviewAnnotationEditor
        capture={capture}
        pageUrl={resolveAnnotationPageUrl(
          session?.server ?? fallbackServer(httpBaseUrl),
          proxiedUrl,
        )}
        environmentId={environmentId}
        threadId={threadId}
        onCancel={() => setCapture(null)}
        onDone={handleAnnotationDone}
      />
    );
  }

  if (session === null) {
    return (
      <ScrollView
        className="flex-1 bg-screen"
        contentContainerStyle={{ padding: 20, paddingBottom: insets.bottom + 24, gap: 12 }}
        contentInsetAdjustmentBehavior="automatic"
      >
        <Text className="text-sm leading-normal text-foreground-muted">
          Dev servers listening on this environment's machine. Opening one routes it through your
          existing T3 connection - the server stays bound to that machine.
        </Text>
        {sessionError ? (
          <View className="rounded-2xl border border-danger-border bg-card px-4 py-3">
            <Text className="text-sm text-danger-foreground">{sessionError}</Text>
          </View>
        ) : null}
        {serversQuery.error ? (
          <View className="rounded-2xl border border-danger-border bg-card px-4 py-3">
            <Text className="text-sm text-danger-foreground">{serversQuery.error}</Text>
          </View>
        ) : null}
        {(serversQuery.data?.servers ?? []).map((server) => (
          <Pressable
            key={`${server.host}:${server.port}`}
            className="flex-row items-center gap-3 rounded-2xl border border-border bg-card px-4 py-4"
            disabled={openingUrl !== null}
            onPress={() => handleOpenServer(server)}
          >
            <View className="flex-1">
              <Text className="text-base font-t3-bold text-foreground">{server.url}</Text>
              <Text className="mt-0.5 text-xs text-foreground-muted">
                {server.processName ?? "unknown process"}
                {server.pid !== null ? ` - pid ${server.pid}` : ""}
              </Text>
            </View>
            {openingUrl === server.url ? (
              <ActivityIndicator />
            ) : (
              <SymbolView name="chevron.right" size={16} type="monochrome" />
            )}
          </Pressable>
        ))}
        {serversQuery.data !== null && serversQuery.data.servers.length === 0 ? (
          <View className="items-center gap-2 rounded-2xl border border-border bg-card px-4 py-8">
            <Text className="text-base font-t3-bold text-foreground">No dev servers found</Text>
            <Text className="text-center text-sm leading-normal text-foreground-muted">
              Start a dev server in a terminal on the environment, then refresh.
            </Text>
          </View>
        ) : null}
        {serversQuery.isPending && serversQuery.data === null ? (
          <View className="items-center py-8">
            <ActivityIndicator />
          </View>
        ) : null}
        <ControlPill
          accessibilityLabel="Refresh dev servers"
          icon="arrow.clockwise"
          label="Refresh"
          onPress={serversQuery.refresh}
        />
      </ScrollView>
    );
  }

  return (
    <View className="flex-1 bg-screen">
      {loadProgress > 0 && loadProgress < 1 ? <LoadingStrip progress={loadProgress} /> : null}
      {loadError ? (
        <View className="border-b border-border bg-card px-4 py-2">
          <Text className="text-xs font-t3-bold text-foreground">Preview problem</Text>
          <Text className="mt-0.5 text-xs leading-snug text-foreground-muted">{loadError}</Text>
        </View>
      ) : null}
      <View ref={webShotRef} collapsable={false} className="flex-1 bg-card">
        <WebView
          ref={webViewRef}
          source={{ uri: session.entryUrl }}
          originWhitelist={["*"]}
          setSupportMultipleWindows={false}
          sharedCookiesEnabled
          thirdPartyCookiesEnabled
          startInLoadingState
          onLoadProgress={(event) => setLoadProgress(event.nativeEvent.progress)}
          onLoadStart={() => {
            setLoadProgress(0.05);
            setLoadError(null);
          }}
          onLoadEnd={() => setLoadProgress(0)}
          onError={(event) => {
            setLoadProgress(0);
            setLoadError(event.nativeEvent.description || "The dev server is unreachable.");
          }}
          onHttpError={(event) => {
            if (event.nativeEvent.statusCode === 403 || event.nativeEvent.statusCode === 502) {
              setLoadError(
                event.nativeEvent.statusCode === 403
                  ? "The preview session expired. Close and reopen the preview."
                  : "The dev server is unreachable.",
              );
            }
          }}
          onNavigationStateChange={(navState) => {
            setProxiedUrl(navState.url);
            setCanGoBack(navState.canGoBack);
          }}
          renderLoading={() => (
            <View className="absolute inset-0 items-center justify-center bg-card">
              <ActivityIndicator />
            </View>
          )}
          style={{ flex: 1, backgroundColor: "transparent" }}
        />
      </View>
      <View
        className="flex-row items-center gap-3 border-t border-border bg-sheet px-5 pt-2"
        style={{ paddingBottom: Math.max(insets.bottom, 10) }}
      >
        <ControlPill
          accessibilityLabel="Back"
          icon="chevron.left"
          disabled={!canGoBack}
          onPress={() => webViewRef.current?.goBack()}
        />
        <ControlPill
          accessibilityLabel="Reload"
          icon="arrow.clockwise"
          onPress={() => webViewRef.current?.reload()}
        />
        <View className="flex-1" />
        <ControlPill
          accessibilityLabel="Capture screenshot"
          icon="camera"
          label="Capture"
          variant="primary"
          onPress={handleCapture}
        />
        <ControlPill accessibilityLabel="Close preview" icon="xmark" onPress={handleCloseSession} />
      </View>
    </View>
  );
}

function fallbackServer(url: string): DiscoveredLocalServer {
  return { host: "localhost", port: 80, url, processName: null, pid: null, terminal: null };
}

type AnnotationTool = "pin" | "box";

interface DraftBox {
  readonly startX: number;
  readonly startY: number;
  readonly currentX: number;
  readonly currentY: number;
}

function PreviewAnnotationEditor(props: {
  readonly capture: CapturedShot;
  readonly pageUrl: string;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly onCancel: () => void;
  readonly onDone: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [markers, setMarkers] = useState<ReadonlyArray<PreviewAnnotationMarker>>([]);
  const [selectedMarkerId, setSelectedMarkerId] = useState<string | null>(null);
  const [tool, setTool] = useState<AnnotationTool>("pin");
  const [canvasSize, setCanvasSize] = useState<{ width: number; height: number } | null>(null);
  const [draftBox, setDraftBox] = useState<DraftBox | null>(null);
  const [isFlattening, setIsFlattening] = useState(false);
  const [attachError, setAttachError] = useState<string | null>(null);
  const canvasRef = useRef<View>(null);
  const accentColor = String(useThemeColor("--color-primary"));
  const { draftAttachments } = useThreadDraftForThread({
    environmentId: props.environmentId,
    threadId: props.threadId,
  });

  // Fit the capture inside the available area, preserving aspect ratio. The
  // canvas view is sized to exactly the displayed image so a flatten capture
  // contains no letterboxing.
  const [containerSize, setContainerSize] = useState<{ width: number; height: number } | null>(
    null,
  );
  useEffect(() => {
    if (containerSize === null) return;
    const scale = Math.min(
      containerSize.width / props.capture.width,
      containerSize.height / props.capture.height,
    );
    setCanvasSize({
      width: Math.max(1, Math.floor(props.capture.width * scale)),
      height: Math.max(1, Math.floor(props.capture.height * scale)),
    });
  }, [containerSize, props.capture]);

  const addPinAt = useCallback((x: number, y: number, size: { width: number; height: number }) => {
    setMarkers((current) => {
      const next = addPinMarker(current, { x: x / size.width, y: y / size.height });
      setSelectedMarkerId(next[next.length - 1]?.id ?? null);
      return next;
    });
  }, []);

  const finishBox = useCallback((box: DraftBox, size: { width: number; height: number }) => {
    setMarkers((current) => {
      const next = addBoxMarker(current, {
        startX: box.startX / size.width,
        startY: box.startY / size.height,
        endX: box.currentX / size.width,
        endY: box.currentY / size.height,
      });
      setSelectedMarkerId(next[next.length - 1]?.id ?? null);
      return next;
    });
  }, []);

  const gesture = useMemo(() => {
    if (canvasSize === null) return Gesture.Tap().enabled(false);
    const tap = Gesture.Tap()
      .runOnJS(true)
      .onEnd((event, success) => {
        if (!success || tool !== "pin") return;
        addPinAt(event.x, event.y, canvasSize);
      });
    const pan = Gesture.Pan()
      .runOnJS(true)
      .enabled(tool === "box")
      .onBegin((event) => {
        setDraftBox({ startX: event.x, startY: event.y, currentX: event.x, currentY: event.y });
      })
      .onUpdate((event) => {
        setDraftBox((current) =>
          current === null ? null : { ...current, currentX: event.x, currentY: event.y },
        );
      })
      .onEnd((event, success) => {
        setDraftBox(null);
        if (!success) return;
        finishBox(
          {
            startX: event.x - event.translationX,
            startY: event.y - event.translationY,
            currentX: event.x,
            currentY: event.y,
          },
          canvasSize,
        );
      })
      .onFinalize(() => setDraftBox(null));
    return Gesture.Race(pan, tap);
  }, [addPinAt, canvasSize, finishBox, tool]);

  const selectedMarker = markers.find((marker) => marker.id === selectedMarkerId) ?? null;

  const handleAddToChat = useCallback(() => {
    void (async () => {
      setAttachError(null);
      setIsFlattening(true);
      try {
        // Let the deselected-marker frame paint before capturing.
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        });
        const base64 = await captureRef(canvasRef, {
          format: "png",
          quality: 1,
          result: "base64",
        });
        const result = buildPreviewAnnotationAttachment({
          base64: base64.replace(/\s/g, ""),
          existingAttachmentCount: draftAttachments.length,
        });
        if (!result.ok) {
          setAttachError(result.error);
          return;
        }
        appendReviewCommentToDraft({
          environmentId: props.environmentId,
          threadId: props.threadId,
          text: buildPreviewAnnotationText({ pageUrl: props.pageUrl, markers }),
          attachments: [result.attachment],
        });
        props.onDone();
      } catch (error) {
        console.warn("[preview] flatten failed", error);
        setAttachError("The annotated screenshot could not be created.");
      } finally {
        setIsFlattening(false);
      }
    })();
  }, [draftAttachments.length, markers, props]);

  return (
    <View className="flex-1 bg-screen">
      <KeyboardAvoidingView
        automaticOffset
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        className="flex-1"
      >
        <View
          className="flex-1 items-center justify-center px-3 py-3"
          onLayout={(event) => {
            const { width, height } = event.nativeEvent.layout;
            setContainerSize({ width: Math.max(1, width - 4), height: Math.max(1, height - 4) });
          }}
        >
          {canvasSize === null ? (
            <ActivityIndicator />
          ) : (
            <GestureDetector gesture={gesture}>
              <View
                ref={canvasRef}
                collapsable={false}
                style={{ width: canvasSize.width, height: canvasSize.height }}
                className="overflow-hidden rounded-xl bg-card"
              >
                <Image
                  source={{ uri: props.capture.uri }}
                  style={{ width: canvasSize.width, height: canvasSize.height }}
                  resizeMode="stretch"
                />
                {markers.map((marker) => {
                  const isSelected = !isFlattening && marker.id === selectedMarkerId;
                  const left = marker.x * canvasSize.width;
                  const top = marker.y * canvasSize.height;
                  return marker.kind === "box" ? (
                    <View
                      key={marker.id}
                      pointerEvents="none"
                      style={{
                        position: "absolute",
                        left,
                        top,
                        width: Math.max(8, marker.width * canvasSize.width),
                        height: Math.max(8, marker.height * canvasSize.height),
                        borderWidth: isSelected ? 3 : 2,
                        borderColor: accentColor,
                        borderRadius: 6,
                      }}
                    >
                      <MarkerBadge index={marker.index} color={accentColor} />
                    </View>
                  ) : (
                    <View
                      key={marker.id}
                      pointerEvents="none"
                      style={{ position: "absolute", left: left - 13, top: top - 13 }}
                    >
                      <MarkerBadge index={marker.index} color={accentColor} large={isSelected} />
                    </View>
                  );
                })}
                {draftBox !== null ? (
                  <View
                    pointerEvents="none"
                    style={{
                      position: "absolute",
                      left: Math.min(draftBox.startX, draftBox.currentX),
                      top: Math.min(draftBox.startY, draftBox.currentY),
                      width: Math.abs(draftBox.currentX - draftBox.startX),
                      height: Math.abs(draftBox.currentY - draftBox.startY),
                      borderWidth: 2,
                      borderStyle: "dashed",
                      borderColor: accentColor,
                      borderRadius: 6,
                    }}
                  />
                ) : null}
              </View>
            </GestureDetector>
          )}
        </View>

        <View
          className="gap-3 border-t border-border bg-sheet px-5 pt-3"
          style={{ paddingBottom: Math.max(insets.bottom, 12) }}
        >
          {attachError ? (
            <Text className="text-sm text-danger-foreground">{attachError}</Text>
          ) : null}
          <View className="flex-row items-center gap-2">
            <ControlPill
              accessibilityLabel="Add numbered pins"
              label="Pin"
              variant={tool === "pin" ? "primary" : "pill"}
              onPress={() => setTool("pin")}
            />
            <ControlPill
              accessibilityLabel="Draw boxes"
              label="Box"
              variant={tool === "box" ? "primary" : "pill"}
              onPress={() => setTool("box")}
            />
            <View className="flex-1" />
            {selectedMarker !== null ? (
              <ControlPill
                accessibilityLabel={`Remove marker ${selectedMarker.index}`}
                icon="trash"
                onPress={() => {
                  setMarkers((current) => removeMarker(current, selectedMarker.id));
                  setSelectedMarkerId(null);
                }}
              />
            ) : null}
          </View>
          {markers.length > 0 ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <View className="flex-row items-center gap-2">
                {markers.map((marker) => (
                  <Pressable
                    key={marker.id}
                    className={cn(
                      "h-9 min-w-9 items-center justify-center rounded-full border border-border bg-card px-3",
                      marker.id === selectedMarkerId && "border-primary",
                    )}
                    onPress={() => setSelectedMarkerId(marker.id)}
                  >
                    <Text className="text-sm font-t3-bold text-foreground">{marker.index}</Text>
                  </Pressable>
                ))}
              </View>
            </ScrollView>
          ) : (
            <Text className="text-xs text-foreground-muted">
              Tap to drop a numbered pin, or switch to Box and drag over an area.
            </Text>
          )}
          {selectedMarker !== null ? (
            <TextInput
              autoFocus
              placeholder={`Note for marker ${selectedMarker.index}...`}
              value={selectedMarker.note}
              onChangeText={(note) =>
                setMarkers((current) => updateMarkerNote(current, selectedMarker.id, note))
              }
              className="rounded-2xl border border-border bg-card px-4 py-2.5 font-sans text-base"
            />
          ) : null}
          <View className="flex-row items-center gap-3">
            <ControlPill
              accessibilityLabel="Cancel annotation"
              icon="xmark"
              label="Cancel"
              onPress={props.onCancel}
            />
            <View className="flex-1" />
            <ControlPill
              accessibilityLabel="Add to chat"
              icon="arrow.up"
              label="Add to chat"
              variant="primary"
              disabled={isFlattening}
              onPress={handleAddToChat}
            />
          </View>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

function MarkerBadge(props: {
  readonly index: number;
  readonly color: string;
  readonly large?: boolean;
}) {
  const size = props.large ? 30 : 26;
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: props.color,
        alignItems: "center",
        justifyContent: "center",
        marginLeft: -2,
        marginTop: -2,
      }}
    >
      <Text className="text-xs font-t3-bold text-primary-foreground">{props.index}</Text>
    </View>
  );
}
