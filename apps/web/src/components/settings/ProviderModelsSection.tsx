"use client";

import { ArrowDownIcon, ArrowUpIcon, PlusIcon, StarIcon, XIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ProviderDriverKind,
  type ProviderInstanceId,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { normalizeCustomModelSlug } from "@t3tools/shared/model";

import { cn } from "../../lib/utils";
import { sortModelsForProviderInstance } from "../../modelOrdering";
import { MAX_CUSTOM_MODEL_LENGTH } from "../../modelSelection";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

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
 * top-down as "what the picker shows"; moves only swap rows within the same
 * group, and the resulting display order is what gets persisted as
 * `modelOrder`.
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
   * The persisted custom-model slug list for this instance. Drives dedup,
   * and is the array we hand back verbatim (with the new slug appended /
   * removed) via `onChange`.
   */
  readonly customModels: ReadonlyArray<string>;
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
  readonly onChange: (next: ReadonlyArray<string>) => void;
  readonly onHiddenModelsChange: (next: ReadonlyArray<string>) => void;
  readonly onFavoriteModelsChange: (next: ReadonlyArray<string>) => void;
  readonly onModelOrderChange: (next: ReadonlyArray<string>) => void;
}

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
  onHiddenModelsChange,
  onFavoriteModelsChange,
  onModelOrderChange,
}: ProviderModelsSectionProps) {
  const [input, setInput] = useState("");
  const [isAdding, setIsAdding] = useState(false);
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // Slug of a just-added custom model, scrolled into view once its row exists.
  const scrollToSlugRef = useRef<string | null>(null);
  const hiddenModelSet = useMemo(() => new Set(hiddenModels), [hiddenModels]);
  const favoriteModelSet = useMemo(() => new Set(favoriteModels), [favoriteModels]);
  const displayModels = useMemo(
    () =>
      groupModelsForDisplay(models, {
        favoriteModels: favoriteModelSet,
        hiddenModels: hiddenModelSet,
        modelOrder,
      }),
    [favoriteModelSet, hiddenModelSet, modelOrder, models],
  );
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
    if (customModels.includes(normalized)) {
      setError("That custom model is already saved.");
      return;
    }

    // Clear the filter so the new row renders even when it does not match,
    // which is also what lets the pending scroll target resolve and clear.
    scrollToSlugRef.current = normalized;
    setFilter("");
    onChange([...customModels, normalized]);
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
    onChange(customModels.filter((model) => model !== slug));
    onModelOrderChange(modelOrder.filter((model) => model !== slug));
    onFavoriteModelsChange(favoriteModels.filter((model) => model !== slug));
    setError(null);
  };

  const setHidden = (slug: string, hidden: boolean) => {
    if (hidden === hiddenModelSet.has(slug)) return;
    onHiddenModelsChange(
      hidden ? [...hiddenModels, slug] : hiddenModels.filter((model) => model !== slug),
    );
  };

  const handleToggleFavorite = (slug: string) => {
    if (favoriteModelSet.has(slug)) {
      onFavoriteModelsChange(favoriteModels.filter((model) => model !== slug));
      return;
    }
    onFavoriteModelsChange([...favoriteModels, slug]);
  };

  // Rows only trade places with a neighbour in the same group (favorites,
  // visible, hidden), and the display order is persisted as the new order.
  const groupOf = (model: (typeof displayModels)[number]) =>
    favoriteModelSet.has(model.slug)
      ? "favorite"
      : !model.isCustom && hiddenModelSet.has(model.slug)
        ? "hidden"
        : "visible";
  const handleMove = (slug: string, direction: -1 | 1) => {
    const index = displayModels.findIndex((model) => model.slug === slug);
    const nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || nextIndex >= displayModels.length) return;
    if (groupOf(displayModels[index]!) !== groupOf(displayModels[nextIndex]!)) return;
    const next = displayModels.map((model) => model.slug);
    [next[index], next[nextIndex]] = [next[nextIndex]!, next[index]!];
    onModelOrderChange(next);
  };

  type DisplayModel = (typeof displayModels)[number];

  const starButton = (model: DisplayModel, isFavorite: boolean) => (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-micro"
            variant="ghost"
            className={cn(
              "[--control-icon-color:currentColor]",
              isFavorite
                ? "text-yellow-500 hover:text-yellow-600"
                : "text-muted-foreground/40 hover:text-muted-foreground",
            )}
            onClick={() => handleToggleFavorite(model.slug)}
            aria-label={`${isFavorite ? "Remove" : "Add"} ${model.name} ${
              isFavorite ? "from" : "to"
            } favorites`}
          />
        }
      >
        <StarIcon className={cn("size-3", isFavorite && "fill-current")} />
      </TooltipTrigger>
      <TooltipPopup side="top">
        {isFavorite ? "Remove from favorites" : "Add to favorites"}
      </TooltipPopup>
    </Tooltip>
  );

  // Reorder and remove stay in the row at all times (dimmed when unavailable)
  // so ordering is discoverable without hovering.
  const rowActions = (
    model: DisplayModel,
    options: {
      readonly isHidden: boolean;
      readonly canMoveUp: boolean;
      readonly canMoveDown: boolean;
    },
  ) => (
    <span className="flex shrink-0 items-center justify-end gap-0.5">
      {!options.isHidden && !isFiltering ? (
        <>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-micro"
                  variant="ghost-muted"
                  disabled={!options.canMoveUp}
                  onClick={() => handleMove(model.slug, -1)}
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
                  disabled={!options.canMoveDown}
                  onClick={() => handleMove(model.slug, 1)}
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
      ) : null}
    </span>
  );

  const pickerTooltip = (model: DisplayModel, isHidden: boolean) =>
    model.isCustom
      ? "Custom models are always shown in the picker"
      : isHidden
        ? "Hidden from picker"
        : "Shown in picker";

  // The trigger is a wrapper span: a disabled switch gets no pointer events,
  // so it could not open the tooltip itself.
  const pickerSwitch = (model: DisplayModel, isHidden: boolean) => (
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
      <TooltipPopup side="top">{pickerTooltip(model, isHidden)}</TooltipPopup>
    </Tooltip>
  );

  const renderRow = (model: DisplayModel) => {
    const capLabels = describeModelCapabilities(model);
    const group = groupOf(model);
    // Hidden is read from the preference itself: a favorited model can still be
    // hidden, and its switch must say so even though it sits in the favorites group.
    const isHidden = !model.isCustom && hiddenModelSet.has(model.slug);
    const isFavorite = group === "favorite";
    const index = displayModels.indexOf(model);
    const previousModel = displayModels[index - 1];
    const nextModel = displayModels[index + 1];
    // Reordering a filtered view would be ambiguous, so arrows only show on
    // the full list.
    const canMoveUp =
      !isFiltering && previousModel !== undefined && groupOf(previousModel) === group;
    const canMoveDown = !isFiltering && nextModel !== undefined && groupOf(nextModel) === group;
    const nameClassName = cn("text-xs", isHidden ? "text-muted-foreground" : "text-foreground/90");

    return (
      <div
        key={`${instanceId}:${model.slug}`}
        data-model-slug={model.slug}
        className={cn(
          "grid h-7 grid-cols-[1.5rem_minmax(0,1fr)_auto_4rem_auto] items-center gap-2 rounded-md px-2 transition-colors hover:bg-muted/30",
          isHidden && "opacity-50",
        )}
      >
        {starButton(model, isFavorite)}
        <span className="flex min-w-0 items-baseline gap-2">
          <span className={cn(nameClassName, "truncate")}>{model.name}</span>
          {model.isCustom ? (
            <span className="text-[11px] text-muted-foreground/70">custom</span>
          ) : model.name !== model.slug ? (
            <code className="truncate font-mono text-[11px] text-muted-foreground/70">
              {model.slug}
            </code>
          ) : null}
        </span>
        {/*
          Always a grid item so the columns line up across rows; the text
          itself drops out on phone widths where it would starve the name.
        */}
        <span className="text-[11px] text-muted-foreground/70">
          {capLabels.length > 0 ? (
            <span className="hidden sm:inline">{capLabels.join(" · ")}</span>
          ) : null}
        </span>
        {rowActions(model, { isHidden, canMoveUp, canMoveDown })}
        {pickerSwitch(model, isHidden)}
      </div>
    );
  };

  const groupLabel = (label: string, isFirst: boolean) => (
    <div className={cn("px-2 pb-1.5 text-[11px] text-muted-foreground", isFirst ? "pt-1" : "pt-5")}>
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
            className="w-56"
            spellCheck={false}
            aria-label="Filter models"
          />
        ) : null}
        <span className="text-xs text-muted-foreground">
          {models.length} model{models.length === 1 ? "" : "s"}
          {favoriteCount > 0 ? ` · ${favoriteCount} favorite${favoriteCount === 1 ? "" : "s"}` : ""}
          {hiddenCount > 0 ? ` · ${hiddenCount} hidden` : ""}
        </span>
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
            </div>
          );
        })}
      </div>

      {isAdding ? (
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
      ) : (
        <Button
          type="button"
          size="xs"
          variant="ghost-muted"
          className="mt-2 -ml-2"
          onClick={() => setIsAdding(true)}
        >
          <PlusIcon className="size-3" />
          Add custom model
        </Button>
      )}

      {error ? <p className="mt-2 text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
