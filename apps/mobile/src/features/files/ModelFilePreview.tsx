import {
  formatModelSize,
  formatModelViewHash,
  MAX_MODEL_BYTES,
  modelAnnotationPayload,
  modelViewFromHash,
  reconcileModelNotes,
  rememberModelPreview,
  type ModelCameraView,
  type ModelCapture,
  type ModelNote,
  type ModelPreviewMemory,
  type Vec3,
} from "@t3tools/client-runtime/model-preview/annotations";
import type { ModelPreviewErrorCode } from "@t3tools/client-runtime/model-preview/error";
import type { ModelViewPreset } from "@t3tools/client-runtime/model-preview/scene";
import type { ModelPreviewKind } from "@t3tools/shared/filePreview";
import { fetch } from "expo/fetch";
import { File } from "expo-file-system";
import { useGT } from "gt-react-native";
import { useEffect, useEffectEvent, useImperativeHandle, useRef, useState, type Ref } from "react";
import { Platform, Pressable, TextInput, View } from "react-native";
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
  readonly hit: { readonly point: Vec3; readonly normal: Vec3; readonly face: number } | null;
  readonly text: string;
}

type Failure = "too-large" | "unavailable" | "crashed" | ModelPreviewErrorCode;

type CaptureResult = Extract<ModelViewerEvent, { type: "captured" }>;

// Notes and camera per model for this app session, so leaving and reopening a file keeps them.
let rememberedModels: Readonly<Record<string, ModelPreviewMemory>> = {};

const isLocalUri = (uri: string) => /^(file|content):/.test(uri);

