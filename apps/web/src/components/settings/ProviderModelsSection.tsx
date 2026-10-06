"use client";

import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { restrictToFirstScrollableAncestor, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
  type SortingStrategy,
} from "@dnd-kit/sortable";
import { CSS as DndCSS } from "@dnd-kit/utilities";
import { GripVerticalIcon, PencilIcon, PlusIcon, StarIcon, XIcon } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ProviderDriverKind,
  type ProviderInstanceId,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { type CustomModelDefinition, normalizeCustomModelSlug } from "@t3tools/shared/model";

import { animateLayoutChangesWhileSorting, createListMotion } from "../../lib/listMotion";
import { cn } from "../../lib/utils";
import { sortModelsForProviderInstance } from "../../modelOrdering";
import { MAX_CUSTOM_MODEL_LENGTH } from "../../modelSelection";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { CustomModelEditor } from "./CustomModelEditor";

/**
 * Placeholder text for the "add a custom model" input, keyed by driver
 * kind. Mirrors the prior hardcoded switch in `SettingsPanels.tsx` so the
 * UX is unchanged — only the owning component has moved.
 */
const CUSTOM_MODEL_PLACEHOLDER_BY_KIND: Partial<Record<ProviderDriverKind, string>> = {
  [ProviderDriverKind.make("codex")]: "gpt-6.7-codex-ultra-preview",
  [ProviderDriverKind.make("claudeAgent")]: "claude-sonnet-5",
  [ProviderDriverKind.make("cursor")]: "claude-sonnet-4-6",
  [ProviderDriverKind.make("opencode")]: "openai/gpt-5",
  [ProviderDriverKind.make("pi")]: "anthropic/claude-sonnet-5",
};

/** Above this many models the list gets a filter input. */
const FILTER_THRESHOLD = 8;

/**
 * Short capability words shown after a model's slug. Claude and Cursor report
 * fast mode as a boolean `fastMode` option; Codex reports it as a
 * `serviceTier` select whose fast tier is labelled "Fast" (catalog id
 * `priority`, or `fast` from the speed-tier fallback), matching the composer.
 */
function describeModelCapabilities(model: ServerProviderModel): string[] {
  const descriptors = model.capabilities?.optionDescriptors ?? [];
  const labels: string[] = [];
  const hasFastMode = descriptors.some(
    (descriptor) =>
      descriptor.id === "fastMode" ||
      (descriptor.id === "serviceTier" &&
        descriptor.type === "select" &&
        descriptor.options.some((option) => option.id === "fast" || option.label === "Fast")),
  );
  if (hasFastMode) labels.push("Fast mode");
  if (descriptors.some((descriptor) => descriptor.id === "thinking")) labels.push("Thinking");
  if (
    descriptors.some(
      (descriptor) =>
        descriptor.type === "select" &&
        (descriptor.id === "reasoningEffort" ||
          descriptor.id === "effort" ||
          descriptor.id === "reasoning" ||
          descriptor.id === "variant"),
    )
  ) {
    labels.push("Reasoning");
  }
  return labels;
}

/**
 * Display order for the models list: favorites first (in user order), then
 * visible models, then hidden ones. Hidden models sink so the list reads
 * top-down as "what the picker shows", and the display order is what gets
 * persisted as `modelOrder`.
 */
export function groupModelsForDisplay<
  T extends { readonly slug: string; readonly isCustom: boolean },
>(
  models: ReadonlyArray<T>,
  options: {
    readonly favoriteModels: ReadonlySet<string>;
    readonly hiddenModels: ReadonlySet<string>;
    readonly modelOrder: ReadonlyArray<string>;
  },
): T[] {
  const ordered = sortModelsForProviderInstance(models, {
    favoriteModels: options.favoriteModels,
    groupFavorites: true,
    modelOrder: options.modelOrder,
  });
  const isHidden = (model: T) => !model.isCustom && options.hiddenModels.has(model.slug);
  return [
    ...ordered.filter((model) => options.favoriteModels.has(model.slug)),
    ...ordered.filter((model) => !options.favoriteModels.has(model.slug) && !isHidden(model)),
    ...ordered.filter((model) => !options.favoriteModels.has(model.slug) && isHidden(model)),
  ];
}

export function nextHiddenModelsForBulkToggle(
  models: ReadonlyArray<Pick<ServerProviderModel, "slug" | "isCustom">>,
  hiddenModels: ReadonlyArray<string>,
): string[] {
  const builtInSlugs = models.filter((model) => !model.isCustom).map((model) => model.slug);
  const builtInSlugSet = new Set(builtInSlugs);
  const allBuiltInModelsHidden = builtInSlugs.every((slug) => hiddenModels.includes(slug));

  if (allBuiltInModelsHidden) {
    return hiddenModels.filter((slug) => !builtInSlugSet.has(slug));
  }

  return [...new Set([...hiddenModels, ...builtInSlugs])];
}

