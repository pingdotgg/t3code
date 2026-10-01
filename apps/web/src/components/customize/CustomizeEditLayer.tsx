import type { InterfaceLayout } from "@t3tools/contracts";
import {
  ArrowLeftIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  LockIcon,
  MinusIcon,
  Undo2Icon,
} from "lucide-react";
import {
  type KeyboardEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  getClientSettings,
  useClientSetting,
  useClientSettings,
  useLegacySidebarEnabled,
} from "../../hooks/useSettings";

import {
  INTERFACE_SURFACES,
  type InterfaceElementDefinition,
  type InterfaceElementId,
  type InterfaceSurfaceId,
  isDefaultSurfaceLayout,
  moveSurfaceElementBefore,
  resetSurfaceLayout,
  resolveSurfaceLayout,
  setSurfaceElementHidden,
} from "../../interfaceLayout";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import {
  type DropTarget,
  type PlacedElement,
  type Rect,
  hasOpenCustomizePopup,
  isCustomizeAboveModeTarget,
  isMovable,
  moveCustomizeElementByKeyboard,
  readingOrder,
  resolveCustomizeFocusTarget,
  resolveCustomizeMoveOrder,
  resolveCustomizeRowTarget,
  resolveCustomizeTabTarget,
  resolveDropTarget,
  shouldMoveCustomizeHideFocus,
  unionRect,
} from "./customizeEdit.logic";
import {
  type ComposerPreview,
  type EditSurface,
  useCustomizeInterfaceStore,
} from "./customizeInterfaceStore";
import {
  createSamplePicker,
  queryCustomizeElements,
  readElementRect,
  readVisibleRect,
  SURFACE_SELECTORS,
  useLiveMeasure,
} from "./customizeTargets";
import { useCustomizeActions } from "./useCustomizeActions";

const EDIT_SURFACES: Record<
  EditSurface,
  { title: string; note?: string; layoutSurfaces: ReadonlyArray<InterfaceSurfaceId> }
> = {
  threadRow: {
    title: "Thread rows",
    note: "Changes apply to every row",
    layoutSurfaces: ["threadRow"],
  },
  chatHeader: { title: "Header", layoutSurfaces: ["chatHeader"] },
  composer: { title: "Composer", layoutSurfaces: ["composerToolbar", "composerContextBar"] },
};

interface MeasuredElement extends PlacedElement {
  readonly id: InterfaceElementId<InterfaceSurfaceId>;
  readonly surface: InterfaceSurfaceId;
  readonly definition: InterfaceElementDefinition;
}

interface Measurement {
  readonly root: Rect | null;
  readonly elements: ReadonlyArray<MeasuredElement>;
}

const definitionOf = (surface: InterfaceSurfaceId, id: string) =>
  (INTERFACE_SURFACES[surface] as ReadonlyArray<InterfaceElementDefinition>).find(
    (definition) => definition.id === id,
  );

function measureIn(
  root: ParentNode,
  surfaces: ReadonlyArray<InterfaceSurfaceId>,
): MeasuredElement[] {
  return surfaces.flatMap((surface) =>
    INTERFACE_SURFACES[surface].flatMap((definition) => {
      // Responsive variants share a key; only one of them is showing.
      const rect =
        queryCustomizeElements(root, `${surface}:${definition.id}`)
          .map(readVisibleRect)
          .find((candidate) => candidate !== null) ?? null;
      return rect ? [{ id: definition.id, rect, surface, definition }] : [];
    }),
  );
}

const pickThreadRow = createSamplePicker(
  "[data-thread-item]",
  (row) => measureIn(row, ["threadRow"]).length,
);

/** Keep one fully visible sample while editing instead of hopping between rows. */
function measureThreadRow(): Measurement {
  const row = pickThreadRow();
  return row
    ? { root: readVisibleRect(row), elements: measureIn(row, ["threadRow"]) }
    : { root: null, elements: [] };
}

