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

import { readComposerImageBytes } from "~/components/chat/composerAttachmentFiles";
import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
import { Toggle } from "~/components/ui/toggle";
import { toastManager } from "~/components/ui/toast";
import { type ComposerThreadTarget, useComposerDraftStore } from "~/composerDraftStore";
import { dataUrlToFile } from "~/lib/imageCompression";
import { m } from "~/i18n/messages";
import { cn, randomUUID } from "~/lib/utils";

import { FileSurfaceAction, FileSurfaceFailure, FileSurfaceLoading } from "./fileSurfaceChrome";
import {
  modelAnnotationPayload,
  reconcileModelNotes,
  useModelPreviewStore,
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
    if (pin) editor.style.transform = `translate(${pin.x + 16}px, ${pin.y - 12}px)`;
  }
  const status = overlays.status.current;
  if (status) {
    const { azimuth, elevation } = scene.cameraStatus;
    status.textContent = `az ${azimuth}° el ${elevation}°`;
  }
}

/**
 * Interactive STL, 3MF and GLB preview with numbered surface notes. Notes, the camera and
 * pending link views live in `useModelPreviewStore` under `memoryKey`, so a reload of a
 * changed file or a reopened tab picks them up again.
 */
export default function ModelViewer(props: {
  readonly src: string;
  readonly name: string;
  readonly format: ModelPreviewKind;
  readonly memoryKey: string;
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
  const [earlierScreenshot, setEarlierScreenshot] = useState<ModelCapture | null>(null);
  const [annotating, setAnnotating] = useState(false);
  const [wireframe, setWireframe] = useState(false);
  const [draft, setDraft] = useState<DraftPin | null>(null);
  const viewRequest = useModelPreviewStore((store) => store.viewRequests[props.memoryKey]);
  // Read by the scene's frame listener, which runs outside React renders.
  const notesRef = useRef(notes);
  const draftRef = useRef(draft);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- owns the WebGL scene: loads the file, restores remembered notes and camera, and disposes everything on unmount or retry
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const controller = new AbortController();
    let mounted: ModelScene | null = null;
    setError(null);
    ModelScene.load({ container, src: props.src, format: props.format, signal: controller.signal })
      .then((loaded) => {
        mounted = loaded;
        const store = useModelPreviewStore.getState();
        const memory = store.memory[props.memoryKey];
        const restored = reconcileModelNotes(memory, loaded.summary.fingerprint);
        notesRef.current = restored;
        setNotes(restored);
        setEarlierScreenshot(
          restored.some((note) => note.stale) ? (memory?.earlierScreenshot ?? null) : null,
        );
        const request = store.viewRequests[props.memoryKey];
        if (request) {
          loaded.setView(request);
          store.consumeView(props.memoryKey);
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
      const current = notesRef.current;
      const live = current.some((note) => !note.stale);
      const memory = useModelPreviewStore.getState().memory[props.memoryKey];
      // The file may change before it is opened again; keep a picture of where live notes were.
      useModelPreviewStore.getState().remember(props.memoryKey, {
        fingerprint: mounted.summary.fingerprint,
        notes: current,
        view: mounted.view,
        earlierScreenshot: live ? mounted.capture(current) : (memory?.earlierScreenshot ?? null),
      });
      mounted.dispose();
      setScene(null);
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Retry must load the file again.
  }, [props.src, props.format, props.memoryKey, attempt]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- moves the WebGL camera when a clicked chat link asks for a saved view while this model is open
  useEffect(() => {
    if (!scene || !viewRequest) return;
    scene.setView(viewRequest);
    useModelPreviewStore.getState().consumeView(props.memoryKey);
  }, [scene, viewRequest, props.memoryKey]);

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

  const saveDraft = () => {
    if (!draft) return;
    const text = draft.text.trim();
    if (!text) return;
    if (draft.id === null && draft.hit) {
      const { point, normal } = draft.hit;
      setNotes([...notes, { id: randomUUID(), text, point, normal, stale: false }]);
    } else {
      setNotes(notes.map((note) => (note.id === draft.id ? { ...note, text } : note)));
    }
    setDraft(null);
  };
  const deleteNote = (id: string) => {
    const deleted = notes.find((note) => note.id === id);
    // The earlier screenshot numbers the stale notes; removing one would misnumber it.
    if (deleted?.stale) setEarlierScreenshot(null);
    setNotes(notes.filter((note) => note.id !== id));
    setDraft(null);
  };

  const sendToChat = async () => {
    if (!scene || notes.length === 0) return;
    const target = props.composerDraftTarget;
    if (!target) {
      toastManager.add({
        type: "error",
        title: gt("Unable to add to chat"),
        description: gt("Open a chat for this project and try again."),
      });
      return;
    }
    const allStale = notes.every((note) => note.stale);
    const useEarlier = allStale && earlierScreenshot !== null;
    const capture = useEarlier ? earlierScreenshot : scene.capture(notes);
    const fileName = `${props.name.split("/").at(-1)}-notes.png`;
    const file = dataUrlToFile(capture.dataUrl, fileName, "image/png");
    await readComposerImageBytes(file);
    const annotation = modelAnnotationPayload({
      id: randomUUID(),
      name: props.name,
      linkPath: props.linkPath,
      view: scene.view,
      notes,
      screenshot: { ...capture, earlier: useEarlier },
      createdAt: new Date().toISOString(),
    });
    // Same shape as a browser annotation: the chip in the draft, its screenshot under its id.
    const store = useComposerDraftStore.getState();
    store.addPreviewAnnotation(target, annotation);
    store.addImage(target, {
      type: "image",
      id: annotation.id,
      name: file.name,
      mimeType: file.type,
      sizeBytes: file.size,
      previewUrl: capture.dataUrl,
      file,
    });
    setNotes([]);
    setEarlierScreenshot(null);
    setAnnotating(false);
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

  if (error) {
    return (
      <FileSurfaceFailure
        message={error}
        onRetry={() => {
          setScene(null);
          setAttempt((value) => value + 1);
        }}
      />
    );
  }

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
          <Button size="xs" disabled={notes.length === 0} onClick={() => void sendToChat()}>
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
        {scene ? null : <FileSurfaceLoading className="absolute inset-0" />}
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
            className="absolute top-0 left-0 w-60 rounded-lg border border-border bg-popover p-2 text-xs shadow-lg"
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
