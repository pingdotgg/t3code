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
import {
  modelAnnotationPayload,
  reconcileModelNotes,
  useModelPreviewStore,
  type ModelCameraView,
  type ModelCapture,
  type ModelNote,
  type Vec3,
} from "./modelAnnotations";
import { ModelScene, type ModelHit, type ModelViewPreset } from "./modelScene";
import { previewErrorText } from "./previewFailureMessages";

interface DraftPin {
  readonly id: string | null;
  readonly hit: ModelHit | null;
  readonly text: string;
}

const CLICK_SLOP_PX = 4;

function formatSize(size: Vec3) {
  return size.map((value) => Number(value.toPrecision(3)).toLocaleString()).join(" × ");
}

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
    const [pin] = scene.project([{ ...anchor, id: "", text: "", stale: false }]);
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
  const [scene, setScene] = useState<ModelScene | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [notes, setNotes] = useState<ReadonlyArray<ModelNote>>([]);
  const rememberedCapture = useRef<{ screenshot: ModelCapture; view: ModelCameraView } | null>(
    null,
  );
  const loadController = useRef<AbortController | null>(null);
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

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- owns the WebGL scene: loads the file, restores remembered notes and camera, and disposes everything on unmount or retry
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const controller = new AbortController();
    loadController.current = controller;
    let mounted: ModelScene | null = null;
    setError(null);
    setDraft(null);
    setSending(false);
    ModelScene.load({
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
        mounted = loaded;
        const store = useModelPreviewStore.getState();
        const memory = store.memory[props.memoryKey];
        const restoredWireframe = memory?.wireframe ?? false;
        loaded.setWireframe(restoredWireframe);
        setWireframe(restoredWireframe);
        const restored = reconcileModelNotes(memory, loaded.summary.fingerprint);
        notesRef.current = restored;
        setNotes(restored);
        rememberedCapture.current = memory?.capture ?? null;
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
        setScene(loaded);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) {
          setError(previewErrorText(cause, m(msg("This 3D model could not be read."))));
        }
      });
    return () => {
      controller.abort();
      if (!mounted) return;
      useModelPreviewStore.getState().remember(props.memoryKey, {
        fingerprint: mounted.summary.fingerprint,
        notes: notesRef.current,
        view: mounted.view,
        wireframe: readWireframe(),
        capture: rememberedCapture.current,
      });
      mounted.dispose();
      setScene(null);
    };
  }, [props.src, props.format, props.memoryKey, viewRequestKey, attempt]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- moves the WebGL camera when a clicked chat link asks for a saved view while this model is open
  useEffect(() => {
    if (!scene || !viewRequest || viewRequestKey === null) return;
    scene.setView(viewRequest);
    useModelPreviewStore.getState().consumeView(viewRequestKey);
  }, [scene, viewRequest, viewRequestKey]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- notes and the open editor are DOM overlays the scene positions, so it reads them and draws a frame after they change
  useEffect(() => {
    notesRef.current = notes;
    draftRef.current = draft;
    scene?.requestRender();
  }, [scene, notes, draft]);

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

  const rememberPins = (next: ReadonlyArray<ModelNote>) => {
    if (!scene || !next.some((note) => !note.stale)) return;
    try {
      rememberedCapture.current = { screenshot: scene.capture(next), view: scene.view };
    } catch {
      rememberedCapture.current = null;
    }
  };

  const saveDraft = () => {
    if (!draft) return;
    const text = draft.text.trim();
    if (!text) return;
    if (draft.id === null && draft.hit) {
      const { point, normal } = draft.hit;
      const next = [...notes, { id: randomUUID(), text, point, normal, stale: false }];
      setNotes(next);
      rememberPins(next);
    } else {
      setNotes(notes.map((note) => (note.id === draft.id ? { ...note, text } : note)));
    }
    setDraft(null);
  };
  const deleteNote = (id: string) => {
    // Removing a note invalidates the numbering in its saved screenshot.
    const next = notes.filter((note) => note.id !== id);
    rememberedCapture.current = null;
    rememberPins(next);
    setNotes(next);
    setDraft(null);
  };

  const sendToChat = async () => {
    const signal = loadController.current?.signal;
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
    setSending(true);
    try {
      const earlier = notes.every((note) => note.stale) ? rememberedCapture.current : null;
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
      if (!staged) throw new Error("Could not stage the model annotation");
      const next = notesRef.current.filter((note) => !notes.includes(note));
      rememberedCapture.current = null;
      rememberPins(next);
      setNotes(next);
      if (next.length === 0) setAnnotating(false);
    } catch {
      if (!signal.aborted) {
        toastManager.add({
          type: "error",
          title: gt("Unable to add to chat"),
          description: gt("Please try again."),
        });
      }
    } finally {
      if (!signal.aborted) setSending(false);
    }
  };

  const summary = scene?.summary;
  const sizeLabel = summary
    ? summary.format === "stl"
      ? gt("{size} (mm assumed, STL has no units)", { size: formatSize(summary.size) })
      : summary.format === "3mf"
        ? gt("{size} model units", { size: formatSize(summary.size) })
        : gt("{size} m", { size: formatSize(summary.size) })
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
          <span className="shrink-0 text-muted-foreground">
            {gt("{count, plural, one {1 note} other {# notes}}", { count: notes.length })}
          </span>
          <Button
            size="xs"
            disabled={sending || !scene || notes.length === 0}
            onClick={() => void sendToChat()}
          >
            {gt("{count, plural, one {Send 1 to chat} other {Send # to chat}}", {
              count: notes.length,
            })}
          </Button>
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
          <div className="absolute inset-0 flex">
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
        {notes.map((note, index) =>
          note.stale ? null : (
            <button
              key={note.id}
              type="button"
              ref={(element) => {
                if (element) pinsRef.current.set(note.id, element);
                else pinsRef.current.delete(note.id);
              }}
              aria-label={gt("Note {number}: {text}", { number: index + 1, text: note.text })}
              className="absolute top-0 left-0 flex size-5 items-center justify-center rounded-full border-2 border-background bg-primary text-3xs font-semibold text-primary-foreground data-[behind=true]:opacity-45"
              onPointerDown={(event) => event.stopPropagation()}
              onPointerUp={(event) => event.stopPropagation()}
              onClick={() => setDraft({ id: note.id, hit: null, text: note.text })}
            >
              {index + 1}
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
                if (event.key === "Enter" && !event.shiftKey) {
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
          {notes.map((note, index) =>
            note.stale ? (
              <li key={note.id} className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate">
                  {index + 1}. {note.text}
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
      <div className="flex min-h-9 shrink-0 flex-wrap items-center gap-1 border-t border-border/60 px-3 py-1 text-2xs text-muted-foreground">
        <span className="min-w-0 grow basis-48 truncate">
          <T>Drag to orbit · Shift drag to pan · Scroll to zoom</T>
        </span>
        <span ref={statusRef} className="shrink-0 font-mono" />
        {(
          [
            ["top", gt("Top", { $context: "3D view preset" })],
            ["front", gt("Front", { $context: "3D view preset" })],
            ["iso", gt("Iso", { $context: "3D view preset, isometric" })],
          ] as const satisfies ReadonlyArray<readonly [ModelViewPreset, string]>
        ).map(([preset, label]) => (
          <Button
            key={preset}
            size="micro"
            variant="ghost-muted"
            disabled={!scene}
            onClick={() => scene?.setPreset(preset)}
          >
            {label}
          </Button>
        ))}
        <Button
          size="micro"
          variant="ghost-muted"
          disabled={!scene}
          onClick={() => scene?.setPreset("fit")}
        >
          <T>Fit</T>
        </Button>
        <Toggle
          size="xs"
          variant="ghost"
          disabled={!scene}
          pressed={wireframe}
          onPressedChange={(pressed) => {
            setWireframe(pressed);
            scene?.setWireframe(pressed);
          }}
        >
          <T>Wireframe</T>
        </Toggle>
      </div>
    </div>
  );
}
