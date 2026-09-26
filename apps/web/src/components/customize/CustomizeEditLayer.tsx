import {
  ArrowLeftIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  LockIcon,
  MinusIcon,
  PlusIcon,
  Undo2Icon,
} from "lucide-react";
import { type KeyboardEvent, type PointerEvent, useEffect, useRef, useState } from "react";

import { getClientSettings, useClientSetting, useClientSettings } from "../../hooks/useSettings";
import type { InterfaceLayout } from "@t3tools/contracts";

import {
  INTERFACE_SURFACES,
  type InterfaceElementDefinition,
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
  resolveDropTarget,
  resolveKeyboardMove,
  unionRect,
} from "./customizeEdit.logic";
import {
  type ComposerPreview,
  type EditSurface,
  useCustomizeInterfaceStore,
} from "./customizeInterfaceStore";
import {
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
          .map(readElementRect)
          .find((candidate) => candidate !== null) ?? null;
      return rect ? [{ id: definition.id, rect, surface, definition }] : [];
    }),
  );
}

/**
 * Thread rows are edited on one sample row: the visible row showing the most
 * details, so there is something to arrange.
 */
function measureThreadRow(): Measurement {
  let best: Measurement = { root: null, elements: [] };
  for (const row of document.querySelectorAll("[data-thread-item]")) {
    // Only a row the list shows in full, not one scrolled under its edges.
    const rect = readElementRect(row);
    const visible = readVisibleRect(row);
    if (!rect || !visible || visible.bottom - visible.top < rect.bottom - rect.top - 1) continue;
    const elements = measureIn(row, ["threadRow"]);
    if (elements.length > best.elements.length) best = { root: rect, elements };
  }
  return best;
}

function measureSurface(surface: EditSurface): Measurement {
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
  { value: "live", label: "Live" },
  { value: "expanded", label: "Expanded" },
  { value: "collapsed", label: "Collapsed" },
];

