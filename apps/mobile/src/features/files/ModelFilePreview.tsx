import { useNavigation } from "@react-navigation/native";
import {
  formatModelSize,
  formatModelViewHash,
  MAX_MODEL_BYTES,
  modelAnnotationPayload,
  modelNotesFitAnnotation,
  modelViewFromHash,
  rememberModelPreview,
  restoreModelPins,
  type ModelCameraView,
  type ModelNote,
  type ModelPinCapture,
  type ModelPreviewMemory,
} from "@t3tools/client-runtime/model-preview/annotations";
import type { ModelViewPreset } from "@t3tools/client-runtime/model-preview/scene";
import { zipErrorText } from "@t3tools/client-runtime/zip/error-messages";
import type { ModelPreviewKind } from "@t3tools/shared/filePreview";
import { fetch } from "expo/fetch";
import { File } from "expo-file-system";
import { useGT, useMessages } from "gt-react-native";
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type Ref,
} from "react";
import { Platform, Pressable, ScrollView, TextInput, View } from "react-native";
import { KeyboardStickyView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { WebView } from "react-native-webview";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ControlPill } from "../../components/ui/ControlPill";
import * as Dialog from "../../components/ui/Dialog";
import { EmptyState } from "../../components/ui/EmptyState";
import { useContentTopInset } from "../../components/ui/useBarInset";
import { cn } from "../../lib/cn";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { uuidv4 } from "../../lib/uuid";
import {
  getComposerDraftSnapshot,
  insertComposerDraftContext,
} from "../../state/use-composer-drafts";
import { REVIEW_MONO_FONT_FAMILY } from "../review/reviewDiffRendering";
import { modelAnnotationComposerContent } from "./modelAnnotationDraft";
import {
  modelViewerDocument,
  modelViewerEvent,
  modelViewerInjection,
} from "./model-viewer-document";
import {
  createModelViewerRequests,
  isModelTooLargeError,
  ModelTooLargeError,
  modelTransferChunks,
  type ModelSummary,
  type ModelViewerCommand,
  type ModelViewerEvent,
} from "./model-viewer-protocol";

interface ModelFilePreviewHandle {
  readonly resetView: () => void;
}

interface DraftPin {
  /** The note being edited, or null for a new pin at `hit`. */
  readonly id: string | null;
  readonly hit:
    | (Extract<ModelViewerEvent, { type: "pick" }>["hit"] & { readonly number: number })
    | null;
  readonly text: string;
}

type Failure =
  | "too-large"
  | "unavailable"
  | "crashed"
  | Extract<ModelViewerEvent, { type: "failed" }>["code"];

type ViewerRequests = ReturnType<typeof createModelViewerRequests>;

const MODEL_VIEWER_STARTUP_TIMEOUT_MS = 15_000;

// Notes and camera per model for this app session, so leaving and reopening a file keeps them.
let rememberedModels: Readonly<Record<string, ModelPreviewMemory>> = {};

const isLocalUri = (uri: string) => /^(file|content):/.test(uri);

async function openModelReader(uri: string, signal: AbortSignal) {
  if (isLocalUri(uri)) return new File(uri).readableStream().getReader();
  const response = await fetch(uri, { signal });
  if (!response.ok || !response.body) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error(`Model request failed (${response.status}).`);
  }
  if (Number(response.headers.get("content-length")) > MAX_MODEL_BYTES) {
    void response.body.cancel().catch(() => undefined);
    throw new ModelTooLargeError();
  }
  return response.body.getReader();
}

async function streamModelChunks(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
  sendChunk: (data: string) => Promise<void>,
) {
  for await (const data of modelTransferChunks(reader, MAX_MODEL_BYTES)) {
    signal.throwIfAborted();
    await sendChunk(data);
  }
}

/** The file screen's menu actions for its model viewer, and the props that connect them. */
export function useModelViewerControls() {
  const gt = useGT();
  const handle = useRef<ModelFilePreviewHandle>(null);
  const [wireframe, setWireframe] = useState(false);
  return {
    viewer: { ref: handle, wireframe },
    menuActions: [
      {
        id: "reset-view",
        title: gt("Reset view"),
        icon: "arrow.uturn.backward",
        inline: false,
        onPress: () => handle.current?.resetView(),
      },
      {
        id: "wireframe",
        title: wireframe ? gt("Hide wireframe") : gt("Show wireframe"),
        icon: "cube",
        inline: false,
        onPress: () => setWireframe(!wireframe),
      },
    ] as const,
  };
}

