import {
  formatModelSize,
  modelAnnotationPayload,
  modelNotesFitAnnotation,
  restoreModelPins,
  type ModelNote,
  type ModelPinCapture,
} from "@t3tools/client-runtime/model-preview/annotations";
import type {
  ModelHit,
  ModelScene,
  ModelViewPreset,
} from "@t3tools/client-runtime/model-preview/scene";
import type { ModelPreviewKind } from "@t3tools/shared/filePreview";
import { msg, T, useGT } from "gt-react";
import { MapPinIcon, RotateCcwIcon } from "lucide-react";
import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";

import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
import { Toggle } from "~/components/ui/toggle";
import { toastManager } from "~/components/ui/toast";
import type { ComposerThreadTarget } from "~/composerDraftStore";
import { stagePreviewAnnotation } from "~/lib/previewAnnotation";
import { m } from "~/i18n/messages";
import { cn, randomUUID } from "~/lib/utils";

import { FileSurfaceAction, FileSurfaceFailure, FileSurfaceLoading } from "./fileSurfaceChrome";
import { useModelPreviewStore } from "./modelAnnotations";
import { loadModelScene } from "./modelScene";
import { previewErrorText } from "./previewFailureMessages";

interface DraftPin {
  readonly id: string | null;
  readonly hit: ModelHit | null;
  readonly text: string;
}

const CLICK_SLOP_PX = 4;

interface Overlays {
  readonly notes: RefObject<ReadonlyArray<ModelNote>>;
  readonly draft: RefObject<DraftPin | null>;
  readonly pins: RefObject<Map<string, HTMLElement>>;
  readonly editor: RefObject<HTMLDivElement | null>;
  readonly status: RefObject<HTMLSpanElement | null>;
}

// Moves pins, the open editor and the camera readout with the model after each frame,
// straight on the DOM so orbiting never re-renders React.
function placeOverlays(scene: ModelScene, overlays: Overlays) {
  const notes = overlays.notes.current;
  const placed = scene.project(notes);
  notes.forEach((note, index) => {
    const element = overlays.pins.current.get(note.id);
    const pin = placed[index];
    if (!element || !pin) return;
    element.style.transform = `translate(${pin.x}px, ${pin.y}px) translate(-50%, -50%)`;
    element.dataset.behind = String(pin.behind);
  });
  const editing = overlays.draft.current;
  const anchor = editing?.hit
    ? { point: editing.hit.point, normal: editing.hit.normal }
    : notes.find((note) => note.id === editing?.id);
  const editor = overlays.editor.current;
  if (editor && anchor) {
    const [pin] = scene.project([anchor]);
    if (pin && editor.parentElement) {
      const x = Math.max(
        0,
        Math.min(pin.x + 16, editor.parentElement.clientWidth - editor.offsetWidth),
      );
      const y = Math.max(
        0,
        Math.min(pin.y - 12, editor.parentElement.clientHeight - editor.offsetHeight),
      );
      editor.style.transform = `translate(${x}px, ${y}px)`;
    }
  }
  const status = overlays.status.current;
  if (status) {
    const { azimuth, elevation } = scene.cameraStatus;
    status.textContent = `az ${azimuth}° el ${elevation}°`;
  }
}

/**
 * Interactive STL, 3MF and GLB preview with numbered surface notes.
 * Restores notes by asset identity and applies camera links addressed to this panel.
 */