/**
 * Editing one surface in place: its elements get a hide badge and can be
 * dragged, or moved with the arrow keys, to a new position. Hidden elements
 * wait in a shelf beside the surface. Everything else is dimmed; clicking it
 * goes back to the presets.
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
  const historyLength = useCustomizeInterfaceStore((store) => store.history.length);
  const composerPreview = useCustomizeInterfaceStore((store) => store.composerPreview);
  const setComposerPreview = useCustomizeInterfaceStore((store) => store.setComposerPreview);
  const { commit, commitLayout, undo } = useCustomizeActions();
  const [drag, setDrag] = useState<DragState | null>(null);

  // Keyboard users land on the first element, or on Layouts when the surface
  // has nothing on screen to edit.
  const hasElements = measurement.elements.length > 0;
  const focusedRef = useRef(false);
  useEffect(() => {
    if (focusedRef.current) return;
    const target = document
      .querySelector(`[data-customize-edit="${surface}"]`)
      ?.querySelector<HTMLElement>(
        hasElements ? "[data-customize-handle]" : "[data-customize-back]",
      );
    if (!target) return;
    focusedRef.current = true;
    target.focus({ preventScroll: true });
  }, [hasElements, surface]);

  const sortableIn = (layoutSurface: InterfaceSurfaceId) =>
    measurement.elements.filter(
      (element) => element.surface === layoutSurface && element.definition.sortable,
    );
  const dropTarget: DropTarget | null =
    drag?.moved && drag.element.definition.sortable
      ? resolveDropTarget(sortableIn(drag.element.surface), drag.element.id, drag.x)
      : null;

  const stackOrder = new Map(
    measurement.elements
      .toSorted((a, b) => area(b.rect) - area(a.rect))
      .map((element, index) => [`${element.surface}:${element.id}`, 105 + index]),
  );

  const hide = (element: MeasuredElement) =>
    commitLayout((current) => setSurfaceElementHidden(current, element.surface, element.id, true));
  const moveBefore = (element: MeasuredElement, beforeId: string | null) =>
    commitLayout((current) =>
      moveSurfaceElementBefore(current, element.surface, element.id, beforeId),
    );

  const onPointerDown = (element: MeasuredElement) => (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || !element.definition.sortable) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({ element, startX: event.clientX, x: event.clientX, y: event.clientY, moved: false });
  };
  const onPointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    if (!drag) return;
    setDrag({
      ...drag,
      x: event.clientX,
      y: event.clientY,
      moved: drag.moved || Math.abs(event.clientX - drag.startX) > 4,
    });
  };
  const onPointerUp = () => {
    if (drag && dropTarget) moveBefore(drag.element, dropTarget.beforeId);
    setDrag(null);
  };
  const onKeyDown = (element: MeasuredElement) => (event: KeyboardEvent<HTMLButtonElement>) => {
    if ((event.key === "Delete" || event.key === "Backspace") && !element.definition.required) {
      event.preventDefault();
      hide(element);
      return;
    }
    if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && element.definition.sortable) {
      event.preventDefault();
      // The saved order, not the last measurement, so a second press before
      // the page re-lays out still steps from the element's new position.
      const shownIds = new Set(sortableIn(element.surface).map((candidate) => candidate.id));
      const order = resolveSurfaceLayout(
        element.surface,
        getClientSettings().interfaceLayout,
      ).order.filter((id) => shownIds.has(id));
      const move = resolveKeyboardMove(
        order,
        element.id,
        event.key === "ArrowLeft" ? "left" : "right",
      );
      if (move) moveBefore(element, move.beforeId);
    }
  };

  const hiddenElements = config.layoutSurfaces.flatMap((layoutSurface) =>
    [...resolveSurfaceLayout(layoutSurface, layout).hidden].map((id) => ({
      surface: layoutSurface,
      id,
      label: definitionOf(layoutSurface, id)?.label ?? id,
    })),
  );
  // Details the sample row doesn't have, such as a pull request, still apply
  // to rows that do.
  const absentLabels =
    surface === "threadRow"
      ? INTERFACE_SURFACES.threadRow
          .filter(
            (definition) =>
              !resolveSurfaceLayout("threadRow", layout).hidden.has(definition.id) &&
              !measurement.elements.some((element) => element.id === definition.id),
          )
          .map((definition) => definition.label)
      : [];
  const isDefault = config.layoutSurfaces.every((layoutSurface) =>
    isDefaultSurfaceLayout(layoutSurface, layout),
  );

  const root = measurement.root ? pad(measurement.root, 6) : null;
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const shelfStyle = !root
    ? { left: "50%", top: 72, transform: "translateX(-50%)" }
    : surface === "threadRow"
      ? { left: root.right + 14, top: root.top }
      : surface === "chatHeader"
        ? { right: Math.max(12, viewportWidth - root.right), top: root.bottom + 12 }
        : {
            right: Math.max(12, viewportWidth - root.right),
            bottom: viewportHeight - root.top + 12,
          };

  return (
    <div data-customize-edit={surface} className="contents">
      {dimPanels(root).map((panel) => (
        <div
          key={panel.key}
          aria-hidden
          onClick={onBack}
          className="pointer-events-auto fixed z-[103] bg-black/55"
          style={panel.style}
        />
      ))}
      {root ? (
        <div
          aria-hidden
          className="pointer-events-none fixed z-[104] rounded-xl border border-primary/70 ring-4 ring-primary/15"
          style={{
            left: root.left,
            top: root.top,
            width: root.right - root.left,
            height: root.bottom - root.top,
          }}
        />
      ) : null}

      <div role="group" aria-label={`${config.title} elements`} className="contents">
        {/* Handles follow the page's reading order, so Tab moves left to right.
            Smaller ones stack higher, keeping an element nested in another,
            such as a toolbar block inside the collapsed composer's controls,
            reachable. */}
        {measurement.elements
          .toSorted((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left)
          .map((element) => {
            const key = `${element.surface}:${element.id}`;
            const { rect, definition } = element;
            const dragging =
              drag?.element.id === element.id && drag.element.surface === element.surface;
            return (
              <div
                key={key}
                className="group/handle pointer-events-none fixed "
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
                  data-customize-handle
                  aria-label={
                    definition.sortable
                      ? `${definition.label}. Arrow keys move it${definition.required ? "" : ", Delete hides it"}.`
                      : `${definition.label}${definition.required ? ", always shown" : ". Delete hides it."}`
                  }
                  onPointerDown={onPointerDown(element)}
                  onPointerMove={onPointerMove}
                  onPointerUp={onPointerUp}
                  onPointerCancel={() => setDrag(null)}
                  onKeyDown={onKeyDown(element)}
                  className={cn(
                    "pointer-events-auto absolute inset-0 rounded-lg border outline-none transition-[background-color,border-color] duration-100 motion-reduce:transition-none",
                    "focus-visible:border-primary focus-visible:ring-3 focus-visible:ring-primary/30",
                    definition.sortable ? "cursor-grab active:cursor-grabbing" : "cursor-default",
                    dragging
                      ? "border-dashed border-foreground/35 bg-background/70"
                      : "border-primary/45 bg-primary/6 hover:border-primary hover:bg-primary/12",
                  )}
                />
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
                    aria-label={`Hide ${definition.label}`}
                    tabIndex={-1}
                    onClick={() => hide(element)}
                    className="pointer-events-auto absolute -top-2 -left-2 flex size-4.5 cursor-pointer items-center justify-center rounded-full bg-foreground text-background opacity-0 group-focus-within/handle:opacity-100 group-hover/handle:opacity-100 pointer-coarse:opacity-100 ring-2 ring-background outline-none transition-transform hover:scale-110 motion-reduce:transition-none [&_svg]:size-3"
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
          className="pointer-events-none fixed z-[133] flex h-7 -translate-x-1/2 -translate-y-1/2 -rotate-2 items-center rounded-lg border border-primary/60 bg-popover px-2.5 text-xs font-medium shadow-lg/20"
          style={{ left: drag.x, top: drag.y }}
        >
          {drag.element.definition.label}
        </div>
      ) : null}
      {dropTarget && drag ? (
        <div
          aria-hidden
          className="pointer-events-none fixed z-[131] w-0.5 rounded-full bg-primary ring-2 ring-primary/30"
          style={{
            left: dropTarget.caretX - 1,
            top: drag.element.rect.top - 3,
            height: drag.element.rect.bottom - drag.element.rect.top + 6,
          }}
        />
      ) : null}

      <div
        className="dialog-glass pointer-events-auto fixed z-[131] w-68 rounded-xl border p-3 text-popover-foreground shadow-lg/10"
        style={shelfStyle}
      >
        <div className="flex items-center gap-2">
          <p className="flex-1 text-2xs font-semibold tracking-wide text-muted-foreground uppercase">
            {measurement.elements.length === 0 ? config.title : "Hidden"}
          </p>
          <Button
            size="xs"
            variant="ghost"
            disabled={isDefault}
            onClick={() =>
              commitLayout((current) =>
                config.layoutSurfaces.reduce(
                  (next, layoutSurface) => resetSurfaceLayout(next, layoutSurface),
                  current,
                ),
              )
            }
          >
            Reset
          </Button>
        </div>
        {measurement.elements.length === 0 ? (
          <FallbackList
            surface={surface}
            layoutSurfaces={config.layoutSurfaces}
            onEdit={commitLayout}
          />
        ) : hiddenElements.length === 0 ? (
          <p className="mt-1.5 text-xs text-muted-foreground">
            Nothing hidden. Use <MinusIcon aria-label="minus" className="inline size-3" /> to hide
            an item.
          </p>
        ) : (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {hiddenElements.map((hidden) => (
              <button
                key={`${hidden.surface}:${hidden.id}`}
                type="button"
                aria-label={`Show ${hidden.label}`}
                onClick={() =>
                  commitLayout((current) =>
                    setSurfaceElementHidden(current, hidden.surface, hidden.id, false),
                  )
                }
                className="flex h-7 cursor-pointer items-center gap-1.5 rounded-lg border border-dashed border-foreground/25 ps-1.5 pe-2.5 text-xs outline-none hover:border-primary hover:bg-primary/8 focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="flex size-4 items-center justify-center rounded-full bg-primary text-primary-foreground [&_svg]:size-3">
                  <PlusIcon strokeWidth={3} />
                </span>
                {hidden.label}
              </button>
            ))}
          </div>
        )}
        {absentLabels.length > 0 ? (
          <p className="mt-2 text-xs text-muted-foreground">
            Not in this row: {absentLabels.join(", ")}.
          </p>
        ) : null}
        {surface === "composer" ? <ComposerExtras onChange={commit} /> : null}
      </div>

      <div
        role="toolbar"
        aria-label={`Editing ${config.title}`}
        className="dialog-glass pointer-events-auto fixed top-3 left-1/2 z-[132] flex h-11 -translate-x-1/2 items-center gap-1 rounded-full border ps-4 pe-1.5 text-popover-foreground shadow-lg/10"
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
          Layouts
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
  chatHeader: "Header actions are folded into a menu at this width.",
  composer: "The composer isn't on this page.",
};

/**
 * The surface as a list, for when nothing of it is on screen to edit in
 * place: a narrow header folds its actions into a menu, and a page may have
 * no composer.
 */
function FallbackList({
  surface,
  layoutSurfaces,
  onEdit,
}: {
  surface: EditSurface;
  layoutSurfaces: ReadonlyArray<InterfaceSurfaceId>;
  onEdit: (edit: (current: InterfaceLayout) => InterfaceLayout) => void;
}) {
  const layout = useClientSetting("interfaceLayout");
  return (
    <div className="mt-1.5">
      <p className="text-xs text-muted-foreground">{FALLBACK_REASONS[surface]} Arrange it here.</p>
      <ul className="mt-2 space-y-0.5">
        {layoutSurfaces.flatMap((layoutSurface) => {
          const resolved = resolveSurfaceLayout(layoutSurface, layout);
          const sortable = resolved.order.filter((id) => definitionOf(layoutSurface, id)?.sortable);
          return resolved.order.map((id) => {
            const definition = definitionOf(layoutSurface, id);
            if (!definition) return null;
            const index = sortable.indexOf(id);
            return (
              <li key={`${layoutSurface}:${id}`} className="flex h-8 items-center gap-1 text-sm">
                <span className="min-w-0 flex-1 truncate">{definition.label}</span>
                {definition.sortable ? (
                  <>
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label={`Move ${definition.label} earlier`}
                      disabled={index === 0}
                      onClick={() =>
                        onEdit((current) =>
                          moveSurfaceElementBefore(
                            current,
                            layoutSurface,
                            id,
                            sortable[index - 1] ?? null,
                          ),
                        )
                      }
                    >
                      <ChevronLeftIcon />
                    </Button>
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label={`Move ${definition.label} later`}
                      disabled={index === sortable.length - 1}
                      onClick={() =>
                        onEdit((current) =>
                          moveSurfaceElementBefore(
                            current,
                            layoutSurface,
                            id,
                            sortable[index + 2] ?? null,
                          ),
                        )
                      }
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
                    onCheckedChange={(checked) =>
                      onEdit((current) =>
                        setSurfaceElementHidden(current, layoutSurface, id, !checked),
                      )
                    }
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