/**
 * The models list is one flat sortable flow: favorites, an "All" label, the
 * remaining enabled models, a "Hidden from picker" label, and the hidden
 * models. Both labels take part in the flow so the gap can open on either
 * side of them, and a drop is a plain array move whose landing segment
 * decides the row's favorite and hidden state.
 */
export const ALL_LABEL_ID = "label:all";
export const HIDDEN_LABEL_ID = "label:hidden";
/** Drop slots shown in place of an empty segment; they take part in the flow like the labels. */
export const FAVORITES_SLOT_ID = "label:favorites-slot";
const ENABLED_SLOT_ID = "label:enabled-slot";
export const HIDDEN_SLOT_ID = "label:hidden-slot";
const MARKER_IDS = new Set([
  ALL_LABEL_ID,
  HIDDEN_LABEL_ID,
  FAVORITES_SLOT_ID,
  ENABLED_SLOT_ID,
  HIDDEN_SLOT_ID,
]);
const isMarkerId = (id: string) => MARKER_IDS.has(id);

export type ModelListSegment = "favorites" | "enabled" | "hidden";

/** The flat list after moving `activeId` onto `overId`; the same array when that is a no-op. */
function moveModelListItem(
  items: ReadonlyArray<string>,
  activeId: string,
  overId: string,
): ReadonlyArray<string> {
  const from = items.indexOf(activeId);
  const to = items.indexOf(overId);
  if (from < 0 || to < 0 || from === to) return items;
  return arrayMove([...items], from, to);
}

function modelListSegment(items: ReadonlyArray<string>, id: string): ModelListSegment {
  const index = items.indexOf(id);
  if (index > items.indexOf(HIDDEN_LABEL_ID)) return "hidden";
  return index < items.indexOf(ALL_LABEL_ID) ? "favorites" : "enabled";
}

export interface ModelListDrop {
  /** Sortable ids in display order, labels included. */
  readonly items: ReadonlyArray<string>;
  readonly activeId: string;
  readonly overId: string;
  readonly favoriteModels: ReadonlyArray<string>;
  readonly hiddenModels: ReadonlyArray<string>;
  readonly customSlugs: ReadonlySet<string>;
}

/**
 * Preferences after dropping `activeId` onto `overId`, or `null` when the
 * drop changes nothing or would hide a custom model. Preference entries for
 * slugs that are not in the list are preserved, as is the hidden flag of a
 * favorite (favorites sit in the favorites segment even when hidden).
 */
export function resolveModelListDrop(input: ModelListDrop): {
  readonly modelOrder: string[];
  readonly favoriteModels: string[];
  readonly hiddenModels: string[];
} | null {
  const moved = moveModelListItem(input.items, input.activeId, input.overId);
  if (moved === input.items) return null;
  const modelOrder = moved.filter((id) => !isMarkerId(id));
  const inSegment = (segment: ModelListSegment) =>
    modelOrder.filter((slug) => modelListSegment(moved, slug) === segment);
  const hidden = inSegment("hidden");
  if (hidden.some((slug) => input.customSlugs.has(slug))) return null;

  const listed = new Set(modelOrder);
  const enabled = new Set(inSegment("enabled"));
  return {
    modelOrder,
    favoriteModels: [
      ...input.favoriteModels.filter((slug) => !listed.has(slug)),
      ...inSegment("favorites"),
    ],
    hiddenModels: [
      ...new Set([...input.hiddenModels.filter((slug) => !enabled.has(slug)), ...hidden]),
    ],
  };
}

interface ProviderModelsSectionProps {
  /** Identifier used to namespace input ids within the DOM. */
  readonly instanceId: ProviderInstanceId;
  /**
   * Driver kind for slug normalization + input placeholder. `null` when
   * the section is rendered without enough provider metadata.
   */
  readonly driverKind: ProviderDriverKind | null;
  /**
   * The live model list to display. Includes both built-in (probe-reported)
   * and custom entries, distinguished by `isCustom`.
   */
  readonly models: ReadonlyArray<ServerProviderModel>;
  /**
   * The persisted custom-model list for this instance, resolved. Drives
   * dedup, and is the list we hand back (with an entry appended / replaced /
   * removed) via `onChange`.
   */
  readonly customModels: ReadonlyArray<CustomModelDefinition>;
  /** Server-returned model slugs hidden from the model picker. */
  readonly hiddenModels: ReadonlyArray<string>;
  /** Model slugs favorited for this provider instance. */
  readonly favoriteModels: ReadonlyArray<string>;
  /** Explicit user-authored model ordering for this provider instance. */
  readonly modelOrder: ReadonlyArray<string>;
  /**
   * Commit the new custom-model list. Caller is responsible for routing the
   * write to the correct storage (legacy `settings.providers[kind]` vs.
   * `providerInstances[id].config`).
   */
  readonly onChange: (next: ReadonlyArray<CustomModelDefinition>) => void;
  /**
   * Hidden models and order are stored together and a drop can change both,
   * so they are always committed as one write.
   */
  readonly onModelPreferencesChange: (next: {
    readonly hiddenModels: ReadonlyArray<string>;
    readonly modelOrder: ReadonlyArray<string>;
  }) => void;
  readonly onFavoriteModelsChange: (next: ReadonlyArray<string>) => void;
}