async function openModelReader(uri: string, signal: AbortSignal) {
  if (isLocalUri(uri)) return new File(uri).readableStream().getReader();
  const response = await fetch(uri, { signal });
  if (Number(response.headers.get("content-length")) > MAX_MODEL_BYTES) {
    void response.body?.cancel().catch(() => undefined);
    throw new ModelTooLargeError();
  }
  if (!response.ok || !response.body) throw new Error(`Model request failed (${response.status}).`);
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
  annotation: Parameters<typeof modelAnnotationComposerContent>[0],
) {
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
  const [sending, setSending] = useState(false);
  const [inputFocused, setInputFocused] = useState(false);
  const loadKey = JSON.stringify([uri, format, page.attempt]);
  const failure: Failure | null = page.crashed
    ? "crashed"
    : settled?.key === loadKey
      ? settled.failure
      : null;
  const loading = failure === null && settled?.key !== loadKey;
  const generation = useRef({ id: 0, key: "" });
  const acks = useRef(new Map<number, () => void>());
  // A null result means the page went away before it answered.
  const captures = useRef(new Map<number, (result: CaptureResult | null) => void>());
  const nextCapture = useRef(0);
  // Read by bridge callbacks and the unmount save, which run outside renders.
  const summaryRef = useRef<ModelSummary | null>(null);
  const viewRef = useRef<ModelCameraView | null>(null);
  const notesRef = useRef(notes);
  const wireframeRef = useRef(wireframe);
  const evidenceRef = useRef<ModelPreviewMemory["capture"]>(null);
  const initialViewHash = initialView ? formatModelViewHash(initialView) : null;

  const send = (command: ModelViewerCommand) =>
    webView.current?.injectJavaScript(modelViewerInjection(command));

  const requestCapture = (captured: ReadonlyArray<ModelNote>) =>
    new Promise<CaptureResult | null>((resolve) => {
      const requestId = ++nextCapture.current;
      captures.current.set(requestId, resolve);
      send({ type: "capture", requestId, notes: captured });
    });

  const post = useEffectEvent(send);
  const captureEvidence = useEffectEvent(requestCapture);
  const startView = useEffectEvent(
    () => viewRef.current ?? initialView ?? rememberedModels[memoryKey]?.view ?? null,
  );

  useImperativeHandle(ref, () => ({
    resetView: () => send({ type: "preset", preset: "iso" }),
  }));

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- streams the file's bytes into the WebView page, cancelling on unmount, source change or retry
  useEffect(() => {
    if (!page.ready || uri === null) return;
    const id = generation.current.id + 1;
    generation.current = { id, key: loadKey };
    const controller = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    void (async () => {
      reader = await openModelReader(uri, controller.signal);
      controller.signal.throwIfAborted();
      post({ type: "begin", id });
      await streamModelChunks(reader, controller.signal, (data) => {
        return new Promise<void>((resolve, reject) => {
          const signal = controller.signal;
          const abort = () => reject(signal.reason);
          signal.addEventListener("abort", abort, { once: true });
          acks.current.set(id, () => {
            signal.removeEventListener("abort", abort);
            resolve();
          });
          post({ type: "chunk", id, data });
        });
      });
      controller.signal.throwIfAborted();
      post({ type: "end", id, format, view: startView(), wireframe: wireframeRef.current });
    })().catch((cause: unknown) => {
      if (controller.signal.aborted) return;
      post({ type: "cancel", id });
      setSettled({
        key: loadKey,
        failure: isModelTooLargeError(cause) ? "too-large" : "unavailable",
      });
    });
    return () => {
      controller.abort();
      acks.current.delete(id);
      const open: ReadableStreamDefaultReader<Uint8Array> | null = reader;
      void open?.cancel().catch(() => undefined);
      post({ type: "cancel", id });
    };
  }, [page.ready, uri, format, loadKey]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a link opened while this model shows moves the WebView camera to its view; the first load starts there instead
  useEffect(() => {
    const view = initialViewHash ? modelViewFromHash(initialViewHash) : null;
    if (view && summaryRef.current) post({ type: "view", view });
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
    notesRef.current = notes;
    if (!page.ready || summary === null) return;
    post({
      type: "notes",
      notes,
      activeId: draft?.id ?? null,
      draft: draft?.hit ? { point: draft.hit.point, normal: draft.hit.normal } : null,
    });
  }, [page.ready, summary, notes, draft]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps a capture of the pinned view, which stays the evidence if the file changes under the notes
  useEffect(() => {
    if (summary === null || !notes.some((note) => !note.stale)) return;
    let current = true;
    const timer = setTimeout(() => {
      void captureEvidence(notes).then((result) => {
        if (current && result?.capture) {
          evidenceRef.current = { screenshot: result.capture, view: result.view };
        }
      });
    }, 500);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [summary, notes]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- remembers notes and camera when the file closes, so reopening it restores them
  useEffect(
    () => () => {
      const loaded = summaryRef.current;
      const view = viewRef.current;
      if (!loaded || !view) return;
      rememberedModels = rememberModelPreview(rememberedModels, memoryKey, {
        fingerprint: loaded.fingerprint,
        notes: notesRef.current,
        view,
        wireframe: wireframeRef.current,
        capture: evidenceRef.current,
      });
    },
    [memoryKey],
  );

  const handleEvent = (event: ModelViewerEvent) => {
    switch (event.type) {
      case "ready":
        setPage((current) => ({ ...current, ready: true }));
        return;
      case "crashed":
        for (const resolve of captures.current.values()) resolve(null);
        captures.current.clear();
        setPage((current) => ({ ...current, ready: false, crashed: true }));
        return;
      case "ack":
        acks.current.get(event.id)?.();
        acks.current.delete(event.id);
        return;
      case "failed":
        if (event.id !== generation.current.id) return;
        setSettled({ key: generation.current.key, failure: event.code });
        return;
      case "loaded": {
        if (event.id !== generation.current.id) return;
        const previous = summaryRef.current;
        const remembered = rememberedModels[memoryKey];
        if (!previous) evidenceRef.current = remembered?.capture ?? null;
        const restored = reconcileModelNotes(
          previous ? { fingerprint: previous.fingerprint, notes: notesRef.current } : remembered,
          event.summary.fingerprint,
        );
        summaryRef.current = event.summary;
        viewRef.current = event.view;
        setSummary(event.summary);
        setNotes(restored);
        if (!previous) setActivePreset(initialView || remembered ? null : "iso");
        setSettled({ key: generation.current.key, failure: null });
        return;
      }
      case "view":
        viewRef.current = event.view;
        if (event.moved) setActivePreset(null);
        return;
      case "pick":
        if (annotating && !sending) setDraft({ id: null, hit: event.hit, text: "" });
        return;
      case "pin": {
        const note = notes.find((entry) => entry.id === event.id);
        if (note && !sending) setDraft({ id: note.id, hit: null, text: note.text });
        return;
      }
      case "captured":
        captures.current.get(event.requestId)?.(event);
        captures.current.delete(event.requestId);
        return;
    }
  };

  // A fresh page and a freshly minted URL; the load waits for the new page's `ready`.
  const retry = () => {
    setPage((current) => ({ attempt: current.attempt + 1, ready: false, crashed: false }));
    onRetry();
  };

  const choosePreset = (preset: ModelViewPreset | "fit") => {
    setActivePreset(preset);
    send({ type: "preset", preset });
  };

  const saveDraft = () => {
    if (!draft) return;
    const text = draft.text.trim();
    if (!text) return;
    if (draft.id === null && draft.hit) {
      const { point, normal } = draft.hit;
      setNotes([...notes, { id: uuidv4(), text, point, normal, stale: false }]);
    } else {
      setNotes(notes.map((note) => (note.id === draft.id ? { ...note, text } : note)));
    }
    setDraft(null);
  };

  const deleteNote = (id: string) => {
    // Removing a note invalidates the numbering in its saved screenshot.
    evidenceRef.current = null;
    setNotes(notes.filter((note) => note.id !== id));
    setDraft(null);
  };

  const sendToChat = async () => {
    if (draftKey === null || summary === null || sending || notes.length === 0) return;
    setSending(true);
    const sent = notes;
    const earlier = sent.every((note) => note.stale) ? evidenceRef.current : null;
    const captured = earlier
      ? { capture: earlier.screenshot, view: earlier.view }
      : await requestCapture(sent);
    const capture: ModelCapture | null = captured?.capture ?? null;
    const staged =
      captured !== null &&
      capture !== null &&
      stageModelAnnotation(
        draftKey,
        modelAnnotationPayload({
          id: uuidv4(),
          name,
          linkPath,
          view: captured.view,
          notes: sent,
          screenshot: { ...capture, earlier: earlier !== null },
          createdAt: new Date().toISOString(),
        }),
      );
    setSending(false);
    if (!staged) {
      Dialog.alert(
        gt("Unable to add to chat"),
        capture === null
          ? gt("Try again.")
          : gt("Remove some attachments or context items from the draft, then try again."),
      );
      return;
    }
    evidenceRef.current = null;
    setNotes(notesRef.current.filter((note) => !sent.includes(note)));
    setAnnotating(false);
    setDraft(null);
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
            : gt("Could not load this 3D model. Check the connection and try again.");
  const sizeLabel = summary
    ? summary.format === "stl"
      ? gt("{size} (mm assumed, STL has no units)", { size: formatModelSize(summary.size) })
      : summary.format === "3mf"
        ? gt("{size} model units", { size: formatModelSize(summary.size) })
        : gt("{size} m", { size: formatModelSize(summary.size) })
    : null;
  const staleNotes = notes.flatMap((note, index) => (note.stale ? [{ note, index }] : []));
  const editingIndex = draft?.id ? notes.findIndex((note) => note.id === draft.id) : -1;
  const draftNumber = editingIndex >= 0 ? editingIndex + 1 : notes.length + 1;
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
              disabled={sending}
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
          {staleNotes.map(({ note, index }) => (
            <View key={note.id} className="min-h-9 flex-row items-center gap-2">
              <Text className="min-w-0 flex-1 text-xs text-warning-foreground" numberOfLines={1}>
                {index + 1}. {note.text}
              </Text>
              <Pressable
                accessibilityRole="button"
                onPress={() => deleteNote(note.id)}
                className="h-9 justify-center px-2"
              >
                <Text className="text-xs font-t3-bold text-danger-foreground">{gt("Remove")}</Text>
              </Pressable>
            </View>
          ))}
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
              {editingIndex >= 0 && draft.id !== null ? (
                <Button
                  label={gt("Delete")}
                  tone="text"
                  onPress={() => {
                    if (draft.id !== null) deleteNote(draft.id);
                  }}
                />
              ) : null}
              <View className="flex-1" />
              <Button label={gt("Cancel")} tone="text" onPress={() => setDraft(null)} />
              <Button
                label={draft.id === null ? gt("Pin") : gt("Save")}
                tone="primary"
                disabled={!draft.text.trim()}
                onPress={saveDraft}
              />
            </View>
          </View>
        </KeyboardStickyView>
      ) : null}
    </View>
  );
}
