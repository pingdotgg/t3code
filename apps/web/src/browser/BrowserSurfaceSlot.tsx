import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { observeResize } from "../lib/observeResize";
import {
  acquireBrowserSurface,
  type BrowserSurfacePlacement,
  useBrowserSurfaceStore,
} from "./browserSurfaceStore";
import {
  type BrowserSurfaceSlotPhase,
  kickBrowserSurfaceTracking,
  trackBrowserSurfaceSlot,
} from "./browserSurfaceTracking";

const focusReplayOrigins = new WeakMap<Event, EventTarget | null>();

/** Original target of a synthetic `pointerdown` replayed from `aboveWebview` onto its slot. */
export function browserSurfaceFocusReplayTarget(event: Event): EventTarget | null {
  return focusReplayOrigins.get(event) ?? null;
}

/** An ancestor that clips the slot: its pane, the strip, the overview's frame. */
interface ClipAncestor {
  readonly element: Element;
  /** Corner radii in its own pixels: top-left, top-right, bottom-right, bottom-left. */
  readonly radii: readonly [number, number, number, number];
}

function clipAncestorsOf(element: HTMLElement): ClipAncestor[] {
  const ancestors: ClipAncestor[] = [];
  for (
    let node = element.parentElement;
    node && node !== document.body;
    node = node.parentElement
  ) {
    const style = getComputedStyle(node);
    if (style.overflowX === "visible" && style.overflowY === "visible") continue;
    ancestors.push({
      element: node,
      radii: [
        parseFloat(style.borderTopLeftRadius) || 0,
        parseFloat(style.borderTopRightRadius) || 0,
        parseFloat(style.borderBottomRightRadius) || 0,
        parseFloat(style.borderBottomLeftRadius) || 0,
      ],
    });
  }
  return ancestors;
}

const near = (value: number, edges: readonly number[]) =>
  edges.some((edge) => Math.abs(edge - value) < 1);

function resolveCornerRadii(
  corners: readonly (readonly [number, number])[],
  scale: number,
  ancestors: readonly ClipAncestor[],
  boxes: readonly DOMRect[],
) {
  return corners.map(([x, y], corner) => {
    let radius = 0;
    ancestors.forEach((ancestor, index) => {
      const own = ancestor.radii[corner]!;
      if (own <= 0) return;
      const box = boxes[index]!;
      const outer = boxes.slice(index + 1);
      const xs = [box.left, box.right, ...outer.flatMap((edge) => [edge.left, edge.right])];
      const ys = [box.top, box.bottom, ...outer.flatMap((edge) => [edge.top, edge.bottom])];
      if (!near(x, xs) || !near(y, ys)) return;
      const ownScale = box.width / Math.max(1, (ancestor.element as HTMLElement).offsetWidth || 1);
      radius = Math.max(radius, own * ownScale);
    });
    return radius / scale;
  });
}

function formatInset(insets: readonly number[], radii: readonly number[]) {
  const round = radii.some((radius) => radius > 0)
    ? ` round ${radii.map((radius) => `${radius}px`).join(" ")}`
    : "";
  return `inset(${insets.map((inset) => `${inset}px`).join(" ")}${round})`;
}

/** Max overhang (px) of portaled controls such as resize handles and coarse touch targets. */
const ABOVE_WEBVIEW_OVERHANG_PX = 16;

/** Visible `clip-path`s: `webview` clamps to the slot; `above` keeps negative
 * ancestor insets so overhanging resize handles stay unclipped on open sides. */
function resolveClipPaths(rect: DOMRect, scale: number, ancestors: readonly ClipAncestor[]) {
  if (ancestors.length === 0) return { webview: "", above: "" };
  const boxes = ancestors.map((ancestor) => ancestor.element.getBoundingClientRect());
  let clipLeft = Number.NEGATIVE_INFINITY;
  let clipTop = Number.NEGATIVE_INFINITY;
  let clipRight = Number.POSITIVE_INFINITY;
  let clipBottom = Number.POSITIVE_INFINITY;
  for (const box of boxes) {
    clipLeft = Math.max(clipLeft, box.left);
    clipTop = Math.max(clipTop, box.top);
    clipRight = Math.min(clipRight, box.right);
    clipBottom = Math.min(clipBottom, box.bottom);
  }
  const left = Math.max(rect.left, clipLeft);
  const top = Math.max(rect.top, clipTop);
  const right = Math.min(rect.right, clipRight);
  const bottom = Math.min(rect.bottom, clipBottom);
  if (right - left < 1 || bottom - top < 1) return { webview: "inset(50%)", above: "inset(50%)" };
  const radii = resolveCornerRadii(
    [
      [left, top],
      [right, top],
      [right, bottom],
      [left, bottom],
    ],
    scale,
    ancestors,
    boxes,
  );
  const insets = [top - rect.top, rect.right - right, rect.bottom - bottom, left - rect.left].map(
    (inset) => Math.max(0, inset / scale),
  );
  const webview =
    insets.every((inset) => inset < 0.5) && radii.every((radius) => radius === 0)
      ? ""
      : formatInset(insets, radii);
  const aboveInsets = [
    (clipTop - rect.top) / scale,
    (rect.right - clipRight) / scale,
    (rect.bottom - clipBottom) / scale,
    (clipLeft - rect.left) / scale,
  ];
  const above =
    webview === "" && aboveInsets.every((inset) => inset <= -ABOVE_WEBVIEW_OVERHANG_PX)
      ? ""
      : formatInset(
          aboveInsets,
          resolveCornerRadii(
            [
              [clipLeft, clipTop],
              [clipRight, clipTop],
              [clipRight, clipBottom],
              [clipLeft, clipBottom],
            ],
            scale,
            ancestors,
            boxes,
          ),
        );
  return { webview, above };
}

