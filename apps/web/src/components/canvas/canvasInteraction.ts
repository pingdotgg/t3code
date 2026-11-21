import type { CanvasDocument, CanvasOp } from "@t3tools/contracts";

import type { CanvasDocumentController } from "./canvasDocumentStore";
import {
  type CanvasShapeTool,
  duplicateNodes,
  makeShapeNode,
  topLevelSelection,
} from "./canvasNodes";
import type { CanvasEngine } from "./engine/CanvasEngine";

export type CanvasTool = "select" | "hand" | CanvasShapeTool;

const CANVAS_TOOL_KEYS: Partial<Record<string, CanvasTool>> = {
  v: "select",
  h: "hand",
  f: "frame",
  r: "rect",
  o: "ellipse",
  t: "text",
};

export type CanvasResizeHandle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

export const CANVAS_RESIZE_HANDLES: ReadonlyArray<{
  readonly handle: CanvasResizeHandle;
  readonly cursor: string;
  readonly x: number;
  readonly y: number;
}> = [
  { handle: "nw", cursor: "nwse-resize", x: 0, y: 0 },
  { handle: "n", cursor: "ns-resize", x: 0.5, y: 0 },
  { handle: "ne", cursor: "nesw-resize", x: 1, y: 0 },
  { handle: "e", cursor: "ew-resize", x: 1, y: 0.5 },
  { handle: "se", cursor: "nwse-resize", x: 1, y: 1 },
  { handle: "s", cursor: "ns-resize", x: 0.5, y: 1 },
  { handle: "sw", cursor: "nesw-resize", x: 0, y: 1 },
  { handle: "w", cursor: "ew-resize", x: 0, y: 0.5 },
];

export interface CanvasOverlayElements {
  readonly selection: HTMLDivElement;
  readonly marquee: HTMLDivElement;
  readonly draft: HTMLDivElement;
}

