import type { CanvasDocument, CanvasOp } from "@t3tools/contracts";
import { exportCanvasHtml } from "@t3tools/shared/canvasExport";
import { useAtomValue } from "@effect/atom-react";
import { useGT } from "gt-react";
import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { toastManager } from "~/components/ui/toast";
import { useTheme } from "~/hooks/useTheme";
import { observeResize } from "~/lib/observeResize";
import { definePluginComponent } from "~/plugins/features";
import { canvasEnvironment } from "~/state/canvas";

import { ZoomIndicator } from "../preview/ZoomIndicator";
import {
  isCanvasDocumentActive,
  onCanvasEnvironmentDisposed,
  type CanvasDocumentController,
} from "./canvasDocumentStore";
import {
  acquireCanvasEngine,
  hasCachedCanvasEngine,
  releaseCanvasEngine,
} from "./canvasEngineCache";
import { CANVAS_RESIZE_HANDLES, CanvasInteraction, type CanvasTool } from "./canvasInteraction";
import { canvasFont, measureCanvasText, resolveLineHeight } from "./canvasNodes";
import { CanvasInspector } from "./CanvasInspector";
import { CanvasToolbar, type CanvasZoomSource } from "./CanvasToolbar";
import type { CanvasEngine } from "./engine/CanvasEngine";

const BACKGROUND = { light: "#f5f5f5", dark: "#1c1c1c" } as const;

/** Last viewport per document, so docking and floating keep the view. */
const savedViewports = new Map<string, { x: number; y: number; zoom: number }>();
const viewportKey = (controller: CanvasDocumentController) =>
  `${controller.environmentId}\u0000${controller.documentId}`;
const stopViewportCleanup = onCanvasEnvironmentDisposed((environmentId) => {
  for (const key of savedViewports.keys()) {
    if (key.startsWith(`${environmentId}\u0000`)) savedViewports.delete(key);
  }
});
if (import.meta.hot) import.meta.hot.dispose(stopViewportCleanup);

export const CanvasEditor = definePluginComponent(
  "component:components/canvas/CanvasEditor",
  PluginOriginalCanvasEditor,
);

/**
 * One mounted view of a canvas document. The panel variant edits; the
 * floating variant only pans and zooms.
 */
