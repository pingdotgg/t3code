import {
  DndContext,
  type DraggableAttributes,
  type DraggableSyntheticListeners,
  type DragEndEvent,
  type DragStartEvent,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToParentElement, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS as DndCSS } from "@dnd-kit/utilities";
import { GripVerticalIcon, PencilIcon, PlusIcon, StarIcon, XIcon } from "lucide-react";
import { msg, T, useGT, useMessages } from "gt-react";
import { createContext, memo, type ReactNode, use, useEffect, useRef, useState } from "react";
import {
  ProviderDriverKind,
  type ProviderInstanceId,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { isReasoningControl } from "@t3tools/client-runtime/model-traits";
import { type CustomModelDefinition, normalizeCustomModelSlug } from "@t3tools/shared/model";

import { useStableCallback } from "../../hooks/useStableCallback";
import type { MessageResolver } from "../../i18n/messages";
import { cn } from "../../lib/utils";
import { sortModelsForProviderInstance } from "../../modelOrdering";
import { MAX_CUSTOM_MODEL_LENGTH } from "../../modelSelection";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { CustomModelEditor } from "./CustomModelEditor";

const CUSTOM_MODEL_PLACEHOLDER_BY_KIND: Partial<Record<ProviderDriverKind, string>> = {
  [ProviderDriverKind.make("codex")]: "gpt-6.7-codex-ultra-preview",
  [ProviderDriverKind.make("claudeAgent")]: "claude-sonnet-5",
  [ProviderDriverKind.make("cursor")]: "claude-sonnet-4-6",
  [ProviderDriverKind.make("opencode")]: "openai/gpt-5",
  [ProviderDriverKind.make("pi")]: "anthropic/claude-sonnet-5",
};

const FILTER_THRESHOLD = 8;

// Constant options keep dnd-kit's sensors, and so each row's listeners, stable for the row memo.
const POINTER_SENSOR_OPTIONS = { activationConstraint: { distance: 4 } };
const KEYBOARD_SENSOR_OPTIONS = { coordinateGetter: sortableKeyboardCoordinates };

// Positions shift for many rows when one is starred, so only the grip reads them, not the row memo.
const ModelPositionContext = createContext<ReadonlyMap<string, number>>(new Map());

const PROVIDER_ALIAS_SLUGS = new Set(["default", "auto"]);

function hasReasoningControl(model: ServerProviderModel): boolean {
  return (model.capabilities?.optionDescriptors ?? []).some(isReasoningControl);
}

// Reasoning is the norm, so only its absence is labeled, and only when other models have it.
// Custom and null capabilities are fallbacks or user-written, not discovered, so they prove nothing.
// Alias slugs ("default", Cursor's "auto") defer to the provider's own model choice, so reasoning is unknown.
function describeModelCapabilities(
  model: ServerProviderModel,
  flagMissingReasoning: boolean,
  resolve: MessageResolver,
): string[] {
  const descriptors = model.capabilities?.optionDescriptors ?? [];
  const labels: string[] = [];
  const hasFastMode = descriptors.some(
    (descriptor) =>
      descriptor.id === "fastMode" ||
      (descriptor.id === "serviceTier" &&
        descriptor.type === "select" &&
        descriptor.options.some((option) => option.id === "fast" || option.label === "Fast")),
  );
  if (hasFastMode) labels.push(resolve(msg("Fast mode")));
  if (
    flagMissingReasoning &&
    !model.isCustom &&
    model.capabilities &&
    !PROVIDER_ALIAS_SLUGS.has(model.slug) &&
    !hasReasoningControl(model)
  ) {
    labels.push(resolve(msg("No reasoning")));
  }
  return labels;
}

function groupModelsForDisplay<T extends { readonly slug: string; readonly isCustom: boolean }>(
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

function nextHiddenModelsForBulkToggle(
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

interface ProviderModelsSectionProps {
  readonly instanceId: ProviderInstanceId;
  readonly driverKind: ProviderDriverKind | null;
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly customModels: ReadonlyArray<CustomModelDefinition>;
  readonly canManageCustomModels: boolean;
  readonly canWritePreferences?: boolean;
  readonly hiddenModels: ReadonlyArray<string>;
  readonly favoriteModels: ReadonlyArray<string>;
  readonly modelOrder: ReadonlyArray<string>;
  /** Resolves true once the custom models are saved. */
  readonly onChange: (next: ReadonlyArray<CustomModelDefinition>) => Promise<boolean>;
  readonly onHiddenModelsChange: (
    next: ReadonlyArray<string>,
    affectedModels: ReadonlyArray<string>,
  ) => void;
  readonly onFavoriteModelsChange: (next: ReadonlyArray<string>) => void;
  readonly onToggleFavorite: (model: string) => void;
  readonly onModelOrderChange: (next: ReadonlyArray<string>) => void;
}

type ModelGroup = "favorite" | "visible" | "hidden";

export function ProviderModelsSection({
  instanceId,
  driverKind,
  models,
  customModels,
  canManageCustomModels,
  canWritePreferences = true,
  hiddenModels,
  favoriteModels,
  modelOrder,
  onChange,
  onHiddenModelsChange,
  onFavoriteModelsChange,
  onToggleFavorite,
  onModelOrderChange,
}: ProviderModelsSectionProps) {
  const gt = useGT();
  const [input, setInput] = useState("");
  const [isAdding, setIsAdding] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const addAttemptRef = useRef(0);
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [editingSlug, setEditingSlug] = useState<string | null>(null);
  const editAttemptRef = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);
  const scrollToSlugRef = useRef<string | null>(null);
  // A row toggled on its own keeps its placement until a bulk toggle or remount regroups the list.
  const [heldPlacements, setHeldPlacements] = useState<ReadonlyMap<string, boolean>>(
    () => new Map(),
  );
  const hiddenModelSet = new Set(hiddenModels);
  const favoriteModelSet = new Set(favoriteModels);
  const reportedSlugs = new Set(models.map((model) => model.slug));
  // A favorite the provider no longer reports (disabled, signed out, model removed)
  // still needs a row, or its star could never be cleared.
  const unreportedFavoriteModels = favoriteModels.flatMap((slug): ServerProviderModel[] =>
    reportedSlugs.has(slug) ? [] : [{ slug, name: slug, isCustom: false, capabilities: null }],
  );
  const listedModels = [...models, ...unreportedFavoriteModels];
  const placedHiddenSet = new Set(
    listedModels
      .filter((model) => heldPlacements.get(model.slug) ?? hiddenModelSet.has(model.slug))
      .map((model) => model.slug),
  );
  const displayModels = groupModelsForDisplay(listedModels, {
    favoriteModels: favoriteModelSet,
    hiddenModels: placedHiddenSet,
    modelOrder,
  });
  const favoriteCount = displayModels.filter((model) => favoriteModelSet.has(model.slug)).length;
  const hiddenCount = displayModels.filter(
    (model) => !model.isCustom && hiddenModelSet.has(model.slug),
  ).length;
  const flagMissingReasoning = models.some(hasReasoningControl);
  const showFilter = models.length > FILTER_THRESHOLD;
  const normalizedFilter = filter.trim().toLowerCase();
  const isFiltering = showFilter && normalizedFilter.length > 0;
  const visibleModels = isFiltering
    ? displayModels.filter(
        (model) =>
          model.name.toLowerCase().includes(normalizedFilter) ||
          model.slug.toLowerCase().includes(normalizedFilter),
      )
    : displayModels;

  // A model added or moved lands in a later commit, so each commit looks for the pending row.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- scrolls the pending model's DOM row into view once a later commit renders it
  useEffect(() => {
    const slug = scrollToSlugRef.current;
    if (slug === null) return;
    const row = listRef.current?.querySelector<HTMLElement>(
      `[data-model-slug="${CSS.escape(slug)}"]`,
    );
    if (!row) return;
    scrollToSlugRef.current = null;
    row.scrollIntoView({ block: "nearest" });
  });

  // Derive after the effect and use hiddenModels directly to preserve the editor's option-array cache.
  const builtInModels = models.filter((model) => !model.isCustom);
  const allBuiltInModelsHidden =
    builtInModels.length > 0 && builtInModels.every((model) => hiddenModels.includes(model.slug));

  const handleAdd = async () => {
    if (!canManageCustomModels || driverKind === "antigravity" || isSaving) return;
    const normalized = normalizeCustomModelSlug(input);
    if (!normalized) {
      setError(gt("Enter a model slug."));
      return;
    }
    if (models.some((model) => !model.isCustom && model.slug === normalized)) {
      setError(gt("That model is already built in."));
      return;
    }
    if (normalized.length > MAX_CUSTOM_MODEL_LENGTH) {
      setError(
        gt("Model slugs must be {max} characters or less.", { max: MAX_CUSTOM_MODEL_LENGTH }),
      );
      return;
    }
    if (customModels.some((entry) => entry.slug === normalized)) {
      setError(gt("That custom model is already saved."));
      return;
    }

    addAttemptRef.current += 1;
    const attempt = addAttemptRef.current;
    setIsSaving(true);
    const saved = await onChange([
      ...customModels,
      { slug: normalized, name: normalized, capabilities: null },
    ]);
    setIsSaving(false);
    // Cancel bumps the attempt, so a late save cannot close the draft opened after it.
    if (!saved || attempt !== addAttemptRef.current) return;
    scrollToSlugRef.current = normalized;
    setFilter("");
    setInput("");
    setError(null);
    setIsAdding(false);
  };

  const cancelAdd = () => {
    addAttemptRef.current += 1;
    setInput("");
    setError(null);
    setIsAdding(false);
  };

  const handleRemove = (slug: string) => {
    if (!canManageCustomModels) return;
    if (editingSlug === slug) {
      editAttemptRef.current += 1;
      setEditingSlug(null);
    }
    void onChange(customModels.filter((entry) => entry.slug !== slug));
    if (modelOrder.includes(slug)) onModelOrderChange(modelOrder.filter((model) => model !== slug));
    onFavoriteModelsChange(favoriteModels.filter((model) => model !== slug));
    setError(null);
  };

  const handleSaveEdit = async (next: CustomModelDefinition) => {
    if (!canManageCustomModels) return;
    const attempt = ++editAttemptRef.current;
    const saved = await onChange(
      customModels.map((entry) => (entry.slug === next.slug ? next : entry)),
    );
    if (saved && attempt === editAttemptRef.current) setEditingSlug(null);
  };

  const setHidden = (slug: string, hidden: boolean) => {
    if (!canWritePreferences || hidden === hiddenModelSet.has(slug)) return;
    setHeldPlacements((current) =>
      current.has(slug) ? current : new Map(current).set(slug, hiddenModelSet.has(slug)),
    );
    onHiddenModelsChange(
      hidden ? [...hiddenModels, slug] : hiddenModels.filter((model) => model !== slug),
      [slug],
    );
  };

  const handleToggleFavorite = (slug: string) => {
    if (!canWritePreferences) return;
    onToggleFavorite(slug);
  };

  const groupOf = (model: (typeof displayModels)[number]): ModelGroup =>
    favoriteModelSet.has(model.slug)
      ? "favorite"
      : !model.isCustom && placedHiddenSet.has(model.slug)
        ? "hidden"
        : "visible";
  const sensors = useSensors(
    useSensor(PointerSensor, POINTER_SENSOR_OPTIONS),
    useSensor(KeyboardSensor, KEYBOARD_SENSOR_OPTIONS),
  );
  // Groups share one list so a row keeps its DOM (and focus) when it changes group.
  // While dragging, other groups stop accepting drops; pointer and keyboard both honor that.
  const [dragGroup, setDragGroup] = useState<ModelGroup | null>(null);
  const handleDragStart = (event: DragStartEvent) => {
    const model = displayModels.find((entry) => entry.slug === String(event.active.id));
    setDragGroup(model === undefined ? null : groupOf(model));
  };
  const handleDragEnd = (event: DragEndEvent) => {
    setDragGroup(null);
    if (!canWritePreferences || event.over === null || event.active.id === event.over.id) return;
    const order = displayModels.map((model) => model.slug);
    const from = order.indexOf(String(event.active.id));
    const to = order.indexOf(String(event.over.id));
    if (from < 0 || to < 0) return;
    // Another device can star or hide a row mid-drag, moving it out of the drag's group.
    if (groupOf(displayModels[from]!) !== groupOf(displayModels[to]!)) return;
    onModelOrderChange(arrayMove(order, from, to));
  };

  const handleToggleEdit = useStableCallback((slug: string) => {
    // A keyboard drag listens on the document, so an editor opened mid-drag would lose Space to it.
    if (!canManageCustomModels || dragGroup !== null) return;
    editAttemptRef.current += 1;
    setEditingSlug((current) => (current === slug ? null : slug));
  });
  const rowHandlers = {
    onToggleFavorite: useStableCallback(handleToggleFavorite),
    onSetHidden: useStableCallback(setHidden),
    onToggleEdit: handleToggleEdit,
    onRemove: useStableCallback(handleRemove),
  };

  // A slug with no custom row (reset, removed, now built in) opens no editor and blocks nothing.
  const editingEntry =
    canManageCustomModels && models.some((model) => model.isCustom && model.slug === editingSlug)
      ? customModels.find((entry) => entry.slug === editingSlug)
      : undefined;
  const positionInGroup: Record<ModelGroup, number> = { favorite: 0, visible: 0, hidden: 0 };
  const positions = new Map(
    visibleModels.map((model) => [model.slug, ++positionInGroup[groupOf(model)]]),
  );
  const groupLabels: Record<ModelGroup, string | null> = {
    favorite: favoriteCount > 0 ? gt("Favorites") : null,
    visible: favoriteCount > 0 ? gt("All", { $context: "group of all visible models" }) : null,
    hidden: gt("Hidden from picker"),
  };

  return (
    <div className="lg:flex lg:h-full lg:min-h-0 lg:flex-col">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {showFilter ? (
          <Input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder={gt("Filter models")}
            size="sm"
            className="w-56 max-w-full"
            spellCheck={false}
            aria-label={gt("Filter models")}
          />
        ) : null}
        <div className="flex items-center gap-2">
          {builtInModels.length > 0 ? (
            <Button
              type="button"
              size="xs"
              variant="ghost-muted"
              onClick={() => {
                setHeldPlacements(new Map());
                onHiddenModelsChange(
                  nextHiddenModelsForBulkToggle(models, hiddenModels),
                  builtInModels.map((model) => model.slug),
                );
              }}
            >
              {allBuiltInModelsHidden ? gt("Enable all") : gt("Disable all")}
            </Button>
          ) : null}
          <span className="text-xs text-muted-foreground">
            {gt("{count, plural, one {{count} model} other {{count} models}}", {
              count: models.length,
            })}
            {favoriteCount > 0
              ? ` · ${gt("{count, plural, one {{count} favorite} other {{count} favorites}}", {
                  count: favoriteCount,
                })}`
              : ""}
            {hiddenCount > 0
              ? ` · ${gt("{count, plural, other {{count} hidden}}", { count: hiddenCount })}`
              : ""}
          </span>
        </div>
        {driverKind !== "antigravity" && !isAdding ? (
          <Button
            type="button"
            size="xs"
            variant="ghost-muted"
            // The ghost padding would inset the label from the column edge the toggles align to.
            className="-me-2 ml-auto"
            onClick={() => setIsAdding(true)}
          >
            <PlusIcon className="size-3" />
            <T>Add custom model</T>
          </Button>
        ) : null}
      </div>
      <div
        ref={listRef}
        className="mt-2 -mx-2 max-h-64 overflow-y-auto lg:max-h-none lg:min-h-0 lg:flex-1"
      >
        {visibleModels.length === 0 ? (
          <p className="px-2 py-2 text-xs text-muted-foreground">
            {isFiltering ? gt("No models match.") : gt("No models reported for this provider yet.")}
          </p>
        ) : null}
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={[restrictToVerticalAxis, restrictToParentElement]}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onDragCancel={() => setDragGroup(null)}
        >
          <SortableContext
            items={visibleModels.map((model) => model.slug)}
            strategy={verticalListSortingStrategy}
          >
            <ModelPositionContext value={positions}>
              <div>
                {visibleModels.flatMap((model, index) => {
                  const group = groupOf(model);
                  const previous = visibleModels[index - 1];
                  const startsGroup = previous === undefined || groupOf(previous) !== group;
                  const label = startsGroup ? groupLabels[group] : null;
                  const isHidden = !model.isCustom && hiddenModelSet.has(model.slug);
                  const rowEditingEntry =
                    model.isCustom && model.slug === editingEntry?.slug ? editingEntry : undefined;
                  const showHandle = !isHidden && !isFiltering;
                  // An open editor stretches its row's drop target, so reordering waits for it to
                  // close. The grip stays so the row's buttons do not shift under the cursor.
                  const canDrag = canWritePreferences && showHandle && editingEntry === undefined;
                  const item = (
                    <SortableModelItem
                      key={`${instanceId}:model:${model.slug}`}
                      slug={model.slug}
                      canDrag={canDrag}
                      acceptsDrop={dragGroup === null || dragGroup === group}
                      renderRow={(handleRef, handleAttributes, handleListeners) => (
                        <ProviderModelRow
                          model={model}
                          isHidden={isHidden}
                          isFavorite={group === "favorite"}
                          showHandle={showHandle}
                          canDrag={canDrag}
                          handleRef={handleRef}
                          handleAttributes={handleAttributes}
                          handleListeners={handleListeners}
                          flagMissingReasoning={flagMissingReasoning}
                          canWritePreferences={canWritePreferences}
                          canManageCustomModels={canManageCustomModels}
                          {...rowHandlers}
                        />
                      )}
                    >
                      {rowEditingEntry ? (
                        <CustomModelEditor
                          instanceId={instanceId}
                          driverKind={driverKind}
                          entry={rowEditingEntry}
                          builtInModels={builtInModels}
                          onSave={(next) => void handleSaveEdit(next)}
                          onDraftChange={() => {
                            editAttemptRef.current += 1;
                          }}
                          onCancel={() => {
                            editAttemptRef.current += 1;
                            setEditingSlug(null);
                          }}
                        />
                      ) : null}
                    </SortableModelItem>
                  );
                  if (label === null) return [item];
                  return [
                    <div
                      key={`${instanceId}:label:${group}`}
                      className={cn(
                        "px-2 pb-1.5 text-2xs text-muted-foreground",
                        index === 0 ? "pt-1" : "pt-5",
                      )}
                    >
                      {label}
                    </div>,
                    item,
                  ];
                })}
              </div>
            </ModelPositionContext>
          </SortableContext>
        </DndContext>
      </div>

      {driverKind === "antigravity" || !canManageCustomModels ? null : isAdding ? (
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <Input
            id={`provider-instance-${instanceId}-custom-model`}
            size="sm"
            autoFocus
            readOnly={isSaving}
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
              void handleAdd();
            }}
            placeholder={driverKind ? CUSTOM_MODEL_PLACEHOLDER_BY_KIND[driverKind] : "model-slug"}
            spellCheck={false}
          />
          <div className="flex shrink-0 gap-2">
            <Button size="sm" variant="outline" disabled={isSaving} onClick={handleAdd}>
              {gt("Add", { $context: "verb, adds a custom model" })}
            </Button>
            <Button size="sm" variant="ghost" onClick={cancelAdd}>
              <T>Cancel</T>
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

function SortableModelItem({
  slug,
  canDrag,
  acceptsDrop,
  renderRow,
  children,
}: {
  readonly slug: string;
  readonly canDrag: boolean;
  readonly acceptsDrop: boolean;
  readonly renderRow: (
    handleRef: (element: HTMLElement | null) => void,
    handleAttributes: DraggableAttributes,
    handleListeners: DraggableSyntheticListeners,
  ) => ReactNode;
  readonly children: ReactNode;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: slug, disabled: { draggable: !canDrag, droppable: !acceptsDrop } });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: DndCSS.Translate.toString(transform), transition }}
      className={cn(isDragging && "relative z-10 rounded-md bg-background shadow-md")}
    >
      {renderRow(setActivatorNodeRef, attributes, listeners)}
      {children}
    </div>
  );
}

