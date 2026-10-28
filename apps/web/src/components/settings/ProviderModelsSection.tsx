import { ArrowDownIcon, ArrowUpIcon, PencilIcon, PlusIcon, StarIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  ProviderDriverKind,
  type ProviderInstanceId,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { type CustomModelDefinition, normalizeCustomModelSlug } from "@t3tools/shared/model";

import { useStableCallback } from "../../hooks/useStableCallback";
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
  readonly onChange: (next: ReadonlyArray<CustomModelDefinition>) => void;
  readonly onHiddenModelsChange: (
    next: ReadonlyArray<string>,
    affectedModels: ReadonlyArray<string>,
  ) => void;
  readonly onFavoriteModelsChange: (next: ReadonlyArray<string>) => void;
  readonly onToggleFavorite: (model: string) => void;
  readonly onModelOrderChange: (next: ReadonlyArray<string>) => void;
}

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
  const [input, setInput] = useState("");
  const [isAdding, setIsAdding] = useState(false);
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [editingSlug, setEditingSlug] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const scrollToSlugRef = useRef<string | null>(null);
  const hiddenModelSet = new Set(hiddenModels);
  const favoriteModelSet = new Set(favoriteModels);
  const displayModels = groupModelsForDisplay(models, {
    favoriteModels: favoriteModelSet,
    hiddenModels: hiddenModelSet,
    modelOrder,
  });
  const favoriteCount = displayModels.filter((model) => favoriteModelSet.has(model.slug)).length;
  const hiddenCount = displayModels.filter(
    (model) => !model.isCustom && hiddenModelSet.has(model.slug),
  ).length;
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

  const handleAdd = () => {
    if (!canManageCustomModels || driverKind === "antigravity") return;
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
    if (!canManageCustomModels) return;
    if (editingSlug === slug) setEditingSlug(null);
    onChange(customModels.filter((entry) => entry.slug !== slug));
    onModelOrderChange(modelOrder.filter((model) => model !== slug));
    onFavoriteModelsChange(favoriteModels.filter((model) => model !== slug));
    setError(null);
  };

  const handleSaveEdit = (next: CustomModelDefinition) => {
    if (!canManageCustomModels) return;
    onChange(customModels.map((entry) => (entry.slug === next.slug ? next : entry)));
    setEditingSlug(null);
  };

  const setHidden = (slug: string, hidden: boolean) => {
    if (!canWritePreferences || hidden === hiddenModelSet.has(slug)) return;
    onHiddenModelsChange(
      hidden ? [...hiddenModels, slug] : hiddenModels.filter((model) => model !== slug),
      [slug],
    );
  };

  const handleToggleFavorite = (slug: string) => {
    if (!canWritePreferences) return;
    onToggleFavorite(slug);
  };

  const groupOf = (model: (typeof displayModels)[number]) =>
    favoriteModelSet.has(model.slug)
      ? "favorite"
      : !model.isCustom && hiddenModelSet.has(model.slug)
        ? "hidden"
        : "visible";
  const handleMove = (slug: string, direction: -1 | 1) => {
    if (!canWritePreferences) return;
    const index = displayModels.findIndex((model) => model.slug === slug);
    const nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || nextIndex >= displayModels.length) return;
    if (groupOf(displayModels[index]!) !== groupOf(displayModels[nextIndex]!)) return;
    const next = displayModels.map((model) => model.slug);
    [next[index], next[nextIndex]] = [next[nextIndex]!, next[index]!];
    onModelOrderChange(next);
  };

  const handleToggleEdit = useStableCallback((slug: string) => {
    if (!canManageCustomModels) return;
    setEditingSlug((current) => (current === slug ? null : slug));
  });
  const rowHandlers = {
    onToggleFavorite: useStableCallback(handleToggleFavorite),
    onMove: useStableCallback(handleMove),
    onSetHidden: useStableCallback(setHidden),
    onToggleEdit: handleToggleEdit,
    onRemove: useStableCallback(handleRemove),
  };

  const renderRow = (model: (typeof displayModels)[number]) => {
    const group = groupOf(model);
    const index = displayModels.indexOf(model);
    const previousModel = displayModels[index - 1];
    const nextModel = displayModels[index + 1];
    return (
      <ProviderModelRow
        key={`${instanceId}:${model.slug}`}
        model={model}
        isHidden={!model.isCustom && hiddenModelSet.has(model.slug)}
        isFavorite={group === "favorite"}
        canMoveUp={!isFiltering && previousModel !== undefined && groupOf(previousModel) === group}
        canMoveDown={!isFiltering && nextModel !== undefined && groupOf(nextModel) === group}
        isFiltering={isFiltering}
        canWritePreferences={canWritePreferences}
        canManageCustomModels={canManageCustomModels}
        {...rowHandlers}
      />
    );
  };

  const groupLabel = (label: string, isFirst: boolean) => (
    <div className={cn("px-2 pb-1.5 text-2xs text-muted-foreground", isFirst ? "pt-1" : "pt-5")}>
      {label}
    </div>
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
                onHiddenModelsChange(
                  nextHiddenModelsForBulkToggle(models, hiddenModels),
                  builtInModels.map((model) => model.slug),
                )
              }
            >
              {allBuiltInModelsHidden ? "Enable all" : "Disable all"}
            </Button>
          ) : null}
          <span className="text-xs text-muted-foreground">
            {models.length} model{models.length === 1 ? "" : "s"}
            {favoriteCount > 0
              ? ` · ${favoriteCount} favorite${favoriteCount === 1 ? "" : "s"}`
              : ""}
            {hiddenCount > 0 ? ` · ${hiddenCount} hidden` : ""}
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
            Add custom model
          </Button>
        ) : null}
      </div>
      <div
        ref={listRef}
        className="mt-2 -mx-2 max-h-64 overflow-y-auto lg:max-h-none lg:min-h-0 lg:flex-1"
      >
        {visibleModels.length === 0 ? (
          <p className="px-2 py-2 text-xs text-muted-foreground">
            {isFiltering ? "No models match." : "No models reported for this provider yet."}
          </p>
        ) : null}
        {visibleModels.map((model, index) => {
          const group = groupOf(model);
          const previous = visibleModels[index - 1];
          const startsGroup = previous === undefined || groupOf(previous) !== group;
          const editingEntry =
            canManageCustomModels && model.isCustom && editingSlug === model.slug
              ? customModels.find((entry) => entry.slug === model.slug)
              : undefined;
          return (
            <div key={`${instanceId}:${model.slug}:group`}>
              {startsGroup && favoriteCount > 0 && group === "favorite"
                ? groupLabel("Favorites", index === 0)
                : null}
              {startsGroup && favoriteCount > 0 && group === "visible"
                ? groupLabel("All", index === 0)
                : null}
              {startsGroup && group === "hidden"
                ? groupLabel("Hidden from picker", index === 0)
                : null}
              {renderRow(model)}
              {editingEntry ? (
                <CustomModelEditor
                  key={`${instanceId}:${model.slug}:editor`}
                  instanceId={instanceId}
                  driverKind={driverKind}
                  entry={editingEntry}
                  builtInModels={builtInModels}
                  onSave={handleSaveEdit}
                  onCancel={() => setEditingSlug(null)}
                />
              ) : null}
            </div>
          );
        })}
      </div>

      {driverKind === "antigravity" || !canManageCustomModels ? null : isAdding ? (
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

function ProviderModelRow({
  model,
  isHidden,
  isFavorite,
  canMoveUp,
  canMoveDown,
  isFiltering,
  canWritePreferences,
  canManageCustomModels,
  onToggleFavorite,
  onMove,
  onSetHidden,
  onToggleEdit,
  onRemove,
}: {
  readonly model: ServerProviderModel;
  readonly isHidden: boolean;
  readonly isFavorite: boolean;
  readonly canMoveUp: boolean;
  readonly canMoveDown: boolean;
  readonly isFiltering: boolean;
  readonly canWritePreferences: boolean;
  readonly canManageCustomModels: boolean;
  readonly onToggleFavorite: (slug: string) => void;
  readonly onMove: (slug: string, direction: -1 | 1) => void;
  readonly onSetHidden: (slug: string, hidden: boolean) => void;
  readonly onToggleEdit: (slug: string) => void;
  readonly onRemove: (slug: string) => void;
}) {
  const capLabels = describeModelCapabilities(model);
  const nameClassName = cn("text-xs", isHidden ? "text-muted-foreground" : "text-foreground/90");
  const pickerTooltip = model.isCustom
    ? "Custom models are always shown in the picker"
    : isHidden
      ? "Hidden from picker"
      : "Shown in picker";

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
          <span className="shrink-0 text-2xs text-muted-foreground/70">custom</span>
        ) : null}
      </span>
      <span className="text-2xs text-muted-foreground/70">
        {capLabels.length > 0 ? (
          <span className="hidden sm:inline">{capLabels.join(" · ")}</span>
        ) : null}
      </span>
      <span className="flex shrink-0 items-center justify-end gap-0.5">
        {!isHidden && !isFiltering ? (
          <>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-micro"
                    variant="ghost-muted"
                    disabled={!canWritePreferences || !canMoveUp}
                    onClick={() => onMove(model.slug, -1)}
                    aria-label={`Move ${model.name} up`}
                  />
                }
              >
                <ArrowUpIcon className="size-3" />
              </TooltipTrigger>
              <TooltipPopup side="top">Move up</TooltipPopup>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-micro"
                    variant="ghost-muted"
                    disabled={!canWritePreferences || !canMoveDown}
                    onClick={() => onMove(model.slug, 1)}
                    aria-label={`Move ${model.name} down`}
                  />
                }
              >
                <ArrowDownIcon className="size-3" />
              </TooltipTrigger>
              <TooltipPopup side="top">Move down</TooltipPopup>
            </Tooltip>
          </>
        ) : null}
        {model.isCustom ? (
          <>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-micro"
                    variant="ghost-muted"
                    disabled={!canManageCustomModels}
                    aria-label={`Edit ${model.slug}`}
                    onClick={() => onToggleEdit(model.slug)}
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
                    disabled={!canManageCustomModels}
                    aria-label={`Remove ${model.slug}`}
                    onClick={() => onRemove(model.slug)}
                  />
                }
              >
                <XIcon className="size-3" />
              </TooltipTrigger>
              <TooltipPopup side="top">Remove custom model</TooltipPopup>
            </Tooltip>
          </>
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
            aria-label={`Show ${model.name} in the model picker`}
          />
        </TooltipTrigger>
        <TooltipPopup side="top">{pickerTooltip}</TooltipPopup>
      </Tooltip>
    </div>
  );
}
