// Exposes RegionTool and RefsLayer for board:// region references.
import { useEffect } from "react";
import { createPortal } from "react-dom";
import {
  atom,
  Box,
  react,
  StateNode,
  useEditor,
  useValue,
  type Editor,
  type TLPageId,
} from "tldraw";
import {
  boardReady,
  onBoardVisible,
  onHighlight,
  onHover,
  sendRefToChat,
  type HoverOrigin,
} from "./bridge";
import { cameraForRegion } from "./camera";

type Region = { x: number; y: number; w: number; h: number };
type RegionRef = Region & { page?: TLPageId };
const overlaps = (a: Region, b: Region) =>
  a.x + a.w > b.x && a.x < b.x + b.w && a.y + a.h > b.y && a.y < b.y + b.h;
type Mark = Region & { mode: "drag" | "highlight" | "hover"; origin?: HoverOrigin };
const mark = atom<Mark | null>("region mark", null);
const hoverMark = atom<Mark | null>("region hover mark", null);
const shownMark = () => hoverMark.get() ?? mark.get();
// The shown mark as sent to other users in presence meta; they draw it without the chat arrow.
export function markPresence() {
  const shown = shownMark();
  return shown && { x: shown.x, y: shown.y, w: shown.w, h: shown.h, mode: shown.mode };
}
let highlightTimer: number | undefined;
let areaNumber = 0; // Session-local names restart at Area 1 after a page refresh.

// tldraw 5.3.2 has no public way to stop its draw loop, which runs every animation frame while
// mounted; its private tick manager drives it. The store and sync schedule their own frames and
// keep running, so a hidden board still saves and receives edits.
type TickManager = { isPaused: boolean; start: () => void; cancelRaf?: (() => void) | null };
function setDrawing(editor: Editor, on: boolean) {
  const ticks = (editor as unknown as { _tickManager?: TickManager })._tickManager;
  if (ticks === undefined) {
    console.warn("whiteboard: tldraw has no _tickManager; a hidden board keeps drawing");
    return;
  }
  if (on && ticks.isPaused) ticks.start();
  if (!on) {
    ticks.isPaused = true;
    ticks.cancelRaf?.();
  }
}

export const REGION_TOOL = "region-ref";
// A region on a page other than the first names its page: board://p/<page id without "page:">/r/x,y,w,h.
const parseRegionRef = (ref: string): RegionRef | null => {
  const match = /^board:\/\/(?:p\/([\w-]+)\/)?r\/(-?\d+),(-?\d+),(\d+),(\d+)$/.exec(ref);
  return match
    ? {
        page: match[1] ? (`page:${match[1]}` as TLPageId) : undefined,
        x: +match[2]!,
        y: +match[3]!,
        w: +match[4]!,
        h: +match[5]!,
      }
    : null;
};
const refPage = (editor: Editor, region: RegionRef) => region.page ?? editor.getPages()[0]!.id;
function regionLink(editor: Editor, region: Region) {
  const page = editor.getCurrentPageId();
  const prefix = page === editor.getPages()[0]!.id ? "" : `p/${page.slice("page:".length)}/`;
  return `board://${prefix}r/${region.x},${region.y},${region.w},${region.h}`;
}

function dragRegion(editor: Editor): Region {
  const box = Box.FromPoints([editor.inputs.originPagePoint, editor.inputs.currentPagePoint]);
  return { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.w), h: Math.round(box.h) };
}

export class RegionTool extends StateNode {
  static override id = REGION_TOOL;
  private dragged = false;
  override onEnter() {
    this.editor.setCursor({ type: "cross", rotation: 0 });
  }
  override onPointerDown() {
    this.dragged = false;
    mark.set(null);
  }
  override onPointerMove() {
    if (!this.editor.inputs.isPointing) return;
    this.dragged ||= this.editor.inputs.isDragging;
    if (this.dragged) mark.set({ ...dragRegion(this.editor), mode: "drag" });
  }
  override onPointerUp() {
    if (this.dragged) {
      const region = dragRegion(this.editor);
      sendRefToChat(`[Area ${++areaNumber}](${regionLink(this.editor, region)})`);
    }
    mark.set(null);
    this.editor.setCurrentTool("select");
  }
  override onCancel() {
    mark.set(null);
    this.editor.setCurrentTool("select");
  }
}