function PluginOriginalCanvasEditor(props: {
  readonly controller: CanvasDocumentController;
  readonly variant: "panel" | "floating";
  readonly visible?: boolean;
  readonly onPopOut?: () => void;
  readonly onDelete?: () => void;
}) {
  const { controller, variant, visible = true } = props;
  const panel = variant === "panel";
  const canEdit = useAtomValue(canvasEnvironment.applyOps.permissionAtom(controller.environmentId));
  const editable = panel && canEdit;
  const gt = useGT();
  const { resolvedTheme } = useTheme();
  const backgroundRef = useRef<string>(BACKGROUND[resolvedTheme]);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const canvasHostRef = useRef<HTMLDivElement | null>(null);
  const selectionRef = useRef<HTMLDivElement | null>(null);
  const marqueeRef = useRef<HTMLDivElement | null>(null);
  const draftRef = useRef<HTMLDivElement | null>(null);
  const textEditorRef = useRef<HTMLTextAreaElement | null>(null);
  const editingRef = useRef<string | null>(null);
  const [engine, setEngine] = useState<CanvasEngine | null>(null);
  const [interaction, setInteraction] = useState<CanvasInteraction | null>(null);
  const [tool, setTool] = useState<CanvasTool>("select");
  const [selection, setSelection] = useState<ReadonlyArray<string>>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [capturing, setCapturing] = useState(false);
  // Passing the engine as a component prop makes React's dev profiler enumerate
  // millions of typed-array entries. Keep the renderer behind small callbacks.
  const zoomSource: CanvasZoomSource = {
    subscribe: (listener) => engine?.onViewportChange(listener) ?? (() => undefined),
    getSnapshot: () => Math.round((engine?.getViewport().zoom ?? 1) * 100),
  };

  const positionTextEditor = () => {
    const id = editingRef.current;
    const textarea = textEditorRef.current;
    const doc = controller.getDocument();
    if (!id || !textarea || !engine || !doc) return;
    const node = doc.nodes[id];
    const bounds = engine.getWorldBounds(id);
    if (!node?.text || !bounds) return;
    const { zoom } = engine.getViewport();
    const origin = engine.worldToScreen(bounds.x, bounds.y);
    textarea.style.transform = `translate(${origin.x}px, ${origin.y}px)`;
    textarea.style.font = canvasFont(node.text, zoom);
    textarea.style.lineHeight = `${resolveLineHeight(node.text) * zoom}px`;
    textarea.style.letterSpacing = `${(node.text.letterSpacing ?? 0) * zoom}px`;
    textarea.style.textAlign = node.text.align ?? "left";
    textarea.style.color = node.text.color;
    textarea.style.minWidth = `${Math.max(bounds.width, 8) * zoom}px`;
    textarea.style.minHeight = `${bounds.height * zoom}px`;
    textarea.style.width =
      node.text.sizing === "auto-width" ? "auto" : `${Math.max(bounds.width, 8) * zoom}px`;
  };

  const onEngineLayout = useEffectEvent(() => positionTextEditor());
  const onEngineError = useEffectEvent((message: string) =>
    toastManager.add({
      type: "error",
      title: gt("Canvas shader failed"),
      description: message,
    }),
  );
  const onAttachFailed = useEffectEvent((error: unknown) =>
    toastManager.add({
      type: "error",
      title: gt("Unable to open canvas"),
      description: error instanceof Error ? error.message : String(error),
    }),
  );

  // Cached editors reattach before paint. Cold initialization lets navigation
  // paint first instead of compiling shaders during the React commit.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- attaches the retained WebGL engine, resize observer and pointer interaction to the stage while visible
  useLayoutEffect(() => {
    if (!visible) return;
    const host = canvasHostRef.current;
    const stage = stageRef.current;
    const selectionElement = selectionRef.current;
    const marquee = marqueeRef.current;
    const draft = draftRef.current;
    if (!host || !stage || !selectionElement || !marquee || !draft) return;
    let cleanup: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let frame: number | undefined;
    const attach = () => {
      if (!isCanvasDocumentActive(controller)) return;
      try {
        const retained = acquireCanvasEngine(controller, {
          background: backgroundRef.current,
          onError: onEngineError,
        });
        const nextEngine = retained.engine;
        let stopObserving: (() => void) | undefined;
        cleanup = () => {
          stopObserving?.();
          retained.canvas.remove();
          nextEngine.destroy();
        };
        host.append(retained.canvas);
        nextEngine.setBackground(backgroundRef.current);
        nextEngine.setSuspended(false);
        const resize = () => {
          const rect = stage.getBoundingClientRect();
          nextEngine.resize(rect.width, rect.height, window.devicePixelRatio || 1);
        };
        resize();
        stopObserving = observeResize(stage, resize);

        // The floating player is much smaller than the panel, so it always fits on mount.
        let fitted = editable && savedViewports.has(viewportKey(controller));
        const saved = savedViewports.get(viewportKey(controller));
        if (saved) nextEngine.setViewport(saved);
        let fed: CanvasDocument | null = null;
        const feed = () => {
          const doc = controller.getDocument();
          if (!doc) return;
          // The ops that produced this view from the one the engine shows skip its O(n) diff.
          const change = controller.getViewChange();
          const ops = fed !== null && change.from === fed ? change.ops : null;
          nextEngine.setDocument(doc, ops ?? undefined);
          fed = doc;
          // Fit once, on the first document; an empty one must not fit its first shape.
          if (!fitted) {
            fitted = true;
            if (doc.rootIds.length > 0) nextEngine.zoomToFit(undefined, 48);
          }
        };
        // Subscribed before the interaction so overlays read the updated engine.
        feed();
        const unsubscribe = controller.subscribe(feed);
        const stopSaving = nextEngine.onViewportChange((viewport) => {
          if (isCanvasDocumentActive(controller))
            savedViewports.set(viewportKey(controller), viewport);
        });
        const unregister = controller.registerEngine(nextEngine);
        const release = cleanup;
        cleanup = () => {
          unregister();
          stopSaving();
          unsubscribe();
          stopObserving?.();
          release();
        };
        const nextInteraction = new CanvasInteraction(
          stage,
          nextEngine,
          controller,
          { selection: selectionElement, marquee, draft },
          {
            onToolChange: setTool,
            onSelectionChange: setSelection,
            onEditText: (id) => {
              editingRef.current = id;
              setEditingId(id);
            },
            onLayout: onEngineLayout,
          },
          editable,
        );
        setEngine(nextEngine);
        setInteraction(nextInteraction);
        setSelection([]);
        setTool(editable ? "select" : "hand");
        cleanup = () => {
          nextInteraction.destroy();
          unregister();
          stopSaving();
          unsubscribe();
          stopObserving?.();
          controller.cancelPreview();
          editingRef.current = null;
          setEditingId(null);
          selectionElement.style.display = "none";
          marquee.style.display = "none";
          draft.style.display = "none";
          releaseCanvasEngine(retained);
          setEngine(null);
          setInteraction(null);
        };
      } catch (error) {
        cleanup?.();
        cleanup = undefined;
        onAttachFailed(error);
      }
    };
    if (hasCachedCanvasEngine(controller)) {
      attach();
    } else {
      frame = requestAnimationFrame(() => {
        timer = setTimeout(attach, 0);
      });
    }
    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      if (timer !== undefined) clearTimeout(timer);
      cleanup?.();
    };
  }, [controller, editable, visible]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pushes the theme background color into the WebGL engine
  useEffect(() => {
    backgroundRef.current = BACKGROUND[resolvedTheme];
    engine?.setBackground(BACKGROUND[resolvedTheme]);
  }, [engine, resolvedTheme]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- starts and stops animation playback in the WebGL engine and its interaction loop
  useEffect(() => {
    engine?.setPlaying(playing);
    interaction?.setPlaying(playing);
  }, [engine, interaction, playing]);

  // While editing, the node hides so only the textarea's copy shows.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- hides the edited node in the engine and focuses the DOM textarea over it until editing ends
  useLayoutEffect(() => {
    if (!editingId || !interaction) return;
    interaction.setEditing(editingId);
    controller.preview([{ op: "update", id: editingId, patch: { opacity: 0 } }]);
    const textarea = textEditorRef.current;
    if (textarea) {
      textarea.value = controller.getDocument()?.nodes[editingId]?.text?.content ?? "";
      positionTextEditor();
      textarea.focus();
      textarea.select();
    }
    return () => {
      interaction.setEditing(null);
    };
  }, [controller, editingId, interaction, positionTextEditor]);

  const finishTextEdit = (save: boolean) => {
    const id = editingRef.current;
    const textarea = textEditorRef.current;
    editingRef.current = null;
    setEditingId(null);
    stageRef.current?.focus({ preventScroll: true });
    const node = id ? controller.getDocument()?.nodes[id] : undefined;
    if (!id || !node?.text || !textarea || !save) {
      controller.cancelPreview();
      return;
    }
    const content = textarea.value;
    if (content.trim().length === 0) {
      controller.commit([{ op: "delete", id }]);
      return;
    }
    if (content === node.text.content) {
      controller.cancelPreview();
      return;
    }
    const text = { ...node.text, content };
    const size = measureCanvasText(text);
    const sizing = text.sizing ?? "auto-width";
    const ops: CanvasOp[] = [
      {
        op: "update",
        id,
        patch:
          sizing === "auto-width"
            ? { text, width: size.width, height: size.height }
            : sizing === "auto-height"
              ? { text, height: size.height }
              : { text },
      },
    ];
    controller.commit(ops);
  };

  const copyExport = () => {
    const doc = controller.getDocument();
    if (!doc) return;
    const ids = selection.length > 0 ? selection : [undefined];
    const html = ids.map((id) => exportCanvasHtml(doc, id)).join("\n\n");
    void navigator.clipboard.writeText(html).then(
      () =>
        toastManager.add({
          type: "success",
          title:
            selection.length > 0 ? gt("Copied selection as HTML") : gt("Copied canvas as HTML"),
          description: html.includes('<script type="application/json" data-t3-canvas-shaders>')
            ? gt(
                "Shader fills require the canvas WebGL runtime. Their source is included in the export.",
              )
            : undefined,
        }),
      () => toastManager.add({ type: "error", title: gt("Unable to copy HTML") }),
    );
  };

  const downloadScreenshot = async () => {
    const doc = controller.getDocument();
    if (!engine || !doc || capturing) return;
    const nodeId = selection.length === 1 ? selection[0] : undefined;
    const name = (nodeId ? doc.nodes[nodeId]?.name : undefined) || doc.name;
    setCapturing(true);
    await downloadCanvasScreenshot(engine, nodeId, name)
      .catch(() => {
        toastManager.add({ type: "error", title: gt("Unable to download PNG") });
      })
      .finally(() => setCapturing(false));
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {panel ? (
        <CanvasToolbar
          editable={editable}
          tool={tool}
          onToolChange={(next) => {
            interaction?.setTool(next);
            stageRef.current?.focus({ preventScroll: true });
          }}
          playing={playing}
          onTogglePlaying={() => setPlaying((value) => !value)}
          zoomSource={zoomSource}
          onZoomToFit={() => interaction?.zoomToFit()}
          onExport={copyExport}
          exportLabel={
            selection.length > 0 ? gt("Copy selection as HTML") : gt("Copy canvas as HTML")
          }
          onScreenshot={() => void downloadScreenshot()}
          screenshotLabel={
            selection.length === 1
              ? gt("Download selected layer as PNG")
              : gt("Download canvas as PNG")
          }
          screenshotDisabled={engine === null || capturing}
          inspectorOpen={inspectorOpen}
          onToggleInspector={() => setInspectorOpen((value) => !value)}
          {...(props.onPopOut ? { onPopOut: props.onPopOut } : {})}
          {...(props.onDelete ? { onDelete: props.onDelete } : {})}
        />
      ) : null}
      <div className="flex min-h-0 flex-1">
        <div
          ref={stageRef}
          tabIndex={0}
          aria-label={gt("Design canvas")}
          data-canvas-stage
          className="relative min-w-0 flex-1 touch-none overflow-hidden outline-none select-none"
        >
          <div ref={canvasHostRef} className="absolute inset-0" />
          <div
            ref={selectionRef}
            data-multi={selection.length > 1}
            className="group/selection pointer-events-none absolute top-0 left-0 hidden data-[multi=true]:border data-[multi=true]:border-primary"
          >
            {CANVAS_RESIZE_HANDLES.map((handle) => (
              <div
                key={handle.handle}
                data-canvas-handle={handle.handle}
                className="pointer-events-auto absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-xs border border-primary bg-background group-data-[handles=false]/selection:hidden"
                style={{
                  left: `${handle.x * 100}%`,
                  top: `${handle.y * 100}%`,
                  cursor: handle.cursor,
                }}
              />
            ))}
          </div>
          <div
            ref={marqueeRef}
            className="pointer-events-none absolute top-0 left-0 hidden border border-primary bg-primary/10"
          />
          <div
            ref={draftRef}
            className="pointer-events-none absolute top-0 left-0 hidden border border-primary"
          />
          {editable && editingId ? (
            <textarea
              ref={textEditorRef}
              aria-label={gt("Edit text")}
              spellCheck={false}
              rows={1}
              wrap="off"
              className="absolute top-0 left-0 origin-top-left resize-none overflow-hidden border-0 bg-transparent p-0 whitespace-pre outline-none"
              onBlur={() => finishTextEdit(true)}
              onKeyDown={(event) => {
                event.stopPropagation();
                // Escape keeps the edit, like Figma; there is undo for the rest.
                if (
                  event.key === "Escape" ||
                  (event.key === "Enter" && (event.metaKey || event.ctrlKey))
                ) {
                  event.preventDefault();
                  finishTextEdit(true);
                }
              }}
              onInput={(event) => {
                const target = event.currentTarget;
                target.style.height = "auto";
                target.style.height = `${target.scrollHeight}px`;
              }}
            />
          ) : null}
          <CanvasZoomIndicator zoomSource={zoomSource} />
        </div>
        {panel && inspectorOpen ? (
          <CanvasInspector controller={controller} selection={selection} />
        ) : null}
      </div>
    </div>
  );
}

async function downloadCanvasScreenshot(
  engine: CanvasEngine,
  nodeId: string | undefined,
  name: string,
) {
  const blob = await engine.renderToBlob(nodeId ? { nodeId } : {});
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${
      name
        .replace(/[\\/:*?"<>|\p{Cc}]+/gu, " ")
        .trim()
        .slice(0, 120) || "Canvas"
    }.png`;
    anchor.click();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
}

/** Re-renders only itself, at most once per zoom percent. */
function CanvasZoomIndicator({ zoomSource }: { readonly zoomSource: CanvasZoomSource }) {
  const percent = useSyncExternalStore(zoomSource.subscribe, zoomSource.getSnapshot);
  return <ZoomIndicator zoomFactor={percent / 100} />;
}