// Only the grip handle starts a drag so the star, switch, and edit controls
// on the row keep working as plain clicks.
type ModelDragHandle = Pick<
  ReturnType<typeof useSortable>,
  "attributes" | "listeners" | "setActivatorNodeRef"
>;

function SortableModelRow(props: {
  readonly slug: string;
  readonly children: (handle: ModelDragHandle, isDragging: boolean) => ReactNode;
}) {
  const {
    attributes,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: props.slug, animateLayoutChanges: animateLayoutChangesWhileSorting });
  // The real row is lifted, so list motion can glide it from under the
  // pointer into its committed slot on drop. A ring, not a border, keeps its
  // measured height.
  return (
    <div
      ref={setNodeRef}
      style={{ transform: DndCSS.Translate.toString(transform), transition }}
      className={cn(
        isDragging && "relative z-20 rounded-md bg-popover shadow-lg ring-1 ring-primary/30",
      )}
    >
      {props.children({ attributes, listeners, setActivatorNodeRef }, isDragging)}
    </div>
  );
}

// Group labels and empty-segment slots take part in the sortable flow so
// rows can shift around them; they cannot be picked up.
function SortableMarker(props: {
  readonly id: string;
  readonly className: string;
  readonly children: ReactNode;
}) {
  const { setNodeRef, transform, transition } = useSortable({
    id: props.id,
    disabled: { draggable: true },
    animateLayoutChanges: animateLayoutChangesWhileSorting,
  });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: DndCSS.Translate.toString(transform), transition }}
      className={props.className}
    >
      {props.children}
    </div>
  );
}

// Integer line height: the list box can be a fractional flex height, and a
// half-pixel of content overflow makes dnd-kit auto-scroll flash a scrollbar.
const groupLabelClassName = (isDropTarget: boolean) =>
  cn("px-2 pt-5 pb-1.5 text-2xs leading-4 text-muted-foreground", isDropTarget && "text-primary");

const favoritesPreviewClassName = (isShown: boolean) =>
  cn("pointer-events-none transition-opacity duration-250", !isShown && "opacity-0");

const favoritesLabelClassName = (isDropTarget: boolean) =>
  cn("px-2 pt-1 pb-1.5 text-2xs leading-4 text-muted-foreground", isDropTarget && "text-primary");

const emptySlotClassName = (isDropTarget: boolean) =>
  cn(
    "mx-2 flex h-7 items-center justify-center rounded-md border border-dashed border-foreground/15 text-xs text-muted-foreground",
    isDropTarget && "border-primary/40 bg-primary/5 text-primary",
  );

/**
 * Shared "Models" section rendered on both the built-in default and custom
 * provider-instance cards. Owns its own input + error local state so two
 * cards on screen don't fight over the input value.
 *
 * Validation mirrors the pre-consolidation logic in `SettingsPanels`:
 *   - empty / whitespace → "Enter a model slug."
 *   - duplicate of a non-custom (probe-reported) slug → "already built in"
 *   - exceeds `MAX_CUSTOM_MODEL_LENGTH` → length error
 *   - duplicate of an already-saved custom slug → already-saved error
 */