export interface CanvasInteractionCallbacks {
  readonly onToolChange: (tool: CanvasTool) => void;
  readonly onSelectionChange: (ids: ReadonlyArray<string>) => void;
  readonly onEditText: (id: string) => void;
  /** Runs after every viewport or document change, for overlays React does not own. */
  readonly onLayout: () => void;
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

type Gesture =
  | { kind: "pan"; pointerId: number; lastX: number; lastY: number }
  | {
      kind: "move";
      pointerId: number;
      startX: number;
      startY: number;
      moved: boolean;
      clickedId: string;
      collapseTo: string | null;
      items: Array<{ id: string; parentId: string | null; x: number; y: number; world: Rect }>;
      lastOps: CanvasOp[];
    }
  | {
      kind: "resize";
      pointerId: number;
      handle: CanvasResizeHandle;
      startX: number;
      startY: number;
      box: Rect;
      items: Array<{
        id: string;
        x: number;
        y: number;
        width: number;
        height: number;
        world: Rect;
      }>;
      lastOps: CanvasOp[];
    }
  | { kind: "marquee"; pointerId: number; startX: number; startY: number; base: string[] }
  | { kind: "draw"; pointerId: number; tool: CanvasShapeTool; startX: number; startY: number };

const DRAG_THRESHOLD = 3;

const unionRect = (rects: ReadonlyArray<Rect>): Rect | null => {
  if (rects.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const rect of rects) {
    minX = Math.min(minX, rect.x);
    minY = Math.min(minY, rect.y);
    maxX = Math.max(maxX, rect.x + rect.width);
    maxY = Math.max(maxY, rect.y + rect.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
};

const normalizedRect = (ax: number, ay: number, bx: number, by: number): Rect => ({
  x: Math.min(ax, bx),
  y: Math.min(ay, by),
  width: Math.abs(bx - ax),
  height: Math.abs(by - ay),
});

const isTypingTarget = (target: EventTarget | null) =>
  target instanceof Element &&
  target.closest("input, textarea, select, [contenteditable]") !== null;

/**
 * Pointer, wheel, and keyboard handling for one mounted canvas. Lives outside
 * React: pan, zoom, and drags drive the engine and overlay elements directly,
 * and React only hears about tool and selection changes.
 */
export class CanvasInteraction {
  private tool: CanvasTool = "select";
  private selection: string[] = [];
  private spaceHeld = false;
  private pointerInside = false;
  private gesture: Gesture | null = null;
  private frame: number | null = null;
  private queuedMove: PointerEvent | null = null;
  private hoverId: string | null = null;
  private playing = false;
  /** The node whose hover animation last started, so it fires once per entry. */
  private hoverTriggerId: string | null = null;
  private editingId: string | null = null;
  private readonly disposers: Array<() => void> = [];

  constructor(
    private readonly stage: HTMLDivElement,
    private readonly engine: CanvasEngine,
    private readonly controller: CanvasDocumentController,
    private readonly overlay: CanvasOverlayElements,
    private readonly callbacks: CanvasInteractionCallbacks,
    private readonly editable: boolean,
  ) {
    const listen = <K extends keyof HTMLElementEventMap>(
      type: K,
      handler: (event: HTMLElementEventMap[K]) => void,
      options?: AddEventListenerOptions,
    ) => {
      stage.addEventListener(type, handler, options);
      this.disposers.push(() => stage.removeEventListener(type, handler, options));
    };
    listen("pointerdown", this.handlePointerDown);
    listen("pointermove", this.handlePointerMove);
    listen("pointerup", this.handlePointerUp);
    listen("pointercancel", this.handlePointerCancel);
    listen("pointerleave", () => {
      this.pointerInside = false;
      this.setHover(null);
      this.hoverTriggerId = null;
    });
    listen("wheel", this.handleWheel, { passive: false });
    listen("dblclick", this.handleDoubleClick);
    if (editable) {
      listen("pointerenter", () => {
        this.pointerInside = true;
        this.claimIdleFocus();
      });
      listen("keydown", this.handleKeyDown);
      window.addEventListener("keydown", this.handleHoverSpace, true);
      window.addEventListener("keyup", this.handleKeyUp);
      window.addEventListener("blur", this.releaseSpace);
      this.disposers.push(() => {
        window.removeEventListener("keydown", this.handleHoverSpace, true);
        window.removeEventListener("keyup", this.handleKeyUp);
        window.removeEventListener("blur", this.releaseSpace);
      });
    }
    listen("blur", this.releaseSpace);
    this.disposers.push(engine.onViewportChange(() => this.layout()));
    this.disposers.push(controller.subscribe(() => this.handleDocumentChange()));
    this.updateCursor();
  }

  destroy() {
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    for (const dispose of this.disposers) dispose();
  }

  getTool() {
    return this.tool;
  }

  setTool(tool: CanvasTool) {
    if (this.tool === tool) return;
    this.tool = tool;
    this.updateCursor();
    this.callbacks.onToolChange(tool);
  }

  getSelection(): ReadonlyArray<string> {
    return this.selection;
  }

  setSelection(ids: ReadonlyArray<string>, notify = true) {
    const doc = this.controller.getDocument();
    const next = doc ? ids.filter((id) => doc.nodes[id]) : [];
    if (next.length === this.selection.length && next.every((id, i) => id === this.selection[i])) {
      return;
    }
    this.selection = next;
    this.engine.setSelection(next);
    this.layout();
    if (notify) this.callbacks.onSelectionChange(next);
  }

  /** Hover and press animations fire only while playing. */
  setPlaying(playing: boolean) {
    this.playing = playing;
    this.hoverTriggerId = null;
  }

  setEditing(id: string | null) {
    this.editingId = id;
    this.layout();
  }

  /** Positions selection chrome; called on viewport and document changes. */
  layout() {
    const box = this.editingId ? null : this.selectionScreenRect();
    const element = this.overlay.selection;
    if (!box || this.gesture?.kind === "marquee") {
      element.style.display = "none";
    } else {
      element.style.display = "block";
      element.style.transform = `translate(${box.x}px, ${box.y}px)`;
      element.style.width = `${box.width}px`;
      element.style.height = `${box.height}px`;
      element.dataset.handles = this.editable && this.gesture?.kind !== "move" ? "true" : "false";
    }
    this.callbacks.onLayout();
  }

  /** Fits all content, like Figma's Shift+1. */
  zoomToFit() {
    this.engine.zoomToFit(undefined, 48);
  }

  /** Fits the selection, like Figma's Shift+2. */
  zoomToSelection() {
    if (this.selection.length > 0) this.engine.zoomToFit(this.selection, 48);
  }

  zoomToActualSize() {
    const rect = this.stage.getBoundingClientRect();
    const zoom = this.engine.getViewport().zoom;
    this.engine.zoomAt(rect.width / 2, rect.height / 2, 1 / zoom);
  }

  deleteSelection() {
    const doc = this.controller.getDocument();
    if (!doc) return;
    const ids = topLevelSelection(doc, this.selection);
    if (ids.length === 0) return;
    this.controller.commit(ids.map((id) => ({ op: "delete", id })));
    this.setSelection([]);
  }

  duplicateSelection() {
    const doc = this.controller.getDocument();
    if (!doc || this.selection.length === 0) return;
    const { ops, ids } = duplicateNodes(doc, this.selection, 16);
    if (this.controller.commit(ops)) this.setSelection(ids);
  }

  nudge(dx: number, dy: number) {
    const doc = this.controller.getDocument();
    if (!doc) return;
    const ops: CanvasOp[] = topLevelSelection(doc, this.selection).map((id) => ({
      op: "update",
      id,
      patch: { x: doc.nodes[id]!.x + dx, y: doc.nodes[id]!.y + dy },
    }));
    if (ops.length > 0) this.controller.commit(ops);
  }

  private handleDocumentChange() {
    const doc = this.controller.getDocument();
    if (doc && this.selection.some((id) => !doc.nodes[id])) {
      this.setSelection(this.selection.filter((id) => doc.nodes[id]));
      return;
    }
    this.layout();
  }

  private point(event: { clientX: number; clientY: number }) {
    const rect = this.stage.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  private selectionScreenRect(): Rect | null {
    const worlds = this.selection.flatMap((id) => {
      const bounds = this.engine.getWorldBounds(id);
      return bounds ? [bounds] : [];
    });
    const world = unionRect(worlds);
    if (!world) return null;
    const topLeft = this.engine.worldToScreen(world.x, world.y);
    const bottomRight = this.engine.worldToScreen(world.x + world.width, world.y + world.height);
    return normalizedRect(topLeft.x, topLeft.y, bottomRight.x, bottomRight.y);
  }

  private updateCursor() {
    const gesture = this.gesture;
    let cursor = "default";
    if (gesture?.kind === "pan") cursor = "grabbing";
    else if (this.spaceHeld || this.tool === "hand" || !this.editable) cursor = "grab";
    else if (this.tool === "text") cursor = "text";
    else if (this.tool !== "select") cursor = "crosshair";
    this.stage.style.cursor = cursor;
  }

  private setHover(id: string | null) {
    if (this.hoverId === id) return;
    this.hoverId = id;
    this.engine.setHover(id);
  }

  /** The deepest node under the point, or its nearest ancestor, with a `trigger` animation. */
  private animatedTarget(x: number, y: number, trigger: "hover" | "press"): string | null {
    const doc = this.controller.getDocument();
    if (!doc) return null;
    let id = this.engine.hitTest(x, y, { deep: true });
    while (id) {
      const node = doc.nodes[id];
      if (!node) return null;
      if (node.animations?.some((animation) => animation.trigger === trigger)) return id;
      id = node.parentId;
    }
    return null;
  }

  private triggerHover(x: number, y: number) {
    const id = this.animatedTarget(x, y, "hover");
    if (id === this.hoverTriggerId) return;
    this.hoverTriggerId = id;
    if (id) this.engine.triggerAnimation(id, "hover");
  }

  /** Takes focus when nothing else holds it, so Space-to-pan works on hover alone. */
  private claimIdleFocus = () => {
    const active = document.activeElement;
    if (active === null || active === document.body) this.stage.focus({ preventScroll: true });
  };

  /** Space over the canvas pans even when the composer still owns keyboard focus. */
  private handleHoverSpace = (event: KeyboardEvent) => {
    if (
      !this.pointerInside ||
      event.key !== " " ||
      event.defaultPrevented ||
      event.isComposing ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      (event.target instanceof Node &&
        this.stage.contains(event.target) &&
        isTypingTarget(event.target))
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    this.stage.focus({ preventScroll: true });
    this.spaceHeld = true;
    this.updateCursor();
  };

  private releaseSpace = () => {
    this.spaceHeld = false;
    this.updateCursor();
  };

  private wantsPan(event: PointerEvent) {
    return event.button === 1 || this.spaceHeld || this.tool === "hand" || !this.editable;
  }

  private handlePointerDown = (event: PointerEvent) => {
    if (event.button !== 0 && event.button !== 1) return;
    if (isTypingTarget(event.target)) return;
    this.stage.focus({ preventScroll: true });
    const { x, y } = this.point(event);
    if (this.playing) {
      const pressed = this.animatedTarget(x, y, "press");
      if (pressed) this.engine.triggerAnimation(pressed, "press");
    }
    const handle = (event.target as Element | null)
      ?.closest("[data-canvas-handle]")
      ?.getAttribute("data-canvas-handle") as CanvasResizeHandle | null | undefined;

    if (this.wantsPan(event)) {
      this.gesture = { kind: "pan", pointerId: event.pointerId, lastX: x, lastY: y };
    } else if (handle) {
      this.beginResize(event.pointerId, handle, x, y);
    } else if (this.tool === "select") {
      this.beginSelect(event, x, y);
    } else if (this.tool !== "hand") {
      this.gesture = {
        kind: "draw",
        pointerId: event.pointerId,
        tool: this.tool,
        startX: x,
        startY: y,
      };
    }
    if (!this.gesture) return;
    event.preventDefault();
    this.stage.setPointerCapture(event.pointerId);
    this.setHover(null);
    this.updateCursor();
  };

  private beginSelect(event: PointerEvent, x: number, y: number) {
    const doc = this.controller.getDocument();
    if (!doc) return;
    const deep = event.metaKey || event.ctrlKey;
    const hit = this.engine.hitTest(x, y, { deep });
    if (!hit || doc.nodes[hit]?.locked) {
      const base = event.shiftKey ? [...this.selection] : [];
      if (!event.shiftKey) this.setSelection([]);
      this.gesture = { kind: "marquee", pointerId: event.pointerId, startX: x, startY: y, base };
      return;
    }
    let collapseTo: string | null = null;
    if (event.shiftKey) {
      this.setSelection(
        this.selection.includes(hit)
          ? this.selection.filter((id) => id !== hit)
          : [...this.selection, hit],
      );
      if (!this.selection.includes(hit)) return;
    } else if (!this.selection.includes(hit)) {
      this.setSelection([hit]);
    } else if (this.selection.length > 1) {
      collapseTo = hit;
    }
    const items = topLevelSelection(doc, this.selection).flatMap((id) => {
      const node = doc.nodes[id];
      const world = this.engine.getWorldBounds(id);
      return node && world && !node.locked
        ? [{ id, parentId: node.parentId, x: node.x, y: node.y, world }]
        : [];
    });
    this.gesture = {
      kind: "move",
      pointerId: event.pointerId,
      startX: x,
      startY: y,
      moved: false,
      clickedId: hit,
      collapseTo,
      items,
      lastOps: [],
    };
  }

  private beginResize(pointerId: number, handle: CanvasResizeHandle, x: number, y: number) {
    const doc = this.controller.getDocument();
    if (!doc) return;
    const items = topLevelSelection(doc, this.selection).flatMap((id) => {
      const node = doc.nodes[id];
      const world = this.engine.getWorldBounds(id);
      return node && world
        ? [{ id, x: node.x, y: node.y, width: node.width, height: node.height, world }]
        : [];
    });
    const box = unionRect(items.map((item) => item.world));
    if (!box) return;
    this.gesture = {
      kind: "resize",
      pointerId,
      handle,
      startX: x,
      startY: y,
      box,
      items,
      lastOps: [],
    };
  }

  private handlePointerMove = (event: PointerEvent) => {
    this.queuedMove = event;
    if (this.frame !== null) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      const queued = this.queuedMove;
      this.queuedMove = null;
      if (queued) this.processMove(queued);
    });
  };

  private processMove(event: PointerEvent) {
    const { x, y } = this.point(event);
    const gesture = this.gesture;
    if (this.playing && event.buttons === 0) this.triggerHover(x, y);
    if (!gesture) {
      if (this.editable) this.claimIdleFocus();
      if (this.editable && this.tool === "select" && !this.spaceHeld && event.buttons === 0) {
        const target = event.target as Element | null;
        this.setHover(target?.closest("[data-canvas-handle]") ? null : this.engine.hitTest(x, y));
      }
      return;
    }
    if (gesture.pointerId !== event.pointerId) return;
    const zoom = this.engine.getViewport().zoom;
    switch (gesture.kind) {
      case "pan":
        this.engine.panBy(x - gesture.lastX, y - gesture.lastY);
        gesture.lastX = x;
        gesture.lastY = y;
        break;
      case "move": {
        let dx = (x - gesture.startX) / zoom;
        let dy = (y - gesture.startY) / zoom;
        if (!gesture.moved && Math.hypot(x - gesture.startX, y - gesture.startY) < DRAG_THRESHOLD) {
          return;
        }
        if (event.shiftKey) {
          if (Math.abs(dx) > Math.abs(dy)) dy = 0;
          else dx = 0;
        }
        if (!gesture.moved) {
          gesture.moved = true;
          this.layout();
        }
        gesture.lastOps = gesture.items.map((item) => {
          const delta = this.engine.worldDeltaToLocal(item.parentId, dx, dy);
          return {
            op: "update",
            id: item.id,
            patch: {
              x: Math.round(item.x + (delta?.x ?? 0)),
              y: Math.round(item.y + (delta?.y ?? 0)),
            },
          };
        });
        this.controller.preview(gesture.lastOps);
        break;
      }
      case "resize": {
        const box = resizeBox(
          gesture.box,
          gesture.handle,
          (x - gesture.startX) / zoom,
          (y - gesture.startY) / zoom,
          event.shiftKey,
        );
        const scaleX = gesture.box.width === 0 ? 1 : box.width / gesture.box.width;
        const scaleY = gesture.box.height === 0 ? 1 : box.height / gesture.box.height;
        gesture.lastOps = gesture.items.map((item) => {
          const worldX = box.x + (item.world.x - gesture.box.x) * scaleX;
          const worldY = box.y + (item.world.y - gesture.box.y) * scaleY;
          return {
            op: "update",
            id: item.id,
            patch: {
              x: Math.round(item.x + worldX - item.world.x),
              y: Math.round(item.y + worldY - item.world.y),
              width: Math.max(1, Math.round(item.width * scaleX)),
              height: Math.max(1, Math.round(item.height * scaleY)),
            },
          };
        });
        this.controller.preview(gesture.lastOps);
        break;
      }
      case "marquee": {
        const rect = normalizedRect(gesture.startX, gesture.startY, x, y);
        this.showRect(this.overlay.marquee, rect);
        const hits = this.engine.hitTestRect(rect);
        const next = [...new Set([...gesture.base, ...hits])];
        // Live feedback on the canvas; React hears about it on release.
        this.selection = next;
        this.engine.setSelection(next);
        break;
      }
      case "draw":
        this.showRect(this.overlay.draft, normalizedRect(gesture.startX, gesture.startY, x, y));
        break;
    }
  }

  private handlePointerUp = (event: PointerEvent) => {
    const gesture = this.gesture;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    if (this.queuedMove) {
      this.processMove(this.queuedMove);
      this.queuedMove = null;
    }
    this.gesture = null;
    if (this.stage.hasPointerCapture(event.pointerId))
      this.stage.releasePointerCapture(event.pointerId);
    const { x, y } = this.point(event);
    switch (gesture.kind) {
      case "pan":
        break;
      case "move":
        if (gesture.moved) this.finishMove(gesture, x, y);
        else if (gesture.collapseTo) this.setSelection([gesture.collapseTo]);
        break;
      case "resize":
        this.finishResize(gesture);
        break;
      case "marquee": {
        this.overlay.marquee.style.display = "none";
        const next = this.selection;
        this.selection = [];
        this.setSelection(next);
        break;
      }
      case "draw":
        this.overlay.draft.style.display = "none";
        this.finishDraw(gesture, x, y);
        break;
    }
    this.updateCursor();
    this.layout();
  };

  private handlePointerCancel = (event: PointerEvent) => {
    if (this.gesture?.pointerId !== event.pointerId) return;
    this.gesture = null;
    this.overlay.marquee.style.display = "none";
    this.overlay.draft.style.display = "none";
    this.controller.cancelPreview();
    this.updateCursor();
    this.layout();
  };

  private finishMove(gesture: Extract<Gesture, { kind: "move" }>, x: number, y: number) {
    const doc = this.controller.getDocument();
    if (!doc) return;
    const world = this.engine.screenToWorld(x, y);
    const moving = new Set(gesture.items.map((item) => item.id));
    const target = this.frameAt(doc, world.x, world.y, moving);
    const ops: CanvasOp[] = [];
    for (const [index, item] of gesture.items.entries()) {
      const node = doc.nodes[item.id];
      const update = gesture.lastOps[index];
      if (!node || !update || update.op !== "update") continue;
      const currentParent = node.parentId === null ? null : doc.nodes[node.parentId];
      // Only frame and root children are reparented; groups keep their members.
      const reparentable = currentParent === null || currentParent?.type === "frame";
      if (!reparentable || target === node.parentId) {
        ops.push(update);
        continue;
      }
      const finalWorld = this.engine.getWorldBounds(item.id);
      const parentWorld = target === null ? { x: 0, y: 0 } : this.engine.getWorldBounds(target);
      if (!finalWorld || !parentWorld) {
        ops.push(update);
        continue;
      }
      ops.push(
        { op: "move", id: item.id, parentId: target },
        {
          op: "update",
          id: item.id,
          patch: {
            x: Math.round(finalWorld.x - parentWorld.x),
            y: Math.round(finalWorld.y - parentWorld.y),
          },
        },
      );
    }
    this.controller.commit(ops);
  }

  private finishResize(gesture: Extract<Gesture, { kind: "resize" }>) {
    const doc = this.controller.getDocument();
    if (!doc || gesture.lastOps.length === 0) {
      this.controller.cancelPreview();
      return;
    }
    const ops = gesture.lastOps.map((op): CanvasOp => {
      const node = op.op === "update" ? doc.nodes[op.id] : undefined;
      // A resized auto-width text box starts wrapping at its new width.
      if (op.op === "update" && node?.text && (node.text.sizing ?? "auto-width") === "auto-width") {
        return { ...op, patch: { ...op.patch, text: { ...node.text, sizing: "auto-height" } } };
      }
      return op;
    });
    this.controller.commit(ops);
  }

  private finishDraw(gesture: Extract<Gesture, { kind: "draw" }>, x: number, y: number) {
    const doc = this.controller.getDocument();
    if (!doc) return;
    const start = this.engine.screenToWorld(gesture.startX, gesture.startY);
    const end = this.engine.screenToWorld(x, y);
    const dragged = Math.hypot(x - gesture.startX, y - gesture.startY) >= DRAG_THRESHOLD;
    const world = dragged
      ? normalizedRect(start.x, start.y, end.x, end.y)
      : { x: start.x, y: start.y, width: 100, height: 100 };
    const parentId = this.frameAt(doc, start.x, start.y, new Set());
    const parentWorld = parentId ? this.engine.getWorldBounds(parentId) : null;
    const node = makeShapeNode(doc, gesture.tool, parentId, {
      ...world,
      x: world.x - (parentWorld?.x ?? 0),
      y: world.y - (parentWorld?.y ?? 0),
    });
    if (!this.controller.commit([{ op: "insert", node }])) return;
    this.setTool("select");
    this.setSelection([node.id]);
    if (node.type === "text") this.callbacks.onEditText(node.id);
  }

  /** Topmost frame under a world point, skipping the subtrees being dragged. */
  private frameAt(doc: CanvasDocument, x: number, y: number, skip: ReadonlySet<string>) {
    let found: string | null = null;
    const visit = (ids: ReadonlyArray<string>) => {
      for (const id of ids) {
        if (skip.has(id)) continue;
        const node = doc.nodes[id];
        if (!node || node.visible === false) continue;
        if (node.type === "frame") {
          const bounds = this.engine.getWorldBounds(id);
          if (
            bounds &&
            x >= bounds.x &&
            y >= bounds.y &&
            x <= bounds.x + bounds.width &&
            y <= bounds.y + bounds.height
          ) {
            found = id;
            visit(node.childIds ?? []);
          }
        }
      }
    };
    visit(doc.rootIds);
    return found;
  }

  private showRect(element: HTMLDivElement, rect: Rect) {
    element.style.display = "block";
    element.style.transform = `translate(${rect.x}px, ${rect.y}px)`;
    element.style.width = `${rect.width}px`;
    element.style.height = `${rect.height}px`;
  }

  private handleWheel = (event: WheelEvent) => {
    if (isTypingTarget(event.target)) return;
    event.preventDefault();
    let dx = event.deltaX;
    let dy = event.deltaY;
    if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) {
      dx *= 16;
      dy *= 16;
    } else if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
      dx *= this.stage.clientWidth;
      dy *= this.stage.clientHeight;
    }
    if (event.ctrlKey || event.metaKey) {
      // Trackpad pinch arrives as ctrl+wheel with small deltas.
      const { x, y } = this.point(event);
      this.engine.zoomAt(x, y, Math.exp(-dy * 0.01));
      return;
    }
    if (event.shiftKey && dx === 0) {
      dx = dy;
      dy = 0;
    }
    this.engine.panBy(-dx, -dy);
  };

  private handleDoubleClick = (event: MouseEvent) => {
    if (!this.editable || this.tool !== "select") return;
    const doc = this.controller.getDocument();
    if (!doc) return;
    const { x, y } = this.point(event);
    const hit = this.engine.hitTest(x, y, { deep: true });
    if (!hit) return;
    const node = doc.nodes[hit];
    if (node?.type === "text") {
      this.setSelection([hit]);
      this.callbacks.onEditText(hit);
      return;
    }
    this.setSelection([hit]);
  };

  private handleKeyDown = (event: KeyboardEvent) => {
    if (isTypingTarget(event.target) || event.isComposing) return;
    const mod = event.metaKey || event.ctrlKey;
    const key = event.key.toLowerCase();
    const handled = (() => {
      if (key === " ") {
        if (!this.spaceHeld) {
          this.spaceHeld = true;
          this.updateCursor();
        }
        return true;
      }
      if (mod && key === "z") {
        if (event.shiftKey) this.controller.redo();
        else this.controller.undo();
        return true;
      }
      if (mod && key === "y") {
        this.controller.redo();
        return true;
      }
      if (mod && key === "d") {
        this.duplicateSelection();
        return true;
      }
      if (mod && key === "a") {
        const doc = this.controller.getDocument();
        const parent = doc && this.selection[0] ? doc.nodes[this.selection[0]]?.parentId : null;
        const siblings = !doc ? [] : parent ? (doc.nodes[parent]?.childIds ?? []) : doc.rootIds;
        this.setSelection(siblings);
        return true;
      }
      if (mod || event.altKey) return false;
      if (event.shiftKey && event.code === "Digit1") {
        this.zoomToFit();
        return true;
      }
      if (event.shiftKey && event.code === "Digit2") {
        this.zoomToSelection();
        return true;
      }
      if (event.shiftKey && event.code === "Digit0") {
        this.zoomToActualSize();
        return true;
      }
      if (key === "delete" || key === "backspace") {
        this.deleteSelection();
        return true;
      }
      if (key === "escape") {
        if (this.tool !== "select") this.setTool("select");
        else this.setSelection([]);
        return true;
      }
      if (key === "enter") {
        const doc = this.controller.getDocument();
        const only = this.selection.length === 1 ? doc?.nodes[this.selection[0]!] : undefined;
        if (only?.type === "text") {
          this.callbacks.onEditText(only.id);
          return true;
        }
        if (only?.childIds?.length) {
          this.setSelection(only.childIds);
          return true;
        }
        return false;
      }
      const step = event.shiftKey ? 10 : 1;
      const toolForKey = event.shiftKey ? undefined : CANVAS_TOOL_KEYS[key];
      if (key === "arrowleft") this.nudge(-step, 0);
      else if (key === "arrowright") this.nudge(step, 0);
      else if (key === "arrowup") this.nudge(0, -step);
      else if (key === "arrowdown") this.nudge(0, step);
      else if (toolForKey) this.setTool(toolForKey);
      else return false;
      return true;
    })();
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  private handleKeyUp = (event: KeyboardEvent) => {
    if (event.key === " ") {
      this.releaseSpace();
    }
  };
}

function resizeBox(
  box: Rect,
  handle: CanvasResizeHandle,
  dx: number,
  dy: number,
  keepAspect: boolean,
): Rect {
  let left = box.x;
  let top = box.y;
  let right = box.x + box.width;
  let bottom = box.y + box.height;
  if (handle.includes("w")) left += dx;
  if (handle.includes("e")) right += dx;
  if (handle.includes("n")) top += dy;
  if (handle.includes("s")) bottom += dy;
  let width = Math.max(1, right - left);
  let height = Math.max(1, bottom - top);
  if (handle.includes("w")) left = right - width;
  if (handle.includes("n")) top = bottom - height;
  if (keepAspect && box.width > 0 && box.height > 0) {
    const ratio = box.width / box.height;
    const horizontal = handle === "e" || handle === "w";
    const vertical = handle === "n" || handle === "s";
    if (horizontal || (!vertical && width / ratio >= height)) height = width / ratio;
    else width = height * ratio;
    if (handle.includes("w")) left = right - width;
    if (handle.includes("n")) top = bottom - height;
  }
  return { x: left, y: top, width, height };
}