export default function ModelViewer(props: {
  readonly src: string;
  readonly name: string;
  readonly format: ModelPreviewKind;
  readonly memoryKey: string;
  readonly viewRequestKey: string | null;
  readonly onRefreshUrl: (() => void) | undefined;
  /** Path a chat link can open, or null when the model is an attachment. */
  readonly linkPath: string | null;
  readonly composerDraftTarget: ComposerThreadTarget | undefined;
  /** Places in the file subheader for the model's stats and its view actions. */
  readonly toolbarSlots: {
    readonly stats: HTMLElement | null;
    readonly actions: HTMLElement | null;
  };
}) {
  const gt = useGT();
  const containerRef = useRef<HTMLDivElement>(null);
  const pinsRef = useRef(new Map<string, HTMLElement>());
  const editorRef = useRef<HTMLDivElement>(null);
  const statusRef = useRef<HTMLSpanElement>(null);
  const pointerDown = useRef<{ x: number; y: number } | null>(null);
  const [sceneState, setSceneState] = useState<{
    readonly scene: ModelScene;
    readonly controller: AbortController;
    readonly memoryKey: string;
    readonly viewRequestKey: string | null;
  } | null>(null);
  const installed = useRef<typeof sceneState>(null);
  const scene = sceneState?.memoryKey === props.memoryKey ? sceneState.scene : null;
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [notes, setNotes] = useState<ReadonlyArray<ModelNote>>([]);
  const captureRef = useRef<ModelPinCapture | null>(null);
  const earlierCaptureRef = useRef<ModelPinCapture | null>(null);
  const lastPinNumber = useRef(0);
  const [sending, setSending] = useState(false);
  const [annotating, setAnnotating] = useState(false);
  const [wireframe, setWireframe] = useState(false);
  const [draft, setDraft] = useState<DraftPin | null>(null);
  const viewRequestKey = props.viewRequestKey;
  const viewRequest = useModelPreviewStore((store) =>
    viewRequestKey === null ? undefined : store.viewRequests[viewRequestKey],
  );
  const readWireframe = useEffectEvent(() => wireframe);
  // Read by the scene's frame listener, which runs outside React renders.
  const notesRef = useRef(notes);
  const draftRef = useRef(draft);

  const closeScene = useEffectEvent(() => {
    const current = installed.current;
    if (!current) return;
    installed.current = null;
    current.controller.abort();
    const { scene } = current;
    useModelPreviewStore.getState().remember(current.memoryKey, {
      fingerprint: scene.summary.fingerprint,
      notes: notesRef.current,
      view: scene.view,
      wireframe: readWireframe(),
      lastPinNumber: lastPinNumber.current,
      capture: captureRef.current,
      earlierCapture: earlierCaptureRef.current,
    });
    scene.dispose();
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- releases the installed WebGL scene when the viewer closes
  useEffect(() => () => closeScene(), []);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads each asset revision and swaps WebGL scenes only after the newest load succeeds
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const controller = new AbortController();
    setError(null);
    if (installed.current && installed.current.memoryKey !== props.memoryKey) {
      closeScene();
      setSceneState(null);
      setDraft(null);
      setSending(false);
    }
    loadModelScene({
      container,
      src: props.src,
      format: props.format,
      signal: controller.signal,
      cache: attempt === 0 ? "default" : "reload",
    })
      .then((loaded) => {
        if (controller.signal.aborted) {
          loaded.dispose();
          return;
        }
        closeScene();
        setDraft(null);
        setSending(false);
        const store = useModelPreviewStore.getState();
        const memory = store.memory[props.memoryKey];
        const restoredWireframe = memory?.wireframe ?? false;
        loaded.setWireframe(restoredWireframe);
        setWireframe(restoredWireframe);
        const restored = restoreModelPins(memory, loaded.summary.fingerprint);
        notesRef.current = restored.notes;
        setNotes(restored.notes);
        captureRef.current = restored.capture;
        earlierCaptureRef.current = restored.earlierCapture;
        lastPinNumber.current = memory?.lastPinNumber ?? 0;
        const request = viewRequestKey === null ? undefined : store.viewRequests[viewRequestKey];
        if (request && viewRequestKey !== null) {
          loaded.setView(request);
          store.consumeView(viewRequestKey);
        } else if (memory?.view) {
          loaded.setView(memory.view);
        }
        const overlays = {
          notes: notesRef,
          draft: draftRef,
          pins: pinsRef,
          editor: editorRef,
          status: statusRef,
        };
        loaded.setFrameListener(() => placeOverlays(loaded, overlays));
        const next = { scene: loaded, controller, memoryKey: props.memoryKey, viewRequestKey };
        installed.current = next;
        setSceneState(next);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) {
          setError(previewErrorText(cause, m(msg("This 3D model could not be read."))));
        }
      });
    return () => {
      if (installed.current?.controller !== controller) controller.abort();
    };
  }, [props.src, props.format, props.memoryKey, viewRequestKey, attempt]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- moves the WebGL camera when a clicked chat link asks for a saved view while this model is open
  useEffect(() => {
    if (
      !sceneState ||
      sceneState.controller.signal.aborted ||
      sceneState.viewRequestKey !== viewRequestKey ||
      !viewRequest ||
      viewRequestKey === null
    ) {
      return;
    }
    sceneState.scene.setView(viewRequest);
    useModelPreviewStore.getState().consumeView(viewRequestKey);
  }, [sceneState, viewRequest, viewRequestKey]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- moves the open editor when its pinned point changes
  useEffect(() => {
    draftRef.current = draft;
    scene?.requestRender();
  }, [scene, draft]);

  const onCancelDraft = useEffectEvent(() => setDraft(null));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Escape closes the open note editor from anywhere in the window
  useEffect(() => {
    if (!draft) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancelDraft();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [draft]);

  const handlePointerDown = (event: ReactPointerEvent) => {
    pointerDown.current = { x: event.clientX, y: event.clientY };
  };
  const handlePointerUp = (event: ReactPointerEvent) => {
    const start = pointerDown.current;
    pointerDown.current = null;
    if (!annotating || !scene || !start || event.button !== 0) return;
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > CLICK_SLOP_PX) return;
    const hit = scene.pick(event.clientX, event.clientY);
    if (hit) setDraft({ id: null, hit, text: "" });
  };

  const saveDraft = () => {
    if (!draft) return;
    const text = draft.text.trim();
    if (!text) return;
    const isNew = draft.id === null && draft.hit !== null;
    let next: ReadonlyArray<ModelNote>;
    if (isNew) {
      const { point, normal } = draft.hit;
      const number = lastPinNumber.current + 1;
      next = [...notes, { id: randomUUID(), number, text, point, normal, stale: false }];
    } else {
      next = notes.map((note) => (note.id === draft.id ? { ...note, text } : note));
    }
    if (!modelNotesFitAnnotation(next)) {
      toastManager.add({
        type: "error",
        title: gt("Shorten this note or send your saved notes to chat first."),
      });
      return;
    }
    if (isNew) {
      lastPinNumber.current++;
      updatePins(next);
    } else {
      notesRef.current = next;
      setNotes(next);
    }
    setDraft(null);
  };
  const updatePins = (next: ReadonlyArray<ModelNote>) => {
    if (next.length === 0) lastPinNumber.current = 0;
    if (!next.some((note) => note.stale)) earlierCaptureRef.current = null;
    if (scene && next.some((note) => !note.stale)) {
      try {
        captureRef.current = { screenshot: scene.capture(next), view: scene.view };
      } catch {
        // Keep the last captured view if the renderer is unavailable.
      }
    } else {
      captureRef.current = null;
    }
    notesRef.current = next;
    setNotes(next);
    scene?.requestRender();
  };
  const deleteNote = (id: string) => {
    updatePins(notes.filter((note) => note.id !== id));
    setDraft(null);
  };

  const sendToChat = async () => {
    const signal = sceneState?.controller.signal;
    if (!scene || !signal || signal.aborted || sending || notes.length === 0) return;
    const target = props.composerDraftTarget;
    if (!target) {
      toastManager.add({
        type: "error",
        title: gt("Unable to add to chat"),
        description: gt("Open a chat for this project and try again."),
      });
      return;
    }
    const showSendError = () => {
      toastManager.add({
        type: "error",
        title: gt("Unable to add to chat"),
        description: gt("Please try again."),
      });
    };
    setSending(true);
    try {
      const earlier = notes.some((note) => note.stale) ? earlierCaptureRef.current : null;
      const capture = earlier?.screenshot ?? scene.capture(notes);
      const annotation = modelAnnotationPayload({
        id: randomUUID(),
        name: props.name,
        linkPath: props.linkPath,
        view: earlier?.view ?? scene.view,
        notes,
        screenshot: { ...capture, earlier: earlier !== null },
        createdAt: new Date().toISOString(),
      });
      const staged = await stagePreviewAnnotation(target, annotation, {
        requireScreenshot: true,
        signal,
      });
      if (signal.aborted) return;
      if (staged) {
        const next = notesRef.current.filter((note) => !notes.includes(note));
        updatePins(next);
        if (next.length === 0) setAnnotating(false);
      } else {
        showSendError();
      }
    } catch {
      if (!signal.aborted) showSendError();
    }
    if (!signal.aborted) setSending(false);
  };

  const summary = scene?.summary;
  const sizeLabel = summary
    ? summary.format === "stl"
      ? gt("{size} (mm assumed, STL has no units)", { size: formatModelSize(summary.size) })
      : summary.format === "3mf"
        ? gt("{size} model units", { size: formatModelSize(summary.size) })
        : gt("{size} m", { size: formatModelSize(summary.size) })
    : null;
  const staleCount = notes.filter((note) => note.stale).length;
  const editingNote = draft?.id ? notes.find((note) => note.id === draft.id) : undefined;

  const stats =
    props.toolbarSlots.stats && summary
      ? createPortal(
          gt("{format} · {count} triangles · {size}", {
            format: summary.format.toUpperCase(),
            count: new Intl.NumberFormat(undefined, { notation: "compact" }).format(
              summary.triangles,
            ),
            size: sizeLabel,
          }),
          props.toolbarSlots.stats,
        )
      : null;
  const actions =
    props.toolbarSlots.actions && summary
      ? createPortal(
          <>
            <FileSurfaceAction label={gt("Reset view")} onPress={() => scene?.setPreset("iso")}>
              <RotateCcwIcon className="size-3.5" />
            </FileSurfaceAction>
            <Toggle
              className="shrink-0"
              variant="outline"
              size="xs"
              pressed={annotating}
              onPressedChange={(pressed) => {
                setAnnotating(pressed);
                if (!pressed) setDraft(null);
              }}
            >
              <MapPinIcon className="size-3.5" />
              <T>Annotate</T>
            </Toggle>
          </>,
          props.toolbarSlots.actions,
        )
      : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      {stats}
      {actions}
      {annotating ? (
        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border/60 px-3 text-xs">
          <span className="min-w-0 flex-1 truncate">
            <T>Click the model to pin a note</T>
          </span>
          {notes.length > 0 ? (
            <>
              <span className="shrink-0 text-muted-foreground">
                {gt("{count, plural, one {1 note} other {# notes}}", { count: notes.length })}
              </span>
              <Button size="xs" disabled={sending || !scene} onClick={() => void sendToChat()}>
                {gt("{count, plural, one {Send 1 to chat} other {Send # to chat}}", {
                  count: notes.length,
                })}
              </Button>
            </>
          ) : null}
          <Button
            size="xs"
            variant="ghost-muted"
            onClick={() => {
              setAnnotating(false);
              setDraft(null);
            }}
          >
            <T>Done</T>
          </Button>
        </div>
      ) : null}
      {staleCount > 0 ? (
        <div
          role="status"
          className="shrink-0 border-b border-warning/20 bg-warning-surface px-3 py-1.5 text-2xs text-warning-foreground"
        >
          {gt(
            "{count, plural, one {The model changed after 1 note was placed. It keeps its text but is no longer pinned to the surface.} other {The model changed after # notes were placed. They keep their text but are no longer pinned to the surface.}}",
            { count: staleCount },
          )}
        </div>
      ) : null}
      <div
        role="application"
        aria-label={gt("3D view of {name}", { name: props.name })}
        className={cn("relative min-h-0 flex-1 overflow-hidden", annotating && "cursor-crosshair")}
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
      >
        <div ref={containerRef} className="absolute inset-0 bg-background" />
        {error ? (
          <div
            className={
              scene ? "absolute inset-x-0 bottom-0 flex bg-background/90" : "absolute inset-0 flex"
            }
          >
            <FileSurfaceFailure
              message={error}
              onRetry={() => {
                if (props.onRefreshUrl) props.onRefreshUrl();
                else setAttempt((value) => value + 1);
              }}
            />
          </div>
        ) : scene ? null : (
          <FileSurfaceLoading className="absolute inset-0" />
        )}
        {notes.map((note) =>
          note.stale ? null : (
            <button
              key={note.id}
              type="button"
              ref={(element) => {
                if (element) pinsRef.current.set(note.id, element);
                else pinsRef.current.delete(note.id);
              }}
              aria-label={gt("Note {number}: {text}", { number: note.number, text: note.text })}
              className="absolute top-0 left-0 flex size-5 items-center justify-center rounded-full border-2 border-background bg-primary text-3xs font-semibold text-primary-foreground data-[behind=true]:opacity-45"
              onPointerDown={(event) => event.stopPropagation()}
              onPointerUp={(event) => event.stopPropagation()}
              onClick={() => setDraft({ id: note.id, hit: null, text: note.text })}
            >
              {note.number}
            </button>
          ),
        )}
        {draft ? (
          <div
            ref={editorRef}
            className="absolute top-0 left-0 w-60 max-w-full rounded-lg border border-border bg-popover p-2 text-xs shadow-lg"
            onPointerDown={(event) => event.stopPropagation()}
            onPointerUp={(event) => event.stopPropagation()}
          >
            <Textarea
              size="sm"
              autoFocus
              value={draft.text}
              placeholder={gt("What should change here?")}
              aria-label={gt("Note")}
              onChange={(event) => setDraft({ ...draft, text: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  saveDraft();
                }
              }}
            />
            <div className="mt-2 flex items-center gap-1">
              <span className="min-w-0 flex-1 truncate font-mono text-2xs text-muted-foreground">
                {draft.hit ? gt("face {face}", { face: draft.hit.face }) : null}
              </span>
              {editingNote ? (
                <Button
                  size="xs"
                  variant="ghost-destructive"
                  onClick={() => deleteNote(editingNote.id)}
                >
                  <T>Delete</T>
                </Button>
              ) : null}
              <Button size="xs" variant="ghost-muted" onClick={() => setDraft(null)}>
                <T>Cancel</T>
              </Button>
              <Button size="xs" disabled={!draft.text.trim()} onClick={saveDraft}>
                {draft.id === null ? <T>Pin</T> : <T>Save</T>}
              </Button>
            </div>
          </div>
        ) : null}
      </div>
      {staleCount > 0 ? (
        <ol className="max-h-28 shrink-0 overflow-y-auto border-t border-border/60 px-3 py-1.5 text-2xs text-muted-foreground">
          {notes.map((note) =>
            note.stale ? (
              <li key={note.id} className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate">
                  {note.number}. {note.text}
                </span>
                <Button
                  size="micro"
                  variant="ghost-destructive"
                  onClick={() => deleteNote(note.id)}
                >
                  <T>Remove</T>
                </Button>
              </li>
            ) : null,
          )}
        </ol>
      ) : null}
      <div className="flex min-h-9 shrink-0 flex-wrap items-center justify-end gap-1 border-t border-border/60 px-3 py-1 text-2xs text-muted-foreground">
        <span ref={statusRef} className="mr-auto shrink-0 font-mono" />
        {(
          [
            ["top", gt("Top", { $context: "3D view preset" })],
            ["front", gt("Front", { $context: "3D view preset" })],
            ["iso", gt("Iso", { $context: "3D view preset, isometric" })],
          ] as const satisfies ReadonlyArray<readonly [ModelViewPreset, string]>
        ).map(([preset, label]) => (
          <Button
            key={preset}
            size="xs"
            variant="outline"
            disabled={!scene}
            onClick={() => scene?.setPreset(preset)}
          >
            {label}
          </Button>
        ))}
        <Button
          size="xs"
          variant="outline"
          disabled={!scene}
          onClick={() => scene?.setPreset("fit")}
        >
          <T>Fit</T>
        </Button>
        <Button
          size="xs"
          variant="outline"
          disabled={!scene}
          aria-pressed={wireframe}
          data-pressed={wireframe ? "" : undefined}
          onClick={() => {
            setWireframe(!wireframe);
            scene?.setWireframe(!wireframe);
          }}
        >
          <T>Wireframe</T>
        </Button>
      </div>
    </div>
  );
}