const ProviderModelRow = memo(function ProviderModelRow({
  model,
  isHidden,
  isFavorite,
  showHandle,
  canDrag,
  handleRef,
  handleAttributes,
  handleListeners,
  flagMissingReasoning,
  canWritePreferences,
  canManageCustomModels,
  onToggleFavorite,
  onSetHidden,
  onToggleEdit,
  onRemove,
}: {
  readonly model: ServerProviderModel;
  readonly isHidden: boolean;
  readonly isFavorite: boolean;
  readonly showHandle: boolean;
  readonly canDrag: boolean;
  readonly handleRef: (element: HTMLElement | null) => void;
  readonly handleAttributes: DraggableAttributes;
  readonly handleListeners: DraggableSyntheticListeners;
  readonly flagMissingReasoning: boolean;
  readonly canWritePreferences: boolean;
  readonly canManageCustomModels: boolean;
  readonly onToggleFavorite: (slug: string) => void;
  readonly onSetHidden: (slug: string, hidden: boolean) => void;
  readonly onToggleEdit: (slug: string) => void;
  readonly onRemove: (slug: string) => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const capLabels = describeModelCapabilities(model, flagMissingReasoning, m);
  const nameClassName = cn("text-xs", isHidden ? "text-muted-foreground" : "text-foreground/90");
  const pickerTooltip = model.isCustom
    ? gt("Custom models are always shown in the picker")
    : isHidden
      ? gt("Hidden from picker")
      : gt("Shown in picker");

  return (
    <div
      data-model-slug={model.slug}
      className={cn(
        "grid h-7 grid-cols-[1.5rem_minmax(0,1fr)_auto_minmax(5.5rem,auto)_auto] items-center gap-2 rounded-md px-2 transition-colors hover:bg-muted/30",
        isHidden && "opacity-50",
      )}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="icon-micro"
              variant="ghost-muted"
              disabled={!canWritePreferences}
              onClick={() => onToggleFavorite(model.slug)}
              aria-label={
                isFavorite
                  ? gt("Remove {name} from favorites", { name: model.name })
                  : gt("Add {name} to favorites", { name: model.name })
              }
            />
          }
        >
          <StarIcon className={cn("size-3", isFavorite && "fill-current text-warning")} />
        </TooltipTrigger>
        <TooltipPopup side="top">
          {isFavorite ? gt("Remove from favorites") : gt("Add to favorites")}
        </TooltipPopup>
      </Tooltip>
      <span className="flex min-w-0 items-baseline gap-2">
        <Tooltip>
          <TooltipTrigger
            render={
              <span tabIndex={0} className="flex min-w-0 items-baseline gap-2 overflow-hidden" />
            }
          >
            <span className={cn(nameClassName, "max-w-full shrink-0 truncate")}>{model.name}</span>
            {model.name !== model.slug ? (
              <code className="truncate font-mono text-2xs text-muted-foreground/70">
                {model.slug}
              </code>
            ) : null}
          </TooltipTrigger>
          <TooltipPopup side="top" align="start">
            <div>{model.name}</div>
            {model.name !== model.slug ? (
              <code className="font-mono text-2xs text-muted-foreground">{model.slug}</code>
            ) : null}
          </TooltipPopup>
        </Tooltip>
        {model.isCustom ? (
          <span className="shrink-0 text-2xs text-muted-foreground/70">
            {gt("custom", { $context: "badge, user-added model" })}
          </span>
        ) : null}
      </span>
      <span className="text-2xs text-muted-foreground/70">
        {capLabels.length > 0 ? (
          <span className="hidden sm:inline">{capLabels.join(" · ")}</span>
        ) : null}
      </span>
      <span className="flex shrink-0 items-center justify-end gap-0.5">
        {model.isCustom ? (
          <>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-micro"
                    variant="ghost-muted"
                    disabled={!canManageCustomModels}
                    aria-label={gt("Edit {name}", { name: model.slug })}
                    onClick={() => onToggleEdit(model.slug)}
                  />
                }
              >
                <PencilIcon className="size-3" />
              </TooltipTrigger>
              <TooltipPopup side="top">
                <T>Edit name and options</T>
              </TooltipPopup>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-micro"
                    variant="ghost-muted"
                    disabled={!canManageCustomModels}
                    aria-label={gt("Remove {name}", { name: model.slug })}
                    onClick={() => onRemove(model.slug)}
                  />
                }
              >
                <XIcon className="size-3" />
              </TooltipTrigger>
              <TooltipPopup side="top">
                <T>Remove custom model</T>
              </TooltipPopup>
            </Tooltip>
          </>
        ) : null}
        {showHandle ? (
          <ModelDragHandle
            slug={model.slug}
            name={model.name}
            disabled={!canDrag}
            handleRef={handleRef}
            handleAttributes={handleAttributes}
            handleListeners={handleListeners}
          />
        ) : null}
      </span>
      {/* Disabled switches receive no pointer events; wrap the tooltip trigger. */}
      <Tooltip>
        <TooltipTrigger render={<span className="flex shrink-0 items-center" />}>
          <Switch
            size="sm"
            checked={!isHidden}
            disabled={!canWritePreferences || model.isCustom}
            onCheckedChange={(checked) => onSetHidden(model.slug, !checked)}
            aria-label={gt("Show {name} in the model picker", { name: model.name })}
          />
        </TooltipTrigger>
        <TooltipPopup side="top">{pickerTooltip}</TooltipPopup>
      </Tooltip>
    </div>
  );
});

function ModelDragHandle({
  slug,
  name,
  disabled,
  handleRef,
  handleAttributes,
  handleListeners,
}: {
  readonly slug: string;
  readonly name: string;
  readonly disabled: boolean;
  readonly handleRef: (element: HTMLElement | null) => void;
  readonly handleAttributes: DraggableAttributes;
  readonly handleListeners: DraggableSyntheticListeners;
}) {
  const gt = useGT();
  const position = use(ModelPositionContext).get(slug) ?? 0;
  return (
    <button
      type="button"
      ref={handleRef}
      {...handleAttributes}
      {...handleListeners}
      disabled={disabled}
      aria-label={gt("Reorder {route}, position {position}", { route: name, position })}
      className="flex size-5 shrink-0 cursor-grab touch-none items-center justify-center rounded text-muted-foreground/70 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring active:cursor-grabbing disabled:pointer-events-none disabled:opacity-50"
    >
      <GripVerticalIcon className="size-3" />
    </button>
  );
}