export function measureSurface(surface: EditSurface): Measurement {
  if (surface === "threadRow") return measureThreadRow();
  const selector = surface === "chatHeader" ? SURFACE_SELECTORS.header : SURFACE_SELECTORS.composer;
  const container = document.querySelector(selector);
  if (!container) return { root: null, elements: [] };
  // The context bar renders just outside the composer shell.
  const scope = surface === "composer" ? (container.parentElement ?? container) : container;
  const elements = measureIn(scope, EDIT_SURFACES[surface].layoutSurfaces);
  const root =
    surface === "chatHeader"
      ? unionRect(elements.map((element) => element.rect))
      : unionRect(
          [readElementRect(container), ...elements.map((element) => element.rect)].filter(
            (rect) => rect !== null,
          ),
        );
  return { root, elements };
}

const area = (rect: Rect) => (rect.right - rect.left) * (rect.bottom - rect.top);

const pad = (rect: Rect, amount: number): Rect => ({
  left: rect.left - amount,
  top: rect.top - amount,
  right: rect.right + amount,
  bottom: rect.bottom + amount,
});

/** Four panels dim everything around the hole, leaving the surface lit and live. */
function dimPanels(hole: Rect | null) {
  if (!hole) return [{ key: "all", style: { inset: 0 } }];
  return [
    { key: "top", style: { left: 0, right: 0, top: 0, height: Math.max(0, hole.top) } },
    { key: "bottom", style: { left: 0, right: 0, top: hole.bottom, bottom: 0 } },
    {
      key: "left",
      style: {
        left: 0,
        width: Math.max(0, hole.left),
        top: hole.top,
        height: hole.bottom - hole.top,
      },
    },
    {
      key: "right",
      style: { left: hole.right, right: 0, top: hole.top, height: hole.bottom - hole.top },
    },
  ];
}

interface DragState {
  readonly element: MeasuredElement;
  readonly startX: number;
  readonly x: number;
  readonly y: number;
  readonly moved: boolean;
}

const COMPOSER_PREVIEW_OPTIONS: ReadonlyArray<{ value: ComposerPreview; label: string }> = [
  { value: "live", label: "Automatic" },
  { value: "expanded", label: "Expanded" },
  { value: "collapsed", label: "Collapsed" },
];

/**
 * Editing one surface in place: its elements get a hide badge and can be
 * dragged, or moved with the arrow keys, to a new position. Hidden elements
 * wait in a shelf beside the surface. Everything else is dimmed; Back and
 * Done are explicit exits.
 */
