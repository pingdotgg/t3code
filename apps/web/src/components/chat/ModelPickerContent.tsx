import {
  type ProviderKind,
  PROVIDER_DISPLAY_NAMES,
  type ResolvedKeybindingsConfig,
  type ServerProvider,
} from "@t3tools/contracts";
import { resolveSelectableModel } from "@t3tools/shared/model";
import { memo, useMemo, useState, useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { SearchIcon } from "lucide-react";
import { ModelListRow } from "./ModelListRow";
import { ModelPickerSidebar } from "./ModelPickerSidebar";
import { isModelPickerNewModel } from "./modelPickerModelHighlights";
import { buildModelPickerSearchText, scoreModelPickerSearch } from "./modelPickerSearch";
import { Combobox, ComboboxEmpty, ComboboxInput, ComboboxList } from "../ui/combobox";
import { ModelEsque, PROVIDER_ICON_BY_PROVIDER } from "./providerIconUtils";
import {
  modelPickerJumpCommandForIndex,
  modelPickerJumpIndexFromCommand,
  resolveShortcutCommand,
  shortcutLabelForCommand,
} from "../../keybindings";
import { useSettings, useUpdateSettings } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";
import { TooltipProvider } from "../ui/tooltip";

type ModelPickerItem = {
  slug: string;
  name: string;
  shortName?: string;
  subProvider?: string;
  provider: ProviderKind;
};

const EMPTY_MODEL_JUMP_LABELS = new Map<string, string>();

export const ModelPickerContent = memo(function ModelPickerContent(props: {
  provider: ProviderKind;
  model: string;
  lockedProvider: ProviderKind | null;
  providers?: ReadonlyArray<ServerProvider>;
  keybindings?: ResolvedKeybindingsConfig;
  modelOptionsByProvider: Record<ProviderKind, ReadonlyArray<ModelEsque>>;
  terminalOpen: boolean;
  onRequestClose?: () => void;
  onProviderModelChange: (provider: ProviderKind, model: string) => void;
}) {
  const { keybindings: providedKeybindings, modelOptionsByProvider, onProviderModelChange } = props;
  const [searchQuery, setSearchQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const listRegionRef = useRef<HTMLDivElement>(null);
  const highlightedModelKeyRef = useRef<string | null>(null);
  const favorites = useSettings((s) => s.favorites ?? []);
  const [selectedProvider, setSelectedProvider] = useState<ProviderKind | "favorites">(() => {
    if (props.lockedProvider !== null) {
      return props.lockedProvider;
    }
    return favorites.length > 0 ? "favorites" : props.provider;
  });
  const keybindings = useMemo<ResolvedKeybindingsConfig>(
    () => providedKeybindings ?? [],
    [providedKeybindings],
  );
  const { updateSettings } = useUpdateSettings();

  const focusSearchInput = useCallback(() => {
    searchInputRef.current?.focus({ preventScroll: true });
  }, []);

  const handleSelectProvider = useCallback(
    (provider: ProviderKind | "favorites") => {
      setSelectedProvider(provider);
      window.requestAnimationFrame(() => {
        focusSearchInput();
      });
    },
    [focusSearchInput],
  );

  useLayoutEffect(() => {
    focusSearchInput();
    const frame = window.requestAnimationFrame(() => {
      focusSearchInput();
    });
    const timeout = window.setTimeout(() => {
      focusSearchInput();
    }, 0);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timeout);
    };
  }, [focusSearchInput]);

  // Create a Set for efficient lookup
  const favoritesSet = useMemo(() => {
    return new Set(favorites.map((fav) => `${fav.provider}:${fav.model}`));
  }, [favorites]);
  const favoriteOrder = useMemo(() => {
    return new Map(
      favorites.map((favorite, index) => [`${favorite.provider}:${favorite.model}`, index]),
    );
  }, [favorites]);

  const readyProviderSet = useMemo(() => {
    if (!props.providers || props.providers.length === 0) {
      return null;
    }
    return new Set(
      props.providers
        .filter((provider) => provider.status === "ready")
        .map((provider) => provider.provider),
    );
  }, [props.providers]);

  // Flatten models into a searchable array
  const flatModels = useMemo(() => {
    return Object.entries(props.modelOptionsByProvider).flatMap(([providerKind, models]) => {
      if (readyProviderSet && !readyProviderSet.has(providerKind as ProviderKind)) {
        return [];
      }
      return models.map((m) => ({
        slug: m.slug,
        name: m.name,
        ...(m.shortName ? { shortName: m.shortName } : {}),
        ...(m.subProvider ? { subProvider: m.subProvider } : {}),
        provider: providerKind as ProviderKind,
      })) satisfies Array<ModelPickerItem>;
    });
  }, [props.modelOptionsByProvider, readyProviderSet]);

  // Filter models based on search query and selected provider
  const filteredModels = useMemo(() => {
    let result = flatModels;

    // Apply tokenized fuzzy search across the combined provider/model search fields.
    if (searchQuery.trim()) {
      const rankedMatches = result
        .map((model) => ({
          model,
          score: scoreModelPickerSearch(
            {
              ...model,
              isFavorite: favoritesSet.has(`${model.provider}:${model.slug}`),
            },
            searchQuery,
          ),
          isFavorite: favoritesSet.has(`${model.provider}:${model.slug}`),
          tieBreaker: buildModelPickerSearchText(model),
        }))
        .filter(
          (
            rankedModel,
          ): rankedModel is {
            model: ModelPickerItem;
            score: number;
            isFavorite: boolean;
            tieBreaker: string;
          } => rankedModel.score !== null,
        );

      // When searching, we only respect locked provider, ignoring sidebar selection
      if (props.lockedProvider !== null) {
        return rankedMatches
          .filter((rankedModel) => rankedModel.model.provider === props.lockedProvider)
          .toSorted((a, b) => {
            const scoreDelta = a.score - b.score;
            if (scoreDelta !== 0) {
              return scoreDelta;
            }
            if (a.isFavorite !== b.isFavorite) {
              return a.isFavorite ? -1 : 1;
            }
            return a.tieBreaker.localeCompare(b.tieBreaker);
          })
          .map((rankedModel) => rankedModel.model);
      }

      return rankedMatches
        .toSorted((a, b) => {
          const scoreDelta = a.score - b.score;
          if (scoreDelta !== 0) {
            return scoreDelta;
          }
          if (a.isFavorite !== b.isFavorite) {
            return a.isFavorite ? -1 : 1;
          }
          return a.tieBreaker.localeCompare(b.tieBreaker);
        })
        .map((rankedModel) => rankedModel.model);
    }

    // Locked provider mode always shows that provider's models, with favorites first.
    if (props.lockedProvider !== null) {
      result = result.filter((m) => m.provider === props.lockedProvider);
    } else if (selectedProvider === "favorites") {
      result = result.filter((m) => favoritesSet.has(`${m.provider}:${m.slug}`));
    } else {
      result = result.filter((m) => m.provider === selectedProvider);
    }

    return result.toSorted((a, b) => {
      const aOrder = favoriteOrder.get(`${a.provider}:${a.slug}`);
      const bOrder = favoriteOrder.get(`${b.provider}:${b.slug}`);

      if (aOrder !== undefined && bOrder !== undefined) {
        return aOrder - bOrder;
      }
      if (aOrder !== undefined) {
        return -1;
      }
      if (bOrder !== undefined) {
        return 1;
      }
      return 0;
    });
  }, [
    favoriteOrder,
    favoritesSet,
    flatModels,
    props.lockedProvider,
    searchQuery,
    selectedProvider,
  ]);

  const handleModelSelect = useCallback(
    (modelSlug: string, provider: ProviderKind) => {
      const resolvedModel = resolveSelectableModel(
        provider,
        modelSlug,
        modelOptionsByProvider[provider],
      );
      if (resolvedModel) {
        onProviderModelChange(provider, resolvedModel);
      }
    },
    [modelOptionsByProvider, onProviderModelChange],
  );

  const toggleFavorite = useCallback(
    (provider: ProviderKind, model: string) => {
      const newFavorites = [...favorites];
      const index = newFavorites.findIndex((f) => f.provider === provider && f.model === model);
      if (index >= 0) {
        newFavorites.splice(index, 1);
      } else {
        newFavorites.push({ provider, model });
      }
      updateSettings({ favorites: newFavorites });
    },
    [favorites, updateSettings],
  );

  const isLocked = props.lockedProvider !== null;
  const isSearching = searchQuery.trim().length > 0;
  const showSidebar = !isLocked && !isSearching;
  const LockedProviderIcon =
    isLocked && props.lockedProvider ? PROVIDER_ICON_BY_PROVIDER[props.lockedProvider] : null;
  const modelJumpCommandByKey = useMemo(() => {
    const mapping = new Map<
      string,
      NonNullable<ReturnType<typeof modelPickerJumpCommandForIndex>>
    >();
    for (const [visibleModelIndex, model] of filteredModels.entries()) {
      const jumpCommand = modelPickerJumpCommandForIndex(visibleModelIndex);
      if (!jumpCommand) {
        return mapping;
      }
      mapping.set(`${model.provider}:${model.slug}`, jumpCommand);
    }
    return mapping;
  }, [filteredModels]);
  const modelJumpModelKeys = useMemo(
    () => [...modelJumpCommandByKey.keys()],
    [modelJumpCommandByKey],
  );
  const allModelKeys = useMemo(
    (): string[] => flatModels.map((model) => `${model.provider}:${model.slug}`),
    [flatModels],
  );
  const filteredModelKeys = useMemo(
    (): string[] => filteredModels.map((model) => `${model.provider}:${model.slug}`),
    [filteredModels],
  );
  const filteredModelByKey = useMemo(
    (): ReadonlyMap<string, ModelPickerItem> =>
      new Map(filteredModels.map((model) => [`${model.provider}:${model.slug}`, model] as const)),
    [filteredModels],
  );
  const modelJumpShortcutContext = useMemo(
    () =>
      ({
        terminalFocus: false,
        terminalOpen: props.terminalOpen,
        modelPickerOpen: true,
      }) as const,
    [props.terminalOpen],
  );
  const modelJumpLabelByKey = useMemo((): ReadonlyMap<string, string> => {
    if (modelJumpCommandByKey.size === 0) {
      return EMPTY_MODEL_JUMP_LABELS;
    }
    const shortcutLabelOptions = {
      platform: navigator.platform,
      context: modelJumpShortcutContext,
    };
    const mapping = new Map<string, string>();
    for (const [modelKey, command] of modelJumpCommandByKey) {
      const label = shortcutLabelForCommand(keybindings, command, shortcutLabelOptions);
      if (label) {
        mapping.set(modelKey, label);
      }
    }
    return mapping.size > 0 ? mapping : EMPTY_MODEL_JUMP_LABELS;
  }, [keybindings, modelJumpCommandByKey, modelJumpShortcutContext]);

  useEffect(() => {
    const onWindowKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat) {
        return;
      }

      const command = resolveShortcutCommand(event, keybindings, {
        platform: navigator.platform,
        context: modelJumpShortcutContext,
      });
      const jumpIndex = modelPickerJumpIndexFromCommand(command ?? "");
      if (jumpIndex === null) {
        return;
      }

      const targetModelKey = modelJumpModelKeys[jumpIndex];
      if (!targetModelKey) {
        return;
      }
      const [provider, slug] = targetModelKey.split(":") as [ProviderKind, string];
      event.preventDefault();
      event.stopPropagation();
      handleModelSelect(slug, provider);
    };

    window.addEventListener("keydown", onWindowKeyDown, true);

    return () => {
      window.removeEventListener("keydown", onWindowKeyDown, true);
    };
  }, [handleModelSelect, keybindings, modelJumpModelKeys, modelJumpShortcutContext]);

  useLayoutEffect(() => {
    const listRegion = listRegionRef.current;
    if (!listRegion) {
      return;
    }

    let cancelled = false;
    let frame = 0;
    let nestedFrame = 0;
    let timeout = 0;

    const measureScrollArea = () => {
      if (cancelled) {
        return;
      }
      const viewport = listRegion.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]');
      if (!viewport || viewport.scrollHeight <= viewport.clientHeight) {
        return;
      }
      const originalScrollTop = viewport.scrollTop;
      const maxScrollTop = viewport.scrollHeight - viewport.clientHeight;
      if (maxScrollTop <= 0) {
        return;
      }
      viewport.scrollTop = Math.min(originalScrollTop + 1, maxScrollTop);
      viewport.scrollTop = originalScrollTop;
    };

    queueMicrotask(measureScrollArea);
    frame = window.requestAnimationFrame(() => {
      measureScrollArea();
      nestedFrame = window.requestAnimationFrame(measureScrollArea);
    });
    timeout = window.setTimeout(measureScrollArea, 0);

    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
      window.cancelAnimationFrame(nestedFrame);
      window.clearTimeout(timeout);
    };
  }, [filteredModelKeys]);

  return (
    <TooltipProvider delay={0}>
      <div
        className={cn(
          "relative flex h-screen max-h-96 w-screen max-w-100 overflow-hidden rounded-lg border bg-popover not-dark:bg-clip-padding text-popover-foreground shadow-lg/5 before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-lg)-1px)] before:shadow-[0_1px_--theme(--color-black/4%)] dark:before:shadow-[0_-1px_--theme(--color-white/6%)]",
          isLocked ? "flex-col" : "flex-row",
        )}
      >
        {/* Locked provider header (only shown in locked mode) */}
        {isLocked && LockedProviderIcon && props.lockedProvider && (
          <div className="flex items-center gap-2 px-4 py-3 border-b">
            <LockedProviderIcon className="size-5 shrink-0" />
            <span className="font-medium text-sm">
              {PROVIDER_DISPLAY_NAMES[props.lockedProvider]}
            </span>
          </div>
        )}

        {/* Sidebar (only in unlocked mode) */}
        {showSidebar && (
          <ModelPickerSidebar
            selectedProvider={selectedProvider}
            onSelectProvider={handleSelectProvider}
            {...(props.providers && { providers: props.providers })}
          />
        )}

        {/* Main content area */}
        <Combobox
          inline
          items={allModelKeys}
          filteredItems={filteredModelKeys}
          filter={null}
          autoHighlight
          open
          value={`${props.provider}:${props.model}`}
          onItemHighlighted={(modelKey) => {
            highlightedModelKeyRef.current = typeof modelKey === "string" ? modelKey : null;
          }}
          onValueChange={(modelKey) => {
            if (typeof modelKey !== "string") {
              return;
            }
            const [provider, slug] = modelKey.split(":") as [ProviderKind, string];
            handleModelSelect(slug, provider);
          }}
        >
          <div
            className={cn(
              "flex min-h-0 flex-1 flex-col overflow-hidden",
              isLocked ? "min-w-0" : showSidebar && "border-l",
            )}
          >
            {/* Search bar */}
            <div className="border-b px-3 py-2">
              <ComboboxInput
                ref={searchInputRef}
                className="[&_input]:font-sans rounded-md"
                inputClassName="border-0 shadow-none ring-0 focus-visible:ring-0"
                placeholder="Search models..."
                showTrigger={false}
                startAddon={<SearchIcon className="size-4 shrink-0 text-muted-foreground/50" />}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.preventDefault();
                    e.stopPropagation();
                    props.onRequestClose?.();
                    return;
                  }
                  if (e.key === "Enter" && highlightedModelKeyRef.current) {
                    (
                      e as typeof e & { preventBaseUIHandler?: () => void }
                    ).preventBaseUIHandler?.();
                    e.preventDefault();
                    e.stopPropagation();
                    const [provider, slug] = highlightedModelKeyRef.current.split(":") as [
                      ProviderKind,
                      string,
                    ];
                    handleModelSelect(slug, provider);
                    return;
                  }
                  e.stopPropagation();
                }}
                onMouseDown={(e) => e.stopPropagation()}
                onTouchStart={(e) => e.stopPropagation()}
                size="sm"
              />
            </div>

            {/* Model list */}
            <div
              ref={listRegionRef}
              className="relative min-h-0 flex-1 before:pointer-events-none before:absolute before:inset-0 before:bg-muted/40"
            >
              <ComboboxList className="model-picker-list size-full divide-y px-2 py-1">
                {filteredModelKeys.map((modelKey, index) => {
                  const model = filteredModelByKey.get(modelKey);
                  if (!model) {
                    return null;
                  }
                  return (
                    <ModelListRow
                      key={modelKey}
                      index={index}
                      model={model}
                      provider={model.provider}
                      isFavorite={favoritesSet.has(modelKey)}
                      showProvider={!isLocked}
                      preferShortName={!isLocked}
                      useTriggerLabel={isLocked}
                      showNewBadge={isModelPickerNewModel(model.provider, model.slug)}
                      jumpLabel={modelJumpLabelByKey.get(modelKey) ?? null}
                      onToggleFavorite={() => toggleFavorite(model.provider, model.slug)}
                    />
                  );
                })}
              </ComboboxList>
            </div>
            <ComboboxEmpty className="not-empty:py-6 empty:h-0 text-xs font-normal leading-snug">
              No models found
            </ComboboxEmpty>
          </div>
        </Combobox>
      </div>
    </TooltipProvider>
  );
});
