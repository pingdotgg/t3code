import { ArrowDownIcon, ArrowUpIcon, PencilIcon, PlusIcon, StarIcon, XIcon } from "lucide-react";
import { msg, T, useGT, useMessages } from "gt-react";
import { memo, useEffect, useRef, useState } from "react";
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
    onModelOrderChange(modelOrder.filter((model) => model !== slug));
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

  const groupOf = (model: (typeof displayModels)[number]) =>
    favoriteModelSet.has(model.slug)
      ? "favorite"
      : !model.isCustom && placedHiddenSet.has(model.slug)
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
    editAttemptRef.current += 1;
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
        flagMissingReasoning={flagMissingReasoning}
        canWritePreferences={canWritePreferences}
        canManageCustomModels={canManageCustomModels}
        {...rowHandlers}
      />
    );
  };

  const groupLabel = (label: string, isFirst: boolean) => (
    <div className={cn("px-2 pb-1.5 text-2xs text-dim-foreground", isFirst ? "pt-1" : "pt-5")}>
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
                ? groupLabel(gt("Favorites"), index === 0)
                : null}
              {startsGroup && favoriteCount > 0 && group === "visible"
                ? groupLabel(gt("All", { $context: "group of all visible models" }), index === 0)
                : null}
              {startsGroup && group === "hidden"
                ? groupLabel(gt("Hidden from picker"), index === 0)
                : null}
              {renderRow(model)}
              {editingEntry ? (
                <CustomModelEditor
                  key={`${instanceId}:${model.slug}:editor`}
                  instanceId={instanceId}
                  driverKind={driverKind}
                  entry={editingEntry}
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
            <Button size="sm" variant="secondary" disabled={isSaving} onClick={handleAdd}>
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

const ProviderModelRow = memo(function ProviderModelRow({
  model,
  isHidden,
  isFavorite,
  canMoveUp,
  canMoveDown,
  isFiltering,
  flagMissingReasoning,
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
  readonly flagMissingReasoning: boolean;
  readonly canWritePreferences: boolean;
  readonly canManageCustomModels: boolean;
  readonly onToggleFavorite: (slug: string) => void;
  readonly onMove: (slug: string, direction: -1 | 1) => void;
  readonly onSetHidden: (slug: string, hidden: boolean) => void;
  readonly onToggleEdit: (slug: string) => void;
  readonly onRemove: (slug: string) => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const capLabels = describeModelCapabilities(model, flagMissingReasoning, m);
  const descriptor = [
    model.name !== model.slug ? model.slug : null,
    model.isCustom ? gt("custom", { $context: "badge, user-added model" }) : null,
    ...capLabels,
  ].filter((part) => part !== null);
  const nameClassName = cn("text-label", isHidden ? "text-muted-foreground" : "text-foreground");
  const pickerTooltip = model.isCustom
    ? gt("Custom models are always shown in the picker")
    : isHidden
      ? gt("Hidden from picker")
      : gt("Shown in picker");

  return (
    <div
      data-model-slug={model.slug}
      className={cn(
        "grid grid-cols-[1.5rem_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-0.5 rounded-row px-2 py-1 transition-colors hover:surface-ghost-hover sm:grid-cols-[1.5rem_minmax(0,1fr)_auto_auto] sm:gap-2",
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
          <StarIcon
            className={cn("size-3", isFavorite && "fill-current text-warning-foreground")}
          />
        </TooltipTrigger>
        <TooltipPopup side="top">
          {isFavorite ? gt("Remove from favorites") : gt("Add to favorites")}
        </TooltipPopup>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={<span tabIndex={0} className="col-span-2 flex min-w-0 flex-col sm:col-span-1" />}
        >
          <span className={cn(nameClassName, "max-sm:wrap-anywhere sm:truncate")}>
            {model.name}
          </span>
        </TooltipTrigger>
        <TooltipPopup side="top" align="start">
          <div>{model.name}</div>
          {descriptor.map((detail) => (
            <span key={detail} className="block">
              {detail}
            </span>
          ))}
        </TooltipPopup>
      </Tooltip>
      <span className="col-start-2 flex shrink-0 items-center justify-end gap-0.5 sm:col-start-auto">
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
                    aria-label={gt("Move {name} up", { name: model.name })}
                  />
                }
              >
                <ArrowUpIcon className="size-3" />
              </TooltipTrigger>
              <TooltipPopup side="top">
                <T>Move up</T>
              </TooltipPopup>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-micro"
                    variant="ghost-muted"
                    disabled={!canWritePreferences || !canMoveDown}
                    onClick={() => onMove(model.slug, 1)}
                    aria-label={gt("Move {name} down", { name: model.name })}
                  />
                }
              >
                <ArrowDownIcon className="size-3" />
              </TooltipTrigger>
              <TooltipPopup side="top">
                <T>Move down</T>
              </TooltipPopup>
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