export function CustomizeEditLayer({
  surface,
  onBack,
  onDone,
}: {
  surface: EditSurface;
  onBack: () => void;
  onDone: () => void;
}) {
  const config = EDIT_SURFACES[surface];
  const measurement = useLiveMeasure(() => measureSurface(surface), surface);
  const layout = useClientSetting("interfaceLayout");
  const legacySidebar = useLegacySidebarEnabled();
  const movable = (element: MeasuredElement) =>
    isMovable(element.surface, element.id, element.definition.sortable === true, legacySidebar);
  const historyLength = useCustomizeInterfaceStore((store) => store.history.length);
  const composerPreview = useCustomizeInterfaceStore((store) => store.composerPreview);
  const setComposerPreview = useCustomizeInterfaceStore((store) => store.setComposerPreview);
  const { commit, commitLayout, undo } = useCustomizeActions();
  const [drag, setDrag] = useState<DragState | null>(null);

  const layerRef = useRef<HTMLDivElement>(null);
  const shelfRef = useRef<HTMLDivElement>(null);
  const lastFocusRef = useRef<HTMLElement | null>(null);
  const instructionId = useId();
  const [announcement, setAnnouncement] = useState({ text: "", sequence: 0 });
  const announce = (text: string) =>
    setAnnouncement((previous) => ({ text, sequence: previous.sequence + 1 }));
  const handles = useMemo(
    () =>
      readingOrder(measurement.elements).filter(
        (element) => !resolveSurfaceLayout(element.surface, layout).hidden.has(element.id),
      ),
    [measurement.elements, layout],
  );
  const handleKeys = new Map(
    handles.map((element, index) => [`${element.surface}:${element.id}`, index]),
  );
  const handleFor = useCallback(
    (key: string) =>
      [...(layerRef.current?.querySelectorAll<HTMLElement>("[data-customize-handle]") ?? [])].find(
        (element) => element.dataset.customizeHandle === key,
      ),
    [],
  );

  // Keep focus on editing controls when a handle disappears or becomes disabled.
  useLayoutEffect(() => {
    const layer = layerRef.current;
    const focusLost =
      !lastFocusRef.current ||
      !lastFocusRef.current.isConnected ||
      document.activeElement === document.body ||
      lastFocusRef.current.matches(":disabled");
    if (
      !layer ||
      !focusLost ||
      isCustomizeAboveModeTarget(document.activeElement) ||
      hasOpenCustomizePopup()
    )
      return;
    const first = handles[0];
    const target =
      resolveCustomizeFocusTarget(layer, lastFocusRef.current) ??
      (first ? handleFor(`${first.surface}:${first.id}`) : null) ??
      layer.querySelector<HTMLElement>("[data-customize-back]");
    target?.focus({ preventScroll: true });
  }, [handles, handleFor]);

  useEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    const isAboveMode = (target: EventTarget | null) =>
      isCustomizeAboveModeTarget(target) || hasOpenCustomizePopup();
    const focusInside = () => {
      const target =
        resolveCustomizeFocusTarget(layer, lastFocusRef.current) ??
        layer.querySelector<HTMLElement>("[data-customize-handle], [data-customize-back]");
      target?.focus({ preventScroll: true });
    };
    const onFocus = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (layer.contains(target)) lastFocusRef.current = target;
      else if (!isAboveMode(target)) focusInside();
    };
    const onPointerDown = (event: globalThis.PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Element &&
        !isAboveMode(target) &&
        (!layer.contains(target) ||
          !target.closest("button, input, select, textarea, a[href], [tabindex]"))
      )
        event.preventDefault();
    };
    const onTab = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Tab" || event.defaultPrevented || event.isComposing) return;
      if (isAboveMode(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      resolveCustomizeTabTarget(layer, document.activeElement, event.shiftKey)?.focus({
        preventScroll: true,
      });
    };
    document.addEventListener("focusin", onFocus, true);
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onTab, true);
    return () => {
      document.removeEventListener("focusin", onFocus, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onTab, true);
    };
  }, []);

  const sortableIn = (layoutSurface: InterfaceSurfaceId) =>
    measurement.elements.filter(
      (element) =>
        element.surface === layoutSurface &&
        movable(element) &&
        !resolveSurfaceLayout(layoutSurface, getClientSettings().interfaceLayout).hidden.has(
          element.id,
        ),
    );
  const dropTarget: DropTarget | null =
    drag?.moved && movable(drag.element)
      ? resolveDropTarget(sortableIn(drag.element.surface), drag.element.id, drag.x)
      : null;

  const stackOrder = new Map(
    measurement.elements
      .toSorted((a, b) => area(b.rect) - area(a.rect))
      .map((element, index) => [`${element.surface}:${element.id}`, 10 + index]),
  );

  const setHidden = (
    layoutSurface: InterfaceSurfaceId,
    id: InterfaceElementId<InterfaceSurfaceId>,
    hidden: boolean,
    fromHandle = false,
  ) => {
    commitLayout((current) => {
      if (resolveSurfaceLayout(layoutSurface, current).hidden.has(id) === hidden) return current;
      const next = setSurfaceElementHidden(current, layoutSurface, id, hidden);
      if (
        fromHandle &&
        hidden &&
        shouldMoveCustomizeHideFocus(document.activeElement, `${layoutSurface}:${id}`)
      ) {
        const index = handles.findIndex(
          (element) => element.surface === layoutSurface && element.id === id,
        );
        const neighbour = handles[index + 1] ?? handles[index - 1];
        const target = neighbour
          ? handleFor(`${neighbour.surface}:${neighbour.id}`)
          : layerRef.current?.querySelector<HTMLElement>("[data-customize-back]");
        if (index >= 0) target?.focus({ preventScroll: true });
      }
      const resolved = resolveSurfaceLayout(layoutSurface, next);
      const enabled = resolved.order.filter((item) => !resolved.hidden.has(item));
      const label = definitionOf(layoutSurface, id)?.label ?? id;
      announce(
        hidden
          ? `Hidden ${label}`
          : `Restored ${label} to position ${enabled.indexOf(id) + 1} of ${enabled.length}`,
      );
      return next;
    });
  };
  const announceMove = (
    layoutSurface: InterfaceSurfaceId,
    id: InterfaceElementId<InterfaceSurfaceId>,
    next: InterfaceLayout,
  ) => {
    const resolved = resolveSurfaceLayout(layoutSurface, next);
    const hidden = resolved.hidden.has(id);
    const order = hidden
      ? resolved.order
      : resolved.order.filter((item) => !resolved.hidden.has(item));
    announce(
      `Moved ${definitionOf(layoutSurface, id)?.label ?? id} to position ${order.indexOf(id) + 1} of ${order.length}${hidden ? ". Item remains hidden." : ""}`,
    );
  };
  const moveBefore = (
    layoutSurface: InterfaceSurfaceId,
    id: InterfaceElementId<InterfaceSurfaceId>,
    beforeId: string | null,
  ) => {
    commitLayout((current) => {
      const next = moveSurfaceElementBefore(current, layoutSurface, id, beforeId);
      if (next !== current) announceMove(layoutSurface, id, next);
      return next;
    });
  };

  const moveStep = (
    layoutSurface: InterfaceSurfaceId,
    id: InterfaceElementId<InterfaceSurfaceId>,
    direction: "left" | "right",
    measuredIds: ReadonlySet<string> | null = null,
  ) => {
    // Resolve every step after earlier queued edits, even before their writes persist.
    commitLayout((current) => {
      const next = moveCustomizeElementByKeyboard(
        current,
        layoutSurface,
        id,
        direction,
        measuredIds,
        legacySidebar,
      );
      const label = definitionOf(layoutSurface, id)?.label ?? id;
      if (next !== current) {
        if (measuredIds === null) {
          const resolved = resolveSurfaceLayout(layoutSurface, next);
          announce(
            `Moved ${label} to list position ${resolved.order.indexOf(id) + 1} of ${resolved.order.length}${resolved.hidden.has(id) ? ". Item remains hidden." : ""}`,
          );
        } else announceMove(layoutSurface, id, next);
      } else if (
        resolveCustomizeMoveOrder(current, layoutSurface, measuredIds, legacySidebar).includes(id)
      ) {
        announce(`${label} can't move ${direction === "left" ? "earlier" : "later"}`);
      }
      return next;
    });
  };

  const dragRef = useRef<DragState | null>(null);
  const dragFrameRef = useRef(0);
  const dragCaptureRef = useRef<{ button: HTMLButtonElement; pointerId: number } | null>(null);
  const releaseDragCapture = useCallback(() => {
    const capture = dragCaptureRef.current;
    dragCaptureRef.current = null;
    if (capture?.button.hasPointerCapture(capture.pointerId))
      capture.button.releasePointerCapture(capture.pointerId);
  }, []);
  const cancelDrag = () => {
    releaseDragCapture();
    if (dragFrameRef.current) window.cancelAnimationFrame(dragFrameRef.current);
    dragFrameRef.current = 0;
    dragRef.current = null;
    setDrag(null);
  };
  useEffect(() => {
    const layer = layerRef.current;
    const cancel = () => {
      releaseDragCapture();
      if (dragFrameRef.current) window.cancelAnimationFrame(dragFrameRef.current);
      dragFrameRef.current = 0;
      dragRef.current = null;
      setDrag(null);
    };
    layer?.addEventListener("customize-cancel-drag", cancel);
    return () => {
      layer?.removeEventListener("customize-cancel-drag", cancel);
      releaseDragCapture();
      if (dragFrameRef.current) window.cancelAnimationFrame(dragFrameRef.current);
    };
  }, [releaseDragCapture]);
  const onPointerDown = (element: MeasuredElement) => (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || !movable(element)) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragCaptureRef.current = { button: event.currentTarget, pointerId: event.pointerId };
    dragRef.current = {
      element,
      startX: event.clientX,
      x: event.clientX,
      y: event.clientY,
      moved: false,
    };
    setDrag(dragRef.current);
  };
  const onPointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    const current = dragRef.current;
    if (!current) return;
    dragRef.current = {
      ...current,
      x: event.clientX,
      y: event.clientY,
      moved: current.moved || Math.abs(event.clientX - current.startX) > 4,
    };
    if (!dragFrameRef.current)
      dragFrameRef.current = window.requestAnimationFrame(() => {
        dragFrameRef.current = 0;
        setDrag(dragRef.current);
      });
  };
  const onPointerUp = (event: PointerEvent<HTMLButtonElement>) => {
    const current = dragRef.current;
    if (current?.moved) {
      const target = resolveDropTarget(
        sortableIn(current.element.surface),
        current.element.id,
        event.clientX,
      );
      if (target) moveBefore(current.element.surface, current.element.id, target.beforeId);
    }
    cancelDrag();
  };
  const onKeyDown = (element: MeasuredElement) => (event: KeyboardEvent<HTMLButtonElement>) => {
    if ((event.key === "Delete" || event.key === "Backspace") && !element.definition.required) {
      event.preventDefault();
      setHidden(element.surface, element.id, true, true);
      return;
    }
    if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && movable(element)) {
      event.preventDefault();
      const measuredIds = new Set(
        measurement.elements
          .filter((candidate) => candidate.surface === element.surface)
          .map((candidate) => candidate.id),
      );
      const direction = event.key === "ArrowLeft" ? "left" : "right";
      moveStep(element.surface, element.id, direction, measuredIds);
    }
  };

  const isDefault = config.layoutSurfaces.every((layoutSurface) =>
    isDefaultSurfaceLayout(layoutSurface, layout),
  );

  const root = measurement.root ? pad(measurement.root, 6) : null;
  const [viewport, setViewport] = useState(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  useEffect(() => {
    const onResize = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const { width: viewportWidth, height: viewportHeight } = viewport;
  const [shelfSize, setShelfSize] = useState({ width: 272, height: 320 });
  useLayoutEffect(() => {
    const shelf = shelfRef.current;
    if (!shelf) return;
    const observer = new ResizeObserver(() => {
      const { width, height } = shelf.getBoundingClientRect();
      setShelfSize((previous) =>
        previous.width === width && previous.height === height ? previous : { width, height },
      );
    });
    observer.observe(shelf);
    return () => observer.disconnect();
  }, []);
  const shelfLeft = !root
    ? (viewportWidth - shelfSize.width) / 2
    : surface === "threadRow"
      ? root.right + 12
      : root.right - shelfSize.width;
  const shelfTop = !root
    ? 72
    : surface === "threadRow"
      ? root.top
      : surface === "chatHeader"
        ? root.bottom + 12
        : root.top - shelfSize.height - 12;
  const shelfStyle = {
    left: Math.max(12, Math.min(shelfLeft, viewportWidth - shelfSize.width - 12)),
    top: Math.max(72, Math.min(shelfTop, viewportHeight - shelfSize.height - 12)),
  };
  const [entered, setEntered] = useState(false);
  useLayoutEffect(() => {
    const frame = window.requestAnimationFrame(() => setEntered(true));
    return () => window.cancelAnimationFrame(frame);
  }, []);

  return (
    <div
      ref={layerRef}
      onFocusCapture={(event) => {
        lastFocusRef.current = event.target;
      }}
      data-customize-edit={surface}
      data-dragging={drag ? "" : undefined}
      className={cn(
        "pointer-events-none fixed inset-0 transition-opacity duration-150 motion-reduce:transition-none",
        entered ? "opacity-100" : "opacity-0",
      )}
    >
      <p id={instructionId} className="sr-only">
        Arrow keys move sortable items. Delete hides optional items. Escape cancels a drag or
        returns to Customize. Tab moves between editing controls. Enter or Space moves focus to the
        item's controls in the list.
      </p>
      <div aria-live="polite" aria-atomic="true" className="sr-only">
        <span key={announcement.sequence}>{announcement.text}</span>
      </div>
      {dimPanels(root).map((panel) => (
        <div
          key={panel.key}
          aria-hidden
          className="pointer-events-auto fixed z-0 bg-background/60"
          style={panel.style}
        />
      ))}
      {root ? (
        <div
          aria-hidden
          className="pointer-events-none fixed z-10 rounded-xl border border-primary/70 ring-4 ring-primary/15"
          style={{
            left: root.left,
            top: root.top,
            width: root.right - root.left,
            height: root.bottom - root.top,
          }}
        />
      ) : null}

      <div role="group" aria-label={`${config.title} elements`} className="contents">
        {/* Keep nodes in definition order so a remeasurement cannot move a
            focused node. Tab follows the measured reading order.
            Smaller handles stack above any controls containing them. */}
        {measurement.elements
          .filter((element) => handleKeys.has(`${element.surface}:${element.id}`))
          .map((element) => {
            const key = `${element.surface}:${element.id}`;
            const { rect, definition } = element;
            const order = resolveSurfaceLayout(element.surface, layout);
            const enabled = order.order.filter((id) => !order.hidden.has(id));
            const position = enabled.indexOf(element.id) + 1;
            const descriptionId = `${instructionId}-${key}`;
            const dragging =
              drag?.element.id === element.id && drag.element.surface === element.surface;
            return (
              <div
                key={key}
                data-customize-order={handleKeys.get(key)}
                className="group/handle pointer-events-none fixed [-webkit-app-region:no-drag]"
                style={{
                  zIndex: stackOrder.get(key),
                  left: rect.left - 3,
                  top: rect.top - 3,
                  width: rect.right - rect.left + 6,
                  height: rect.bottom - rect.top + 6,
                }}
              >
                <button
                  type="button"
                  data-customize-handle={key}
                  tabIndex={0}
                  aria-label={definition.label}
                  aria-roledescription={movable(element) ? "movable item" : "interface item"}
                  aria-describedby={`${instructionId} ${descriptionId}`}
                  onPointerDown={onPointerDown(element)}
                  onPointerMove={onPointerMove}
                  onPointerUp={onPointerUp}
                  onPointerCancel={cancelDrag}
                  onKeyDown={onKeyDown(element)}
                  onClick={(event) => {
                    // Keyboard and assistive activation focus the matching list controls.
                    if (event.detail !== 0) return;
                    const row = [
                      ...(shelfRef.current?.querySelectorAll<HTMLElement>("[data-customize-row]") ??
                        []),
                    ].find((row) => row.dataset.customizeRow === key);
                    if (row) resolveCustomizeRowTarget(row).focus();
                  }}
                  className={cn(
                    "pointer-events-auto touch-none absolute inset-0 rounded-lg border outline-none transition-[background-color,border-color] duration-100 motion-reduce:transition-none",
                    "focus-visible:border-primary focus-visible:ring-3 focus-visible:ring-primary/30",
                    movable(element) ? "cursor-grab active:cursor-grabbing" : "cursor-default",
                    dragging
                      ? "border-dashed border-foreground/35 bg-background/70"
                      : "border-primary/45 bg-primary/6 hover:border-primary hover:bg-primary/12",
                  )}
                />
                <span id={descriptionId} className="sr-only">
                  Position {position} of {enabled.length}.
                  {definition.required ? " Always shown." : ""}
                </span>
                {definition.required ? (
                  <span
                    aria-hidden
                    className="pointer-events-none absolute -top-2 -left-2 flex size-4 items-center justify-center rounded-full bg-secondary opacity-0 transition-opacity group-focus-within/handle:opacity-100 group-hover/handle:opacity-100 pointer-coarse:opacity-100 text-muted-foreground ring-2 ring-background [&_svg]:size-2.5"
                  >
                    <LockIcon />
                  </span>
                ) : (
                  <button
                    type="button"
                    data-customize-hide={key}
                    aria-label={`Hide ${definition.label}`}
                    tabIndex={-1}
                    onClick={() => setHidden(element.surface, element.id, true, true)}
                    className="pointer-events-none invisible absolute -top-2 -left-2 flex size-6 cursor-pointer items-center justify-center rounded-full bg-foreground text-background opacity-0 group-focus-within/handle:visible group-focus-within/handle:pointer-events-auto group-focus-within/handle:opacity-100 group-hover/handle:visible group-hover/handle:pointer-events-auto group-hover/handle:opacity-100 pointer-coarse:visible pointer-coarse:pointer-events-auto pointer-coarse:opacity-100 ring-2 ring-background outline-none transition-transform hover:scale-110 motion-reduce:transition-none [&_svg]:size-3"
                  >
                    <MinusIcon strokeWidth={3} />
                  </button>
                )}
              </div>
            );
          })}
      </div>

      {drag?.moved ? (
        <div
          aria-hidden
          className="pointer-events-none fixed top-0 left-0 z-40 flex h-7 items-center rounded-lg border border-primary/60 bg-popover px-2.5 text-xs font-medium shadow-lg/20"
          style={{
            transform: `translate(${drag.x}px, ${drag.y}px) translate(-50%, -50%) rotate(-2deg)`,
          }}
        >
          {drag.element.definition.label}
        </div>
      ) : null}
      {dropTarget && drag ? (
        <div
          aria-hidden
          className="pointer-events-none fixed z-30 w-0.5 rounded-full bg-primary ring-2 ring-primary/30 forced-colors:bg-[Highlight] forced-colors:outline"
          style={{
            left: dropTarget.caretX - 1,
            top: drag.element.rect.top - 3,
            height: drag.element.rect.bottom - drag.element.rect.top + 6,
          }}
        />
      ) : null}

      <div
        ref={shelfRef}
        className="dialog-glass pointer-events-auto fixed z-30 max-h-[calc(100dvh-5.25rem)] w-68 max-w-[calc(100vw-1.5rem)] overflow-y-auto rounded-xl border p-3 text-popover-foreground shadow-lg/10 [-webkit-app-region:no-drag]"
        style={shelfStyle}
      >
        <div className="flex items-center gap-2">
          <p className="flex-1 text-2xs font-semibold tracking-wide text-muted-foreground uppercase">
            {config.title} ·{" "}
            {config.layoutSurfaces.reduce(
              (count, layoutSurface) =>
                count +
                resolveSurfaceLayout(layoutSurface, layout).order.filter(
                  (id) => !resolveSurfaceLayout(layoutSurface, layout).hidden.has(id),
                ).length,
              0,
            )}{" "}
            enabled
          </p>
          <Button
            size="xs"
            variant="ghost"
            disabled={isDefault}
            onClick={() => {
              commitLayout((current) =>
                config.layoutSurfaces.reduce(
                  (next, layoutSurface) => resetSurfaceLayout(next, layoutSurface),
                  current,
                ),
              );
              announce(`Restored default ${config.title.toLowerCase()} layout`);
            }}
          >
            Reset
          </Button>
        </div>
        <FallbackList
          surface={surface}
          layoutSurfaces={config.layoutSurfaces}
          measuredKeys={handleKeys}
          legacySidebar={legacySidebar}
          onMove={moveStep}
          onHiddenChange={setHidden}
        />
        {surface === "composer" ? <ComposerExtras onChange={commit} /> : null}
      </div>

      <div
        role="toolbar"
        aria-label={`Editing ${config.title}`}
        className="dialog-glass pointer-events-auto fixed top-3 left-1/2 z-40 flex h-11 w-max max-w-[calc(100vw-1.5rem)] -translate-x-1/2 items-center gap-1 overflow-x-auto whitespace-nowrap [&>*]:shrink-0 rounded-2xl border py-1.5 ps-4 pe-1.5 [-webkit-app-region:no-drag] text-popover-foreground shadow-lg/10"
      >
        <span className="text-sm font-medium">{config.title}</span>
        {config.note ? (
          <span className="ms-1 hidden text-xs text-muted-foreground sm:inline">
            · {config.note}
          </span>
        ) : null}
        {surface === "composer" ? (
          <ToggleGroup
            aria-label="Composer preview"
            size="sm"
            className="ms-2"
            value={[composerPreview]}
            onValueChange={(next) => {
              const selected = COMPOSER_PREVIEW_OPTIONS.find((option) => option.value === next[0]);
              if (selected) setComposerPreview(selected.value);
            }}
          >
            {COMPOSER_PREVIEW_OPTIONS.map((option) => (
              <Toggle key={option.value} value={option.value}>
                {option.label}
              </Toggle>
            ))}
          </ToggleGroup>
        ) : null}
        <span aria-hidden className="mx-1.5 h-5 w-px bg-border" />
        <Button size="sm" variant="ghost" disabled={historyLength === 0} onClick={undo}>
          <Undo2Icon />
          Undo
        </Button>
        <Button size="sm" variant="ghost" data-customize-back onClick={onBack}>
          <ArrowLeftIcon />
          Back
        </Button>
        <Button size="sm" onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  );
}

function ComposerExtras({
  onChange,
}: {
  onChange: (patch: {
    contextWindowMeterEnabled?: boolean;
    composerCollapseOnScroll?: boolean;
  }) => void;
}) {
  const meter = useClientSettings((settings) => settings.contextWindowMeterEnabled);
  const collapse = useClientSettings((settings) => settings.composerCollapseOnScroll);
  return (
    <div className="mt-3 space-y-2 border-t border-border/70 pt-3">
      <label className="flex items-center gap-2 text-sm">
        <span className="flex-1">Context window meter</span>
        <Switch
          size="sm"
          checked={meter}
          onCheckedChange={(checked) => onChange({ contextWindowMeterEnabled: Boolean(checked) })}
        />
      </label>
      <label className="flex items-center gap-2 text-sm">
        <span className="flex-1">Collapse while reading</span>
        <Switch
          size="sm"
          checked={collapse}
          onCheckedChange={(checked) => onChange({ composerCollapseOnScroll: Boolean(checked) })}
        />
      </label>
    </div>
  );
}

const FALLBACK_REASONS: Record<EditSurface, string> = {
  threadRow: "No thread row is fully in view.",
  chatHeader: "No header actions are visible here.",
  composer: "No composer controls are visible here.",
};

/**
 * All items stay editable even when the sample row or responsive layout
 * cannot show them. Switches remain mounted while hiding and restoring.
 */
function FallbackList({
  surface,
  layoutSurfaces,
  measuredKeys,
  legacySidebar,
  onMove,
  onHiddenChange,
}: {
  surface: EditSurface;
  layoutSurfaces: ReadonlyArray<InterfaceSurfaceId>;
  measuredKeys: ReadonlyMap<string, number>;
  legacySidebar: boolean;
  onMove: (
    surface: InterfaceSurfaceId,
    id: InterfaceElementId<InterfaceSurfaceId>,
    direction: "left" | "right",
  ) => void;
  onHiddenChange: (
    surface: InterfaceSurfaceId,
    id: InterfaceElementId<InterfaceSurfaceId>,
    hidden: boolean,
  ) => void;
}) {
  const layout = useClientSetting("interfaceLayout");
  const descriptionId = useId();
  return (
    <div className="mt-1.5">
      <p id={descriptionId} className="text-xs text-muted-foreground">
        {measuredKeys.size === 0 ? `${FALLBACK_REASONS[surface]} ` : ""}
        Arrange all items here. List positions include hidden items and items outside this view.
      </p>
      <ul className="mt-2 space-y-0.5">
        {layoutSurfaces.flatMap((layoutSurface) => {
          const resolved = resolveSurfaceLayout(layoutSurface, layout);
          const canMove = (id: string) =>
            isMovable(
              layoutSurface,
              id,
              definitionOf(layoutSurface, id)?.sortable === true,
              legacySidebar,
            );
          const sortable = resolveCustomizeMoveOrder(layout, layoutSurface, null, legacySidebar);
          return resolved.order.map((id) => {
            const definition = definitionOf(layoutSurface, id);
            if (!definition) return null;
            const index = sortable.indexOf(id);
            return (
              <li
                key={`${layoutSurface}:${id}`}
                data-customize-row={`${layoutSurface}:${id}`}
                tabIndex={-1}
                className="flex min-h-8 items-center gap-1 rounded-sm text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="min-w-0 flex-1">
                  {definition.label}
                  {!resolved.hidden.has(id) && !measuredKeys.has(`${layoutSurface}:${id}`) ? (
                    <span className="block text-2xs text-muted-foreground">
                      {surface === "threadRow" ? "Not in this row" : "Not in this view"}
                      {canMove(id) || !definition.required ? " · edit here" : ""}
                    </span>
                  ) : null}
                </span>
                {canMove(id) ? (
                  <>
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label={`Move ${definition.label} earlier`}
                      aria-describedby={descriptionId}
                      disabled={index === 0}
                      onClick={() => onMove(layoutSurface, id, "left")}
                    >
                      <ChevronLeftIcon />
                    </Button>
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label={`Move ${definition.label} later`}
                      aria-describedby={descriptionId}
                      disabled={index === sortable.length - 1}
                      onClick={() => onMove(layoutSurface, id, "right")}
                    >
                      <ChevronRightIcon />
                    </Button>
                  </>
                ) : null}
                {definition.required ? (
                  <LockIcon
                    aria-label="Always shown"
                    className="mx-1.5 size-3.5 text-muted-foreground"
                  />
                ) : (
                  <Switch
                    size="sm"
                    aria-label={`Show ${definition.label}`}
                    checked={!resolved.hidden.has(id)}
                    onCheckedChange={(checked) => onHiddenChange(layoutSurface, id, !checked)}
                  />
                )}
              </li>
            );
          });
        })}
      </ul>
    </div>
  );
}