/** Adds model notes to the end of a composer draft; false when the draft has no room. */
function stageModelAnnotation(
  draftKey: string,
  input: Omit<Parameters<typeof modelAnnotationPayload>[0], "createdAt">,
) {
  const annotation = modelAnnotationPayload({ ...input, createdAt: new Date().toISOString() });
  const content = modelAnnotationComposerContent(annotation, uuidv4);
  if (!content) return false;
  const { text } = getComposerDraftSnapshot(draftKey);
  return insertComposerDraftContext(draftKey, content, {
    text,
    start: text.length,
    end: text.length,
  });
}

/**
 * Interactive STL, 3MF and GLB preview. The shared `ModelScene` draws in a WebView; this view
 * streams the file into it, owns the notes, and stages them in a chat draft.
 */
export function ModelFilePreview({
  ref,
  name,
  format,
  uri,
  memoryKey,
  linkPath,
  initialView,
  wireframe,
  draftKey,
  onSent,
  onRetry,
}: {
  readonly ref?: Ref<ModelFilePreviewHandle>;
  readonly name: string;
  readonly format: ModelPreviewKind;
  /** A signed asset URL or a local file; null while it resolves. */
  readonly uri: string | null;
  /** Identifies the file across visits, for its remembered notes and camera. */
  readonly memoryKey: string;
  /** The workspace path a chat link reopens this model by; null for an attachment. */
  readonly linkPath: string | null;
  /** A camera to open at, from a chat link or a saved annotation. */
  readonly initialView: ModelCameraView | null;
  readonly wireframe: boolean;
  /** The composer draft notes go to; null when there is no chat to send them to. */
  readonly draftKey: string | null;
  readonly onSent: () => void;
  /** Mints a fresh URL after a failed load. */
  readonly onRetry: () => void;
}) {
  const gt = useGT();
  const messages = useMessages();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const headerInset = useContentTopInset();
  const theme = useUniwindTheme();
  const background = String(theme["--color-sheet"]);
  const pinColor = String(theme["--color-primary"]);
  const pinText = String(theme["--color-primary-foreground"]);
  const webView = useRef<WebView<object>>(null);
  const [document] = useState(() =>
    modelViewerDocument(
      // Required on first use: the bundled viewer is large and most sessions never open a model.
      require("@t3tools/mobile-model-viewer") as string,
      background,
    ),
  );
  // A new page after a crash or retry posts `ready` again before any load starts.
  const [page, setPage] = useState({ attempt: 0, ready: false, crashed: false });
  const [settled, setSettled] = useState<{ key: string; failure: Failure | null } | null>(null);
  const [summary, setSummary] = useState<ModelSummary | null>(null);
  const [notes, setNotes] = useState<ReadonlyArray<ModelNote>>([]);
  const [draft, setDraft] = useState<DraftPin | null>(null);
  const [annotating, setAnnotating] = useState(false);
  const [activePreset, setActivePreset] = useState<ModelViewPreset | "fit" | null>(null);
  const [busy, setBusy] = useState(false);
  const [inputFocused, setInputFocused] = useState(false);
  const loadKey = JSON.stringify([uri, format, page.attempt]);
  const failure: Failure | null = page.crashed
    ? "crashed"
    : settled?.key === loadKey
      ? settled.failure
      : null;
  const loading = failure === null && settled?.key !== loadKey;
  const activePage = useRef<number | null>(0);
  const generation = useRef<{ key: string; requests: ViewerRequests } | null>(null);
  const nextLoadId = useRef(0);
  const busyRef = useRef(false);
  // Read by bridge callbacks and the unmount save, which run outside renders.
  const summaryRef = useRef<ModelSummary | null>(null);
  const viewRef = useRef<ModelCameraView | null>(null);
  const notesRef = useRef(notes);
  const wireframeRef = useRef(wireframe);
  const captureRef = useRef<ModelPinCapture | null>(null);
  const earlierCaptureRef = useRef<ModelPinCapture | null>(null);
  const lastPinNumber = useRef(0);
  const initialViewHash = initialView ? formatModelViewHash(initialView) : null;

  const send = useCallback((command: ModelViewerCommand) => {
    if (!webView.current) return false;
    try {
      webView.current.injectJavaScript(modelViewerInjection(command));
      return true;
    } catch {
      return false;
    }
  }, []);

  const post = useEffectEvent(send);
  const startView = useEffectEvent(
    () => viewRef.current ?? initialView ?? rememberedModels[memoryKey]?.view ?? null,
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reports a WebView that never sent its startup message
  useEffect(() => {
    if (page.ready || page.crashed) return;
    const timeout = setTimeout(() => {
      setPage((current) =>
        current.attempt === page.attempt && !current.ready
          ? { ...current, crashed: true }
          : current,
      );
    }, MODEL_VIEWER_STARTUP_TIMEOUT_MS);
    return () => clearTimeout(timeout);
  }, [page.attempt, page.ready, page.crashed]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- streams the file's bytes into the WebView page, cancelling on unmount, source change or retry
  useLayoutEffect(() => {
    if (!page.ready || uri === null) return;
    const id = ++nextLoadId.current;
    const requests = createModelViewerRequests(id, send);
    generation.current = { key: loadKey, requests };
    busyRef.current = false;
    const { signal } = requests;
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    const cancelReader = () => void reader?.cancel().catch(() => undefined);
    signal.addEventListener("abort", cancelReader, { once: true });
    void (async () => {
      if (!post({ type: "begin", id })) throw new Error("The model viewer is unavailable.");
      reader = await openModelReader(uri, signal);
      signal.throwIfAborted();
      await streamModelChunks(reader, signal, requests.sendChunk);
      await requests.finish(format, startView());
    })()
      .catch((cause: unknown) => {
        if (signal.aborted) return;
        requests.close();
        post({ type: "cancel", id });
        setBusy(false);
        setDraft(null);
        setSettled({
          key: loadKey,
          failure: isModelTooLargeError(cause) ? "too-large" : "unavailable",
        });
      })
      .finally(() => {
        signal.removeEventListener("abort", cancelReader);
        cancelReader();
      });
    return () => {
      requests.close();
      if (generation.current?.requests === requests) generation.current = null;
      if (activePage.current === page.attempt) post({ type: "cancel", id });
    };
  }, [page.attempt, page.ready, uri, format, loadKey, send]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- an explicit link moves the camera even while the WebView is loading the model
  useEffect(() => {
    const view = initialViewHash ? modelViewFromHash(initialViewHash) : null;
    if (!view) return;
    viewRef.current = view;
    post({ type: "view", view });
  }, [initialViewHash]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the WebView page draws its background and pins in the current theme
  useEffect(() => {
    if (!page.ready) return;
    post({ type: "theme", colors: { background, pin: pinColor, pinText, ring: background } });
  }, [page.ready, background, pinColor, pinText]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- mirrors wireframe into the WebView scene
  useEffect(() => {
    wireframeRef.current = wireframe;
    if (page.ready) post({ type: "wireframe", on: wireframe });
  }, [page.ready, wireframe]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- mirrors annotate mode into the WebView, where taps pick surface points
  useEffect(() => {
    if (page.ready) post({ type: "annotate", on: annotating });
  }, [page.ready, annotating]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the WebView draws the pins, so it gets the notes and the open draft after each change
  useEffect(() => {
    if (!page.ready || summary === null) return;
    post({
      type: "notes",
      notes,
      activeId: draft?.id ?? null,
      draft: draft?.hit ?? null,
    });
  }, [page.ready, summary, notes, draft]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- remembers notes and camera when the file closes, so reopening it restores them
  useLayoutEffect(
    () => () => {
      const loaded = summaryRef.current;
      const view = viewRef.current;
      if (!loaded || !view) return;
      rememberedModels = rememberModelPreview(rememberedModels, memoryKey, {
        fingerprint: loaded.fingerprint,
        notes: notesRef.current,
        view,
        wireframe: wireframeRef.current,
        lastPinNumber: lastPinNumber.current,
        capture: captureRef.current,
        earlierCapture: earlierCaptureRef.current,
      });
    },
    [memoryKey],
  );

  const stopPage = () => {
    activePage.current = null;
    generation.current?.requests.close();
    generation.current = null;
    busyRef.current = false;
    setBusy(false);
  };

  const handleEvent = (event: ModelViewerEvent) => {
    if (page.crashed || activePage.current !== page.attempt) return;
    const current = generation.current;
    switch (event.type) {
      case "ready":
        setPage((current) => (current.crashed ? current : { ...current, ready: true }));
        return;
      case "crashed":
        stopPage();
        setPage((current) => ({ ...current, ready: false, crashed: true }));
        return;
      case "ack":
      case "captured":
        current?.requests.receive(event);
        return;
      case "failed":
        if (event.id !== current?.requests.id) return;
        current.requests.close();
        setBusy(false);
        setDraft(null);
        setSettled({ key: current.key, failure: event.code });
        return;
      case "loaded": {
        if (event.id !== current?.requests.id || current.requests.signal.aborted) return;
        current.requests.receive(event);
        const previous = summaryRef.current;
        const remembered = rememberedModels[memoryKey];
        const restored = restoreModelPins(
          previous
            ? {
                fingerprint: previous.fingerprint,
                notes: notesRef.current,
                capture: captureRef.current,
                earlierCapture: earlierCaptureRef.current,
              }
            : remembered,
          event.summary.fingerprint,
        );
        summaryRef.current = event.summary;
        viewRef.current = event.view;
        notesRef.current = restored.notes;
        captureRef.current = restored.capture;
        earlierCaptureRef.current = restored.earlierCapture;
        setSummary(event.summary);
        setNotes(restored.notes);
        setBusy(false);
        setDraft(null);
        if (!previous) {
          lastPinNumber.current = remembered?.lastPinNumber ?? 0;
          setActivePreset(initialView || remembered ? null : "iso");
        }
        setSettled({ key: current.key, failure: null });
        return;
      }
      case "view":
        if (!current) return;
        viewRef.current = event.view;
        if (event.moved) setActivePreset(null);
        return;
      case "pick":
        if (annotating && !busyRef.current && !loading && !failure) {
          setDraft({
            id: null,
            hit: { ...event.hit, number: lastPinNumber.current + 1 },
            text: "",
          });
        }
        return;
      case "pin": {
        const note = notesRef.current.find((entry) => entry.id === event.id);
        if (note && !busyRef.current && !loading && !failure) {
          setDraft({ id: note.id, hit: null, text: note.text });
        }
        return;
      }
    }
  };

  // A fresh page and a freshly minted URL; the load waits for the new page's `ready`.
  const retry = () => {
    stopPage();
    activePage.current = page.attempt + 1;
    setPage({ attempt: activePage.current, ready: false, crashed: false });
    onRetry();
  };

  const choosePreset = (preset: ModelViewPreset | "fit") => {
    setActivePreset(preset);
    send({ type: "preset", preset });
  };
  useImperativeHandle(ref, () => ({
    resetView: () => choosePreset("iso"),
  }));

  const updateNotes = (next: ReadonlyArray<ModelNote>) => {
    lastPinNumber.current =
      next.length > 0 ? Math.max(lastPinNumber.current, next.at(-1)!.number) : 0;
    if (!next.some((note) => note.stale)) earlierCaptureRef.current = null;
    if (!next.some((note) => !note.stale)) captureRef.current = null;
    notesRef.current = next;
    setNotes(next);
    setDraft(null);
  };

  const availableRequests = () => {
    const current = generation.current;
    return current?.key === loadKey &&
      !current.requests.signal.aborted &&
      !loading &&
      !failure &&
      !busyRef.current
      ? current.requests
      : null;
  };

  const setCaptureBusy = (value: boolean) => {
    busyRef.current = value;
    setBusy(value);
  };

  const savePins = async (next: ReadonlyArray<ModelNote>) => {
    const requests = availableRequests();
    if (!requests) return;
    if (next.some((note) => !note.stale)) {
      setCaptureBusy(true);
      const captured = await requests.capture(next);
      if (requests.signal.aborted) return;
      setCaptureBusy(false);
      if (captured === null) {
        Dialog.alert(gt("Preview unavailable"), gt("Try again."));
        return;
      }
      captureRef.current = captured;
    }
    updateNotes(next);
  };

  const saveDraft = () => {
    if (!draft || !availableRequests()) return;
    const text = draft.text.trim();
    if (!text) return;
    const isNew = draft.id === null && draft.hit !== null;
    let next: ReadonlyArray<ModelNote>;
    if (isNew) {
      const { number, point, normal } = draft.hit;
      next = [...notesRef.current, { id: uuidv4(), number, text, point, normal, stale: false }];
    } else {
      next = notesRef.current.map((note) => (note.id === draft.id ? { ...note, text } : note));
    }
    if (!modelNotesFitAnnotation(next)) {
      Dialog.alert(gt("Shorten this note or send your saved notes to chat first."));
      return;
    }
    if (isNew) {
      void savePins(next);
    } else {
      updateNotes(next);
    }
  };

  const deleteNote = (id: string) => {
    void savePins(notesRef.current.filter((note) => note.id !== id));
  };

  const sendToChat = async () => {
    const requests = availableRequests();
    const sent = notesRef.current;
    if (draftKey === null || !requests || sent.length === 0 || !navigation.isFocused()) return;
    setCaptureBusy(true);
    const earlier = sent.some((note) => note.stale) ? earlierCaptureRef.current : null;
    const captured = earlier ?? (await requests.capture(sent));
    if (requests.signal.aborted) return;
    setCaptureBusy(false);
    if (!navigation.isFocused()) return;
    const staged =
      captured !== null &&
      stageModelAnnotation(draftKey, {
        id: uuidv4(),
        name,
        linkPath,
        view: captured.view,
        notes: sent,
        screenshot: { ...captured.screenshot, earlier: earlier !== null },
      });
    if (!staged) {
      Dialog.alert(
        gt("Unable to add to chat"),
        captured === null
          ? gt("Try again.")
          : gt("Remove some attachments or context items from the draft, then try again."),
      );
      return;
    }
    updateNotes([]);
    setAnnotating(false);
    onSent();
  };

  const failureMessage =
    failure === "too-large"
      ? gt("This 3D model is larger than 128 MB, too large to preview.")
      : failure === "model-invalid"
        ? gt("This 3D model could not be read.")
        : failure === "model-webgl-unavailable"
          ? gt("3D previews need WebGL, which is unavailable.")
          : failure === "crashed"
            ? gt("The 3D viewer stopped.")
            : failure === null || failure === "unavailable"
              ? gt("Could not load this 3D model. Check the connection and try again.")
              : zipErrorText(failure, messages);
  const sizeLabel = summary
    ? summary.format === "stl"
      ? gt("{size} (mm assumed, STL has no units)", { size: formatModelSize(summary.size) })
      : summary.format === "3mf"
        ? gt("{size} model units", { size: formatModelSize(summary.size) })
        : gt("{size} m", { size: formatModelSize(summary.size) })
    : null;
  const staleNotes = notes.filter((note) => note.stale);
  const editingNote = notes.find((note) => note.id === draft?.id);
  const draftNumber = editingNote?.number ?? draft?.hit?.number ?? 1;
  const canAnnotate = draftKey !== null && summary !== null;
  const presets = [
    ["top", gt("Top", { $context: "3D view preset" })],
    ["front", gt("Front", { $context: "3D view preset" })],
    ["iso", gt("Iso", { $context: "3D view preset, isometric" })],
    ["fit", gt("Fit", { $context: "3D view preset, frame the whole model" })],
  ] as const;

  return (
    <View className="flex-1 bg-sheet" style={{ paddingTop: headerInset }}>
      {annotating ? (
        <View className="h-11 flex-row items-center gap-2 border-b border-border px-4">
          <Text className="min-w-0 flex-1 text-sm text-foreground" numberOfLines={1}>
            {gt("Tap the model to pin")}
          </Text>
          {notes.length > 0 ? (
            <Pressable
              accessibilityRole="button"
              disabled={busy || loading || failure !== null}
              onPress={() => void sendToChat()}
              className="h-8 items-center justify-center rounded-full bg-foreground px-3"
            >
              <Text className="text-xs font-t3-bold text-sheet">
                {gt("{count, plural, one {Send 1 to chat} other {Send # to chat}}", {
                  count: notes.length,
                })}
              </Text>
            </Pressable>
          ) : null}
          <Pressable
            accessibilityRole="button"
            disabled={busy}
            onPress={() => {
              setAnnotating(false);
              setDraft(null);
            }}
            className="h-11 justify-center px-2"
          >
            <Text className="text-sm font-t3-bold text-primary-text">{gt("Done")}</Text>
          </Pressable>
        </View>
      ) : summary ? (
        <Text className="px-4 pb-2 text-xs text-foreground-muted" numberOfLines={1}>
          {gt("{format} · {count} triangles · {size}", {
            format: summary.format.toUpperCase(),
            count: new Intl.NumberFormat(undefined, { notation: "compact" }).format(
              summary.triangles,
            ),
            size: sizeLabel,
          })}
        </Text>
      ) : null}
      {staleNotes.length > 0 ? (
        <View className="border-b border-warning-border bg-warning px-4 py-2">
          <Text className="text-xs leading-snug text-warning-foreground">
            {gt(
              "{count, plural, one {The model changed after 1 note was placed. It keeps its text but is no longer pinned to the surface.} other {The model changed after # notes were placed. They keep their text but are no longer pinned to the surface.}}",
              { count: staleNotes.length },
            )}
          </Text>
          <ScrollView className="max-h-36" nestedScrollEnabled>
            {staleNotes.map((note) => (
              <View key={note.id} className="min-h-9 flex-row items-center gap-2">
                <Text className="min-w-0 flex-1 text-xs text-warning-foreground" numberOfLines={1}>
                  {note.number}. {note.text}
                </Text>
                <Pressable
                  accessibilityRole="button"
                  disabled={busy || loading || failure !== null}
                  onPress={() => deleteNote(note.id)}
                  className="h-9 justify-center px-2"
                >
                  <Text className="text-xs font-t3-bold text-danger-foreground">
                    {gt("Remove")}
                  </Text>
                </Pressable>
              </View>
            ))}
          </ScrollView>
        </View>
      ) : null}
      <View className="flex-1">
        <WebView<object>
          key={page.attempt}
          ref={webView}
          accessibilityLabel={gt("3D view of {name}", { name })}
          source={{
            html: document,
            baseUrl: Platform.OS === "android" ? "https://localhost/" : "file:///",
          }}
          originWhitelist={["*"]}
          onShouldStartLoadWithRequest={(request) =>
            request.url === "about:blank" ||
            request.url === "https://localhost/" ||
            request.url === "file:///"
          }
          scrollEnabled={false}
          bounces={false}
          overScrollMode="never"
          setSupportMultipleWindows={false}
          contentInsetAdjustmentBehavior="never"
          style={{ flex: 1, backgroundColor: background }}
          onMessage={(message) => {
            const event = modelViewerEvent(message.nativeEvent.data);
            if (event) handleEvent(event);
          }}
          onContentProcessDidTerminate={() => handleEvent({ type: "crashed" })}
          onRenderProcessGone={() => handleEvent({ type: "crashed" })}
          onError={() => handleEvent({ type: "crashed" })}
        />
        {failure ? (
          <View className="absolute inset-0 items-center justify-center bg-sheet px-6">
            <EmptyState
              title={gt("Preview unavailable")}
              detail={failureMessage}
              actionLabel={gt("Try again")}
              onAction={retry}
            />
          </View>
        ) : loading ? (
          <View
            pointerEvents="none"
            className={cn(
              "absolute inset-0 items-center justify-center gap-3",
              summary === null && "bg-sheet",
            )}
          >
            <AppActivityIndicator />
            {summary === null ? (
              <Text className="text-sm text-foreground-muted">{gt("Loading model...")}</Text>
            ) : null}
          </View>
        ) : null}
        {summary && !draft && !failure ? (
          <View
            pointerEvents="box-none"
            className="absolute inset-x-0 bottom-0 gap-3 px-4"
            style={{ paddingBottom: Math.max(insets.bottom, 12) + 12 }}
          >
            <Text
              pointerEvents="none"
              className="text-center text-2xs text-foreground-muted"
              numberOfLines={1}
            >
              {gt("Drag to orbit · Two fingers to pan · Pinch to zoom")}
            </Text>
            <View pointerEvents="box-none" className="flex-row items-center justify-between gap-3">
              <View className="h-11 flex-row items-center rounded-full bg-grouped-card px-1">
                {presets.map(([preset, label]) => (
                  <Pressable
                    key={preset}
                    accessibilityRole="button"
                    accessibilityState={{ selected: activePreset === preset }}
                    onPress={() => choosePreset(preset)}
                    className={cn(
                      "h-9 min-w-11 items-center justify-center rounded-full px-3",
                      activePreset === preset && "bg-subtle-strong",
                    )}
                  >
                    <Text
                      className={cn(
                        "text-xs font-t3-bold",
                        activePreset === preset ? "text-foreground" : "text-foreground-muted",
                      )}
                    >
                      {label}
                    </Text>
                  </Pressable>
                ))}
              </View>
              {canAnnotate ? (
                <ControlPill
                  variant={annotating ? "primary" : "pill"}
                  icon="pin"
                  label={gt("Annotate")}
                  onPress={() => {
                    setAnnotating(!annotating);
                    setDraft(null);
                  }}
                />
              ) : null}
            </View>
          </View>
        ) : null}
      </View>
      {draft ? (
        <KeyboardStickyView
          style={{ position: "absolute", left: 0, right: 0, bottom: 0 }}
          offset={{ closed: 0, opened: insets.bottom }}
        >
          <View
            className="gap-3 rounded-t-2xl border-t border-border bg-card px-4 pt-3"
            style={{ paddingBottom: Math.max(insets.bottom, 12) }}
          >
            <View className="flex-row items-center gap-2">
              <View className="size-6 items-center justify-center rounded-full bg-primary">
                <Text className="text-xs font-t3-bold text-primary-foreground">{draftNumber}</Text>
              </View>
              <Text className="flex-1 text-sm font-t3-medium text-foreground">
                {gt("Note {number}", { number: draftNumber })}
              </Text>
              {draft.hit ? (
                <Text
                  className="text-xs text-foreground-muted"
                  style={{ fontFamily: REVIEW_MONO_FONT_FAMILY }}
                >
                  {gt("face {face}", { face: draft.hit.face })}
                </Text>
              ) : null}
            </View>
            <TextInput
              autoFocus
              multiline
              accessibilityLabel={gt("Note")}
              placeholder={gt("What should change here?")}
              placeholderTextColorClassName="accent-foreground-muted"
              value={draft.text}
              onChangeText={(text) => setDraft({ ...draft, text })}
              onFocus={() => setInputFocused(true)}
              onBlur={() => setInputFocused(false)}
              className={cn(
                "max-h-32 min-h-20 rounded-xl border px-3 py-2.5 text-base text-foreground",
                inputFocused ? "border-primary" : "border-border",
              )}
              style={{ textAlignVertical: "top" }}
            />
            <View className="flex-row items-center gap-2">
              {editingNote ? (
                <Button
                  label={gt("Delete")}
                  tone="text"
                  disabled={busy}
                  onPress={() => {
                    if (draft.id !== null) deleteNote(draft.id);
                  }}
                />
              ) : null}
              <View className="flex-1" />
              <Button
                label={gt("Cancel")}
                tone="text"
                disabled={busy}
                onPress={() => setDraft(null)}
              />
              <Button
                label={draft.id === null ? gt("Pin") : gt("Save")}
                tone="primary"
                disabled={busy || !draft.text.trim()}
                onPress={saveDraft}
              />
            </View>
          </View>
        </KeyboardStickyView>
      ) : null}
    </View>
  );
}