export function RefsLayer() {
  const editor = useEditor();
  const current = useValue("region mark", shownMark, []);
  const others = useValue(
    "collaborator region marks",
    () =>
      editor
        .getCollaboratorsOnCurrentPage()
        .flatMap((presence) =>
          presence.meta.mark ? [{ key: presence.id, ...(presence.meta.mark as Mark) }] : [],
        ),
    [editor],
  );
  useValue("reference camera", () => editor.getCamera(), [editor]); // Subscribe so overlays follow pan and zoom.
  useEffect(() => {
    onHighlight((ref) => {
      const region = parseRegionRef(ref);
      if (!region) return;
      const page = refPage(editor, region);
      if (editor.getPage(page) && page !== editor.getCurrentPageId()) editor.setCurrentPage(page);
      // tldraw refreshes its viewport size on a throttle; a board just shown in a pane of another
      // size would frame the region for the old size.
      editor.updateViewportScreenBounds(editor.getContainer());
      editor.setCamera(cameraForRegion(region, editor.getViewportScreenBounds(), 80), {
        animation: { duration: 250 },
      });
      mark.set({ ...region, mode: "highlight" });
      window.clearTimeout(highlightTimer);
      highlightTimer = window.setTimeout(() => mark.set(null), 1600);
    });
    onHover((ref, origin) => {
      const region = ref && parseRegionRef(ref);
      // A region on another page has no place on this one; clicking the link switches pages.
      const here = region && refPage(editor, region) === editor.getCurrentPageId();
      hoverMark.set(here ? { ...region, mode: "hover", origin } : null);
    });
    let visible = true;
    onBoardVisible((next) => {
      visible = next;
      setDrawing(editor, visible);
    });
    // The editor's own startup frame restarts the loop, possibly after a hide; pause it again.
    const keepPaused = () => {
      if (!visible) setDrawing(editor, false);
    };
    editor.on("tick", keepPaused);
    const stopReady = react("board ready", () => {
      const view = editor.getViewportScreenBounds();
      if (view.w > 0 && view.h > 0) boardReady();
    });
    return () => {
      editor.off("tick", keepPaused);
      stopReady();
    };
  }, [editor]);
  const view = editor.getViewportScreenBounds();
  const toScreen = (region: Region) => {
    const topLeft = editor.pageToScreen({ x: region.x, y: region.y });
    const bottomRight = editor.pageToScreen({ x: region.x + region.w, y: region.y + region.h });
    return {
      x: topLeft.x,
      y: topLeft.y,
      w: bottomRight.x - topLeft.x,
      h: bottomRight.y - topLeft.y,
    };
  };
  const marks = [...others, ...(current ? [{ key: "self", ...current }] : [])]
    .map((m) => ({ key: m.key, mode: m.mode, ...toScreen(m) }))
    .filter((m) => overlaps(m, view));
  const arrow = current?.mode === "hover" && hoverArrow(toScreen(current), view, current.origin);
  if (!marks.length && !arrow) return null;
  return createPortal(
    <>
      {marks.length > 0 && (
        <div
          className="region-clip"
          style={{ left: view.x, top: view.y, width: view.w, height: view.h }}
        >
          {marks.map((m) => (
            <div
              key={m.key}
              className={`region-mark ${m.mode}`}
              style={{ left: m.x - view.x, top: m.y - view.y, width: m.w, height: m.h }}
            />
          ))}
        </div>
      )}
      {arrow}
    </>,
    document.body,
  );
}

// Points from the hovered chat link to its region, or from the right edge when the link has no origin;
// an off-screen region gets an edge badge pointing toward it.
function hoverArrow(target: Region, view: Region, origin?: HoverOrigin) {
  const center = { x: target.x + target.w / 2, y: target.y + target.h / 2 };
  const inView = overlaps(target, view);
  const from = origin ?? {
    x: view.x + view.w - 8,
    y: Math.max(view.y + 18, Math.min(center.y, view.y + view.h - 18)),
  };
  const tip = {
    x: Math.max(target.x, Math.min(from.x, target.x + target.w)),
    y: Math.max(target.y, Math.min(from.y, target.y + target.h)),
  };
  const edge = {
    x: Math.max(view.x + 43, Math.min(center.x, view.x + view.w - 43)),
    y: Math.max(view.y + 43, Math.min(center.y, view.y + view.h - 43)),
  };
  const [tail, head] = inView ? [from, tip] : [edge, center];
  const angle = (Math.atan2(head.y - tail.y, head.x - tail.x) * 180) / Math.PI;
  return (
    <svg className="region-arrow" aria-hidden="true">
      {inView ? (
        <g>
          <line x1={from.x} y1={from.y} x2={tip.x} y2={tip.y} />
          <path
            transform={`translate(${tip.x} ${tip.y}) rotate(${angle})`}
            d="M -9 -5 L 0 0 L -9 5 Z"
          />
        </g>
      ) : (
        <g
          className="region-arrow-edge"
          transform={`translate(${edge.x} ${edge.y}) rotate(${angle})`}
        >
          <circle r="30" />
          <path d="M -18 -5 H 5 V -13 L 22 0 L 5 13 V 5 H -18 Z" />
        </g>
      )}
    </svg>
  );
}