interface AboveWebviewWritten {
  readonly width: number;
  readonly height: number;
  readonly transform: string;
  readonly clipPath: string;
  readonly inert: boolean;
}

const aboveWebviewWritten = new WeakMap<HTMLElement, AboveWebviewWritten>();

function placeAboveWebview(
  layer: HTMLElement,
  placement: BrowserSurfacePlacement,
  clipPath: string,
  width: number,
  height: number,
  hidden: boolean,
) {
  const last = aboveWebviewWritten.get(layer);
  const transform = `translate(${placement.x}px, ${placement.y}px) scale(${placement.scale})`;
  const inert = !placement.interactive || hidden;
  if (last?.width !== width) layer.style.width = `${width}px`;
  if (last?.height !== height) layer.style.height = `${height}px`;
  if (last?.transform !== transform) layer.style.transform = transform;
  if (last?.clipPath !== clipPath) layer.style.clipPath = clipPath;
  if (last?.inert !== inert) layer.inert = inert;
  aboveWebviewWritten.set(layer, { width, height, transform, clipPath, inert });
}

export function BrowserSurfaceSlot(props: {
  readonly tabId: string;
  readonly visible: boolean;
  readonly cornerRadius?: number;
  readonly zIndex?: number;
  readonly layoutVersion?: string | number;
  readonly className?: string;
  readonly fitSourceContent?: boolean;
  readonly aboveWebview?: ReactNode;
  readonly aboveWebviewLabel?: string;
  /** Page overlays (find bar, agent cursor) that must paint above the webview. */
  readonly children?: ReactNode;
}) {
  const {
    tabId,
    visible,
    cornerRadius = 0,
    zIndex = 30,
    layoutVersion,
    className,
    fitSourceContent = false,
    aboveWebview,
    aboveWebviewLabel,
    children,
  } = props;
  const presentationRef = useRef({ visible, cornerRadius, zIndex });
  const updateRef = useRef<((phase: BrowserSurfaceSlotPhase) => boolean) | null>(null);
  const aboveWebviewRef = useRef<HTMLDivElement | null>(null);
  const slotRef = useRef<HTMLDivElement | null>(null);
  const [lifted, setLifted] = useState<{ zIndex: number; container: Element } | null>(null);
  const liftedRect = useBrowserSurfaceStore((state) =>
    lifted === null ? null : (state.byTabId[tabId]?.rect ?? null),
  );

  // The lease lives as long as this element for one tab, so the ref callback owns it.
  const attachSurface = (element: HTMLDivElement) => {
    slotRef.current = element;
    let lease = acquireBrowserSurface(tabId, fitSourceContent);
    // The webview lives in a fixed layer outside the slot, so a sheet's stacking context would cover
    // it. Lift it above the sheet, and its overlays with it, since they cannot leave the sheet's context.
    const sheet = element.closest('[data-slot="sheet-viewport"]');
    const minZIndex = sheet ? Number(getComputedStyle(sheet).zIndex) + 1 || 0 : 0;
    if (sheet?.parentElement && minZIndex > 0) {
      setLifted({ zIndex: minZIndex, container: sheet.parentElement });
    }
    let ancestors = clipAncestorsOf(element);
    let presented = "";
    let placed: BrowserSurfacePlacement | null = null;
    let placedAboveClip = "";
    let placedHidden = false;
    // The webview keeps the slot's own size and follows it on screen with a
    // transform, so a pane sliding or zooming never resizes the page.
    const update = (
      phase: BrowserSurfaceSlotPhase,
      scheduleWrite?: (write: () => void) => void,
    ) => {
      const rect = element.getBoundingClientRect();
      const hidden = element.offsetWidth === 0 || element.offsetHeight === 0;
      const width = Math.max(1, element.offsetWidth);
      const height = Math.max(1, element.offsetHeight);
      const presentation = presentationRef.current;
      const effectiveZIndex = Math.max(presentation.zIndex, minZIndex);
      const shown = presentation.visible && !hidden;
      if (phase !== "frame") ancestors = clipAncestorsOf(element);
      const key = `${width}:${height}:${shown}:${presentation.cornerRadius}:${effectiveZIndex}`;
      const presentationChanged = key !== presented;
      // Position alone reaches the store once it settles; size and visibility at once.
      let ownsSurface = true;
      if (presentationChanged || phase !== "frame") {
        const box = {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width,
          height,
        };
        if (!lease.present(box, shown, presentation.cornerRadius, effectiveZIndex)) {
          // Another slot took the tab (the mini player); a visible one takes it back,
          // but not every frame, so two never trade it back and forth.
          if (!shown || phase === "frame") {
            ownsSurface = false;
          } else {
            lease.release();
            lease = acquireBrowserSurface(tabId, fitSourceContent);
            lease.present(box, shown, presentation.cornerRadius, effectiveZIndex);
          }
        }
        if (ownsSurface) presented = key;
      }
      if (!ownsSurface && !aboveWebviewRef.current) return false;
      const scale = rect.width / width;
      const clips = resolveClipPaths(rect, scale, ancestors);
      const next: BrowserSurfacePlacement = {
        x: rect.x,
        y: rect.y,
        scale,
        clipPath: clips.webview,
        // Under the overview (aria-hidden) or off the focused workspace mid-switch (inert).
        interactive: element.closest('[inert], [aria-hidden="true"]') === null,
      };
      const moved =
        placed === null ||
        Math.abs(placed.x - next.x) > 0.01 ||
        Math.abs(placed.y - next.y) > 0.01 ||
        Math.abs(placed.scale - next.scale) > 0.0001 ||
        placed.clipPath !== next.clipPath ||
        placed.interactive !== next.interactive;
      const aboveChanged = placedAboveClip !== clips.above || placedHidden !== hidden;
      const shouldPlaceWebview = ownsSurface && (moved || phase !== "frame");
      const shouldPlaceAbove =
        aboveWebviewRef.current !== null &&
        (moved || aboveChanged || presentationChanged || phase !== "frame");
      if (shouldPlaceWebview || shouldPlaceAbove) {
        const apply = () => {
          if (shouldPlaceWebview) lease.place(next);
          if (shouldPlaceAbove && aboveWebviewRef.current) {
            placeAboveWebview(aboveWebviewRef.current, next, clips.above, width, height, hidden);
          }
        };
        if (scheduleWrite) scheduleWrite(apply);
        else apply();
      }
      placed = next;
      placedAboveClip = clips.above;
      placedHidden = hidden;
      return moved || aboveChanged;
    };
    updateRef.current = update;
    update("start");
    const stopTracking = trackBrowserSurfaceSlot(element, update);
    const observed: Element[] = [element];
    // Inline shells animate without resizing the slot, so observe the shell too.
    const panel = element.closest('[data-preview-panel-mode="inline"]');
    if (panel) observed.push(panel);
    // Sidebar width changes move the slot without changing its size or column offset.
    observed.push(...document.querySelectorAll('[data-slot="sidebar-gap"]'));
    const stopObserving = observeResize(observed, () => {
      update("start");
      kickBrowserSurfaceTracking();
    });
    return () => {
      if (slotRef.current === element) slotRef.current = null;
      stopObserving();
      stopTracking();
      if (updateRef.current === update) updateRef.current = null;
      lease.release();
    };
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pushes visibility, radius and stacking to the desktop browser surface after layout
  useLayoutEffect(() => {
    presentationRef.current = { visible, cornerRadius, zIndex };
    updateRef.current?.("start");
  }, [
    cornerRadius,
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A layoutVersion bump means the slot moved without resizing, so it re-presents at the new position.
    layoutVersion,
    visible,
    zIndex,
  ]);

  const attachAboveWebview = (node: HTMLDivElement | null) => {
    aboveWebviewRef.current = node;
    if (node) updateRef.current?.("start");
  };

  return (
    <>
      <div ref={attachSurface} className={className} data-browser-surface-slot={tabId} />
      {aboveWebview === undefined
        ? null
        : createPortal(
            <div
              ref={attachAboveWebview}
              role={aboveWebviewLabel ? "region" : undefined}
              aria-label={aboveWebviewLabel}
              onPointerDownCapture={(event) => {
                // Portaled controls claim pane focus through their slot, as guest presses do.
                const replay = new PointerEvent("pointerdown", {
                  bubbles: true,
                  pointerType: event.pointerType,
                });
                focusReplayOrigins.set(replay, event.target);
                slotRef.current?.dispatchEvent(replay);
              }}
              className="pointer-events-none fixed top-0 left-0 origin-top-left"
              style={{
                zIndex: Math.max(zIndex, lifted?.zIndex ?? 0) + 1,
                borderRadius: cornerRadius,
              }}
            >
              {aboveWebview}
            </div>,
            document.body,
          )}
      {lifted === null
        ? children
        : liftedRect && visible
          ? createPortal(
              // In the sheet's portal and marked as a nested portal, so the dialog keeps treating
              // it as its own content for focus, outside presses and aria-hidden.
              <div
                className="pointer-events-none fixed overflow-hidden"
                style={{
                  left: liftedRect.x,
                  top: liftedRect.y,
                  width: liftedRect.width,
                  height: liftedRect.height,
                  zIndex: Math.max(zIndex, lifted.zIndex) + 1,
                }}
                data-browser-surface-overlay={tabId}
                data-base-ui-portal=""
              >
                {children}
              </div>,
              lifted.container,
            )
          : null}
    </>
  );
}