export function ProviderModelsSection({
  instanceId,
  driverKind,
  models,
  customModels,
  hiddenModels,
  favoriteModels,
  modelOrder,
  onChange,
  onModelPreferencesChange,
  onFavoriteModelsChange,
}: ProviderModelsSectionProps) {
  const [input, setInput] = useState("");
  const [isAdding, setIsAdding] = useState(false);
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Slug of the custom model whose inline editor is open, if any.
  const [editingSlug, setEditingSlug] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const listMotionRef = useRef<ReturnType<typeof createListMotion> | null>(null);
  const attachListRef = useCallback((node: HTMLDivElement | null) => {
    listRef.current = node;
    listMotionRef.current?.dispose();
    listMotionRef.current =
      node === null ? null : createListMotion(node, { cloneStripAttributes: ["data-model-slug"] });
    listMotionRef.current?.update(false);
  }, []);
  // Slug of a just-added custom model, scrolled into view once its row exists.
  const scrollToSlugRef = useRef<string | null>(null);
  const hiddenModelSet = useMemo(() => new Set(hiddenModels), [hiddenModels]);
  const favoriteModelSet = useMemo(() => new Set(favoriteModels), [favoriteModels]);
  const customSlugSet = useMemo(
    () => new Set(customModels.map((entry) => entry.slug)),
    [customModels],
  );
  const isHiddenModel = (model: ServerProviderModel) =>
    !model.isCustom && hiddenModelSet.has(model.slug);
  // Memoized as one unit: dnd-kit keys its layout animations on the identity
  // of the sortable ids array.
  const { displayModels, favorites, sortableIds } = useMemo(() => {
    const displayModels = groupModelsForDisplay(models, {
      favoriteModels: favoriteModelSet,
      hiddenModels: hiddenModelSet,
      modelOrder,
    });
    const isHidden = (model: ServerProviderModel) =>
      !model.isCustom && hiddenModelSet.has(model.slug);
    const favorites = displayModels.filter((model) => favoriteModelSet.has(model.slug));
    const rest = displayModels.filter((model) => !favoriteModelSet.has(model.slug));
    const enabled = rest.filter((model) => !isHidden(model));
    const hidden = rest.filter(isHidden);
    // The favorites slot and the "All" label stay in the flow even without
    // favorites, so a row can be dragged in to become the first favorite.
    const sortableIds = [
      ...(favorites.length > 0 ? favorites.map((model) => model.slug) : [FAVORITES_SLOT_ID]),
      ALL_LABEL_ID,
      ...enabled.map((model) => model.slug),
      ...(favorites.length === 0 && enabled.length === 0 ? [ENABLED_SLOT_ID] : []),
      HIDDEN_LABEL_ID,
      ...hidden.map((model) => model.slug),
      ...(hidden.length === 0 ? [HIDDEN_SLOT_ID] : []),
    ];
    return { displayModels, favorites, sortableIds };
  }, [favoriteModelSet, hiddenModelSet, modelOrder, models]);
  const hiddenCount = displayModels.filter(isHiddenModel).length;
  const builtInModels = useMemo(() => models.filter((model) => !model.isCustom), [models]);
  const allBuiltInModelsHidden =
    builtInModels.length > 0 && builtInModels.every((model) => hiddenModelSet.has(model.slug));
  const showFilter = models.length > FILTER_THRESHOLD;
  const normalizedFilter = filter.trim().toLowerCase();
  const isFiltering = showFilter && normalizedFilter.length > 0;
  const filteredModels = displayModels.filter(
    (model) =>
      model.name.toLowerCase().includes(normalizedFilter) ||
      model.slug.toLowerCase().includes(normalizedFilter),
  );

  // The segment the lifted row would land in, so the target can highlight
  // and the overlay can preview the row's resulting state.
  const [drag, setDrag] = useState<{
    readonly target: ModelListSegment;
    /** Heights of the lifted row and of the favorites preview labels. */
    readonly rowHeight: number;
    readonly favoritesLabelHeight: number;
    readonly allLabelHeight: number;
  } | null>(null);
  const dropTarget = drag?.target ?? null;
  const favoritesLabelRef = useRef<HTMLDivElement>(null);
  const allLabelRef = useRef<HTMLDivElement>(null);
  const trackDrag = (event: DragStartEvent | DragOverEvent) => {
    const activeId = String(event.active.id);
    const overId = "over" in event && event.over ? String(event.over.id) : activeId;
    setDrag({
      target: modelListSegment(moveModelListItem(sortableIds, activeId, overId), activeId),
      rowHeight: event.active.rect.current.initial?.height ?? 0,
      favoritesLabelHeight: favoritesLabelRef.current?.offsetHeight ?? 0,
      allLabelHeight: allLabelRef.current?.offsetHeight ?? 0,
    });
  };
  const dndSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  // Without favorites, the favorites slot and the "All" label are zero-height
  // markers at the top of the list, so picking a row up shifts nothing. While
  // the slot is the target, the rows slide down to make room for the
  // "Favorites" label, a row-sized slot, and the "All" label, which are drawn
  // into that space, and the lifted row's own gap closes.
  const favoritesPreview: SortingStrategy = ({ index, activeIndex, rects }) => {
    const id = sortableIds[index];
    if (!drag || id === FAVORITES_SLOT_ID || index === activeIndex) return null;
    const slotBottom = drag.favoritesLabelHeight + drag.rowHeight;
    const y =
      id === ALL_LABEL_ID
        ? slotBottom
        : slotBottom +
          drag.allLabelHeight -
          (index > activeIndex ? (rects[activeIndex]?.height ?? 0) : 0);
    return { x: 0, y, scaleX: 1, scaleY: 1 };
  };
  // An empty slot stays put while the rows around it shift, so it reads as
  // the place the row will land instead of opening a second gap.
  const dndSortingStrategy: SortingStrategy = (args) => {
    const overId = sortableIds[args.overIndex];
    if (overId === FAVORITES_SLOT_ID) return favoritesPreview(args);
    if (
      args.index === args.overIndex &&
      (overId === ENABLED_SLOT_ID || overId === HIDDEN_SLOT_ID)
    ) {
      return null;
    }
    return verticalListSortingStrategy(args);
  };
  // Custom models are always shown in the picker, so the gap never opens in
  // the hidden segment while one is dragged. When the hidden segment is empty
  // its slot is the only target there, so the label above it does not steal
  // the hover and open a gap of its own.
  //
  // The favorites slot becomes the target once the pointer is above the
  // middle of the topmost row, and stays it while the pointer is over the
  // opened label and slot. Its live position is compared with the live
  // pointer, like the sidebar's Pins boundary, since measured rects go stale
  // when the list scrolls; the slot itself never moves. Keyboard drags have
  // no pointer; they reach favorites through the star.
  const dndCollisionDetection: CollisionDetection = (args) => {
    const favoritesSlot = args.droppableContainers.find(
      (container) => container.id === FAVORITES_SLOT_ID,
    );
    const slotTop = favoritesSlot?.node.current?.getBoundingClientRect().top;
    const pointerY = args.pointerCoordinates?.y;
    if (slotTop !== undefined && pointerY !== undefined && drag) {
      const zoneHeight =
        dropTarget === "favorites"
          ? drag.favoritesLabelHeight + drag.rowHeight
          : args.collisionRect.height / 2;
      if (pointerY < slotTop + zoneHeight) return [{ id: FAVORITES_SLOT_ID }];
    }
    const excluded = new Set<string>([
      ...(sortableIds.includes(HIDDEN_SLOT_ID) ? [HIDDEN_LABEL_ID] : []),
      ...(favoritesSlot ? [FAVORITES_SLOT_ID, ALL_LABEL_ID] : []),
    ]);
    if (customSlugSet.has(String(args.active.id))) {
      for (const id of sortableIds.slice(sortableIds.indexOf(HIDDEN_LABEL_ID))) excluded.add(id);
    }
    return closestCenter({
      ...args,
      droppableContainers: args.droppableContainers.filter(
        (container) => !excluded.has(String(container.id)),
      ),
    });
  };
  const handleDragStart = (event: DragStartEvent) => {
    // Stop running list motion before dnd-kit measures the picked-up row.
    listMotionRef.current?.suspend();
    trackDrag(event);
  };
  const handleDragCancel = () => {
    listMotionRef.current?.release();
    setDrag(null);
  };
  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    // dnd-kit's transforms are still on screen here; the commit below glides
    // every row from them into its new slot.
    listMotionRef.current?.release();
    setDrag(null);
    if (!over) return;
    const result = resolveModelListDrop({
      items: sortableIds,
      activeId: String(active.id),
      overId: String(over.id),
      favoriteModels,
      hiddenModels,
      customSlugs: customSlugSet,
    });
    if (!result) return;
    onModelPreferencesChange({ hiddenModels: result.hiddenModels, modelOrder: result.modelOrder });
    onFavoriteModelsChange(result.favoriteModels);
  };

  // Keyed on what moves rows, not on the identity of the arrays, so unrelated
  // renders neither read layout nor animate. Rows glide when a toggle, a drop,
  // or an opened editor moves them; a filter swap only refreshes the baseline,
  // including the swap back to the full list.
  const listOrderKey = [
    isFiltering ? "filtered" : "sortable",
    ...(isFiltering ? filteredModels.map((model) => model.slug) : sortableIds),
    editingSlug ?? "",
  ].join("\0");
  const isDragging = drag !== null;
  const wasFilteringRef = useRef(isFiltering);
  useLayoutEffect(() => {
    void listOrderKey;
    const filterChanged = wasFilteringRef.current !== isFiltering;
    wasFilteringRef.current = isFiltering;
    listMotionRef.current?.update(!isDragging && !isFiltering && !filterChanged);
  }, [isDragging, isFiltering, listOrderKey]);

  // Escape cancels the drag; dnd-kit leaves the event unhandled, so without
  // this the settings page would also take it as "go back".
  useEffect(() => {
    if (!isDragging) return;
    const claimEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") event.preventDefault();
    };
    document.addEventListener("keydown", claimEscape, true);
    return () => document.removeEventListener("keydown", claimEscape, true);
  }, [isDragging]);

  // The parent commits the new custom model and hands back an updated
  // `models` list, so the row can only be scrolled to after that render.
  useEffect(() => {
    const slug = scrollToSlugRef.current;
    if (slug === null) return;
    const row = listRef.current?.querySelector<HTMLElement>(
      `[data-model-slug="${CSS.escape(slug)}"]`,
    );
    if (!row) return;
    scrollToSlugRef.current = null;
    row.scrollIntoView({ block: "nearest" });
  }, [displayModels]);

  const handleAdd = () => {
    if (driverKind === "antigravity") return;
    const normalized = normalizeCustomModelSlug(input);
    if (!normalized) {
      setError("Enter a model slug.");
      return;
    }
    if (models.some((model) => !model.isCustom && model.slug === normalized)) {
      setError("That model is already built in.");
      return;
    }
    if (normalized.length > MAX_CUSTOM_MODEL_LENGTH) {
      setError(`Model slugs must be ${MAX_CUSTOM_MODEL_LENGTH} characters or less.`);
      return;
    }
    if (customModels.some((entry) => entry.slug === normalized)) {
      setError("That custom model is already saved.");
      return;
    }

    // Clear the filter so the new row renders even when it does not match,
    // which is also what lets the pending scroll target resolve and clear.
    scrollToSlugRef.current = normalized;
    setFilter("");
    onChange([...customModels, { slug: normalized, name: normalized, capabilities: null }]);
    setInput("");
    setError(null);
    setIsAdding(false);
  };

  const cancelAdd = () => {
    setInput("");
    setError(null);
    setIsAdding(false);
  };

  const handleRemove = (slug: string) => {
    if (editingSlug === slug) setEditingSlug(null);
    onChange(customModels.filter((entry) => entry.slug !== slug));
    onModelPreferencesChange({
      hiddenModels,
      modelOrder: modelOrder.filter((model) => model !== slug),
    });
    onFavoriteModelsChange(favoriteModels.filter((model) => model !== slug));
    setError(null);
  };

  const handleSaveEdit = (next: CustomModelDefinition) => {
    onChange(customModels.map((entry) => (entry.slug === next.slug ? next : entry)));
    setEditingSlug(null);
  };

  const setHidden = (slug: string, isHidden: boolean) => {
    if (isHidden === hiddenModelSet.has(slug)) return;
    onModelPreferencesChange({
      hiddenModels: isHidden
        ? [...hiddenModels, slug]
        : hiddenModels.filter((model) => model !== slug),
      modelOrder,
    });
  };

  const handleToggleFavorite = (slug: string) => {
    onFavoriteModelsChange(
      favoriteModelSet.has(slug)
        ? favoriteModels.filter((model) => model !== slug)
        : [...favoriteModels, slug],
    );
  };

  // `dragHandle` is the sortable activator, or `null` for filtered rows,
  // which cannot be dragged. `preview` shows the state the lifted row will
  // have when dropped in that segment.
  const renderRow = (
    model: ServerProviderModel,
    dragHandle: ModelDragHandle | null,
    preview?: ModelListSegment | null,
  ) => {
    const capLabels = describeModelCapabilities(model);
    // Hidden is read from the preference itself: a favorited model can still be
    // hidden, and its switch must say so even though it sits among favorites.
    const isHidden = preview === "hidden" || (preview !== "enabled" && isHiddenModel(model));
    const isFavorite = preview ? preview === "favorites" : favoriteModelSet.has(model.slug);
    return (
      <div
        data-model-slug={model.slug}
        className={cn(
          "grid h-7 grid-cols-[auto_1.5rem_minmax(0,1fr)_auto_auto] items-center gap-2 rounded-md px-2 transition-colors hover:bg-muted/30",
          isHidden && "opacity-50",
        )}
      >
        {dragHandle ? (
          <Button
            ref={dragHandle.setActivatorNodeRef}
            size="icon-micro"
            variant="ghost-muted"
            {...dragHandle.attributes}
            {...dragHandle.listeners}
            aria-label={`Drag to reorder ${model.name}`}
            className="cursor-grab touch-none active:cursor-grabbing"
          >
            <GripVerticalIcon className="size-3" />
          </Button>
        ) : (
          // Filtered rows are not draggable; keep the columns aligned.
          <span className="size-5 shrink-0" aria-hidden />
        )}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-micro"
                variant="ghost-muted"
                onClick={() => handleToggleFavorite(model.slug)}
                aria-label={`${isFavorite ? "Remove" : "Add"} ${model.name} ${
                  isFavorite ? "from" : "to"
                } favorites`}
              />
            }
          >
            <StarIcon className={cn("size-3", isFavorite && "fill-current text-warning")} />
          </TooltipTrigger>
          <TooltipPopup side="top">
            {isFavorite ? "Remove from favorites" : "Add to favorites"}
          </TooltipPopup>
        </Tooltip>
        <span className="flex min-w-0 items-baseline gap-2">
          <span
            className={cn(
              "truncate text-xs",
              isHidden ? "text-muted-foreground" : "text-foreground/90",
            )}
          >
            {model.name}
          </span>
          {model.name !== model.slug ? (
            <code className="truncate font-mono text-2xs text-muted-foreground/70">
              {model.slug}
            </code>
          ) : null}
          {model.isCustom ? (
            <span className="text-2xs text-muted-foreground/70">custom</span>
          ) : null}
        </span>
        {/* Always a grid item so the columns line up across rows; the text
            itself drops out on phone widths where it would starve the name. */}
        <span className="text-2xs text-muted-foreground/70">
          {capLabels.length > 0 ? (
            <span className="hidden sm:inline">{capLabels.join(" · ")}</span>
          ) : null}
        </span>
        {/* Wide enough for the custom-row buttons plus the switch so the
            capability labels line up across built-in and custom rows. */}
        <span className="flex min-w-[4.5rem] shrink-0 items-center justify-end gap-0.5">
          {model.isCustom ? (
            <>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      size="icon-micro"
                      variant="ghost-muted"
                      aria-label={`Edit ${model.slug}`}
                      onClick={() =>
                        setEditingSlug((current) => (current === model.slug ? null : model.slug))
                      }
                    />
                  }
                >
                  <PencilIcon className="size-3" />
                </TooltipTrigger>
                <TooltipPopup side="top">Edit name and options</TooltipPopup>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      size="icon-micro"
                      variant="ghost-muted"
                      aria-label={`Remove ${model.slug}`}
                      onClick={() => handleRemove(model.slug)}
                    />
                  }
                >
                  <XIcon className="size-3" />
                </TooltipTrigger>
                <TooltipPopup side="top">Remove custom model</TooltipPopup>
              </Tooltip>
            </>
          ) : null}
          {/* The trigger is a wrapper span: a disabled switch gets no pointer
              events, so it could not open the tooltip itself. */}
          <Tooltip>
            <TooltipTrigger render={<span className="flex shrink-0 items-center" />}>
              <Switch
                size="sm"
                checked={!isHidden}
                disabled={model.isCustom}
                onCheckedChange={(checked) => setHidden(model.slug, !checked)}
                aria-label={`Show ${model.name} in the model picker`}
              />
            </TooltipTrigger>
            <TooltipPopup side="top">
              {model.isCustom
                ? "Custom models are always shown in the picker"
                : isHidden
                  ? "Hidden from picker"
                  : "Shown in picker"}
            </TooltipPopup>
          </Tooltip>
        </span>
      </div>
    );
  };

  const renderEditor = (model: ServerProviderModel) => {
    const entry =
      model.isCustom && editingSlug === model.slug
        ? customModels.find((entry) => entry.slug === model.slug)
        : undefined;
    if (!entry) return null;
    return (
      <CustomModelEditor
        instanceId={instanceId}
        driverKind={driverKind}
        entry={entry}
        builtInModels={builtInModels}
        onSave={handleSaveEdit}
        onCancel={() => setEditingSlug(null)}
      />
    );
  };

  // One flat keyed list, like the sidebar's: a row that changes segment keeps
  // its DOM node, so list motion glides it instead of fading a new one in.
  const modelBySlug = new Map(displayModels.map((model) => [model.slug, model]));
  const renderSortableItem = (id: string) => {
    switch (id) {
      case FAVORITES_SLOT_ID:
        // Without favorites, the slot and the "All" label below are the
        // favorites preview. Both stay mounted, transparent, so their heights
        // can be read when a drag starts, and fade at the pace of dnd-kit
        // sliding the rows (`transform 250ms ease`).
        return (
          <SortableMarker key={id} id={id} className="relative h-0">
            <div
              className={cn(
                "absolute inset-x-0 top-0",
                favoritesPreviewClassName(dropTarget === "favorites"),
              )}
            >
              <div ref={favoritesLabelRef} className={favoritesLabelClassName(true)}>
                Favorites
              </div>
              <div className={emptySlotClassName(true)} style={{ height: drag?.rowHeight }}>
                Drop here to add to favorites
              </div>
            </div>
          </SortableMarker>
        );
      // The real label and its preview are separate nodes, so list motion
      // fades the label in and out with the favorites section.
      case ALL_LABEL_ID:
        return favorites.length > 0 ? (
          <SortableMarker
            key={id}
            id={id}
            className={groupLabelClassName(dropTarget === "enabled")}
          >
            All
          </SortableMarker>
        ) : (
          <SortableMarker key={`${id}:preview`} id={id} className="relative h-0">
            <div
              ref={allLabelRef}
              className={cn(
                groupLabelClassName(false),
                "absolute inset-x-0 top-0",
                favoritesPreviewClassName(dropTarget === "favorites"),
              )}
            >
              All
            </div>
          </SortableMarker>
        );
      case ENABLED_SLOT_ID:
        return (
          <SortableMarker key={id} id={id} className={emptySlotClassName(dropTarget === "enabled")}>
            Drop models here to show them in the picker
          </SortableMarker>
        );
      case HIDDEN_LABEL_ID:
        return (
          <SortableMarker key={id} id={id} className={groupLabelClassName(dropTarget === "hidden")}>
            Hidden from picker
          </SortableMarker>
        );
      case HIDDEN_SLOT_ID:
        return (
          <SortableMarker key={id} id={id} className={emptySlotClassName(dropTarget === "hidden")}>
            Drop models here to hide them from the picker
          </SortableMarker>
        );
    }
    const model = modelBySlug.get(id);
    if (!model) return null;
    // The editor sits inside the sortable node so the gap it opens is measured.
    return (
      <SortableModelRow key={id} slug={id}>
        {(handle, isLifted) => (
          <>
            {renderRow(model, handle, isLifted ? dropTarget : null)}
            {renderEditor(model)}
          </>
        )}
      </SortableModelRow>
    );
  };

  const placeholder = (text: string) => (
    <p className="px-2 py-2 text-xs text-muted-foreground">{text}</p>
  );

  return (
    <div className="lg:flex lg:h-full lg:min-h-0 lg:flex-col">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {showFilter ? (
          <Input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter models"
            size="sm"
            className="w-56 max-w-full"
            spellCheck={false}
            aria-label="Filter models"
          />
        ) : null}
        <div className="flex items-center gap-2">
          {builtInModels.length > 0 ? (
            <Button
              type="button"
              size="xs"
              variant="ghost-muted"
              onClick={() =>
                onModelPreferencesChange({
                  hiddenModels: nextHiddenModelsForBulkToggle(models, hiddenModels),
                  modelOrder,
                })
              }
            >
              {allBuiltInModelsHidden ? "Enable all" : "Disable all"}
            </Button>
          ) : null}
          <span className="text-xs text-muted-foreground">
            {models.length} model{models.length === 1 ? "" : "s"}
            {favorites.length > 0
              ? ` · ${favorites.length} favorite${favorites.length === 1 ? "" : "s"}`
              : ""}
            {hiddenCount > 0 ? ` · ${hiddenCount} hidden` : ""}
          </span>
        </div>
        {driverKind !== "antigravity" && !isAdding ? (
          <Button
            type="button"
            size="xs"
            variant="ghost-muted"
            className="ml-auto"
            onClick={() => setIsAdding(true)}
          >
            <PlusIcon className="size-3" />
            Add custom model
          </Button>
        ) : null}
      </div>
      <div
        ref={attachListRef}
        className="relative mt-2 -mx-2 max-h-64 overflow-y-auto lg:max-h-none lg:min-h-0 lg:flex-1"
      >
        {models.length === 0 ? (
          placeholder("No models reported for this provider yet.")
        ) : isFiltering ? (
          // Reordering a filtered view would be ambiguous, so it is a plain
          // list without drag handles.
          filteredModels.length === 0 ? (
            placeholder("No models match.")
          ) : (
            filteredModels.map((model) => (
              <div key={model.slug}>
                {renderRow(model, null)}
                {renderEditor(model)}
              </div>
            ))
          )
        ) : (
          <DndContext
            sensors={dndSensors}
            collisionDetection={dndCollisionDetection}
            modifiers={[restrictToVerticalAxis, restrictToFirstScrollableAncestor]}
            onDragStart={handleDragStart}
            onDragOver={trackDrag}
            onDragEnd={handleDragEnd}
            onDragCancel={handleDragCancel}
          >
            <SortableContext items={sortableIds} strategy={dndSortingStrategy}>
              {favorites.length > 0 ? (
                <div
                  key="favorites-title"
                  className={favoritesLabelClassName(dropTarget === "favorites")}
                >
                  Favorites
                </div>
              ) : null}
              {sortableIds.map(renderSortableItem)}
            </SortableContext>
          </DndContext>
        )}
      </div>

      {driverKind === "antigravity" ? null : isAdding ? (
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <Input
            id={`provider-instance-${instanceId}-custom-model`}
            size="sm"
            autoFocus
            value={input}
            onChange={(event) => {
              setInput(event.target.value);
              if (error) setError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                cancelAdd();
                return;
              }
              if (event.key !== "Enter") return;
              event.preventDefault();
              handleAdd();
            }}
            placeholder={driverKind ? CUSTOM_MODEL_PLACEHOLDER_BY_KIND[driverKind] : "model-slug"}
            spellCheck={false}
          />
          <div className="flex shrink-0 gap-2">
            <Button size="sm" variant="outline" onClick={handleAdd}>
              Add
            </Button>
            <Button size="sm" variant="ghost" onClick={cancelAdd}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}

      {driverKind !== "antigravity" && error ? (
        <p className="mt-2 text-xs text-destructive">{error}</p>
      ) : null}
    </div>
  );
}
