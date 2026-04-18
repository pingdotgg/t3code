import { type ProviderKind, type ServerProvider } from "@t3tools/contracts";
import { resolveSelectableModel } from "@t3tools/shared/model";
import { memo, useMemo, useState, useCallback } from "react";
import { SearchIcon } from "lucide-react";
import { ModelListRow } from "./ModelListRow";
import { ModelPickerSidebar } from "./ModelPickerSidebar";
import {
  PROVIDER_ICON_BY_PROVIDER,
  providerIconClassName,
  getProviderLabel,
} from "./providerIconUtils";
import { useSettings, useUpdateSettings } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";

export const ModelPickerContent = memo(function ModelPickerContent(props: {
  provider: ProviderKind;
  model: string;
  lockedProvider: ProviderKind | null;
  providers?: ReadonlyArray<ServerProvider>;
  modelOptionsByProvider: Record<ProviderKind, ReadonlyArray<{ slug: string; name: string }>>;
  onProviderModelChange: (provider: ProviderKind, model: string) => void;
}) {
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedProvider, setSelectedProvider] = useState<ProviderKind | "all" | "favorites">(
    "all",
  );
  const favorites = useSettings((s) => s.favorites ?? []);
  const { updateSettings } = useUpdateSettings();

  const handleSelectProvider = useCallback((provider: ProviderKind | "all" | "favorites") => {
    setSelectedProvider(provider);
  }, []);

  // Create a Set for efficient lookup
  const favoritesSet = useMemo(() => {
    return new Set(favorites.map((fav) => `${fav.provider}:${fav.model}`));
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
        provider: providerKind as ProviderKind,
      }));
    });
  }, [props.modelOptionsByProvider, readyProviderSet]);

  // Get favorite models from the flat list
  const favoriteModels = useMemo(() => {
    return flatModels.filter((m) => favoritesSet.has(`${m.provider}:${m.slug}`));
  }, [flatModels, favoritesSet]);

  // Filter models based on search query and selected provider
  const filteredModels = useMemo(() => {
    let result = flatModels;

    // Handle favorites filter
    if (selectedProvider === "favorites") {
      result = result.filter((m) => favoritesSet.has(`${m.provider}:${m.slug}`));
    } else {
      // Filter by locked provider if applicable
      if (props.lockedProvider !== null) {
        result = result.filter((m) => m.provider === props.lockedProvider);
      } else if (selectedProvider !== "all") {
        // Filter by selected provider (only in unlocked mode)
        result = result.filter((m) => m.provider === selectedProvider);
      }
    }

    // Apply search query (model name + provider name)
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      result = result.filter(
        (m) => m.name.toLowerCase().includes(query) || m.provider.toLowerCase().includes(query),
      );
    }

    return result;
  }, [flatModels, searchQuery, selectedProvider, props.lockedProvider, favoritesSet]);

  // Get visible favorite models (respecting search/provider filter)
  const visibleFavoriteModels = useMemo(() => {
    if (!searchQuery.trim() && selectedProvider !== "all") {
      // No search and not in "all" mode: show favorites in dedicated section
      let result = favoriteModels;

      if (props.lockedProvider !== null) {
        result = result.filter((m) => m.provider === props.lockedProvider);
      } else if (selectedProvider !== "favorites") {
        result = result.filter((m) => m.provider === selectedProvider);
      }

      return result;
    }

    // With search or in "all" mode: don't show separate section
    return [];
  }, [favoriteModels, searchQuery, selectedProvider, props.lockedProvider]);

  const visibleFavoriteModelKeys = useMemo(() => {
    return new Set(visibleFavoriteModels.map((model) => `${model.provider}:${model.slug}`));
  }, [visibleFavoriteModels]);

  const allModelsSectionModels = useMemo(() => {
    if (visibleFavoriteModelKeys.size === 0) {
      return filteredModels;
    }
    return filteredModels.filter(
      (model) => !visibleFavoriteModelKeys.has(`${model.provider}:${model.slug}`),
    );
  }, [filteredModels, visibleFavoriteModelKeys]);

  const handleModelSelect = (modelSlug: string, provider: ProviderKind) => {
    const resolvedModel = resolveSelectableModel(
      provider,
      modelSlug,
      props.modelOptionsByProvider[provider],
    );
    if (resolvedModel) {
      props.onProviderModelChange(provider, resolvedModel);
    }
  };

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
  const LockedProviderIcon =
    isLocked && props.lockedProvider ? PROVIDER_ICON_BY_PROVIDER[props.lockedProvider] : null;

  // Get a model name from the locked provider to extract sub-provider info (for OpenCode)
  const lockedProviderModelName =
    isLocked && props.lockedProvider
      ? (props.modelOptionsByProvider[props.lockedProvider]?.[0]?.name ?? "")
      : "";

  return (
    <div
      className={cn(
        "flex h-screen max-h-96 w-screen max-w-100 bg-popover",
        isLocked ? "flex-col" : "flex-row",
      )}
    >
      {/* Locked provider header (only shown in locked mode) */}
      {isLocked && LockedProviderIcon && props.lockedProvider && (
        <div className="flex items-center gap-2 px-4 py-3 border-b">
          <LockedProviderIcon
            className={cn(
              "size-5 shrink-0",
              providerIconClassName(props.lockedProvider, "text-muted-foreground/85"),
            )}
          />
          <span className="font-medium text-sm">
            {getProviderLabel(props.lockedProvider, lockedProviderModelName)}
          </span>
        </div>
      )}

      {/* Sidebar (only in unlocked mode) */}
      {!isLocked && (
        <ModelPickerSidebar
          selectedProvider={selectedProvider}
          onSelectProvider={handleSelectProvider}
          {...(props.providers && { providers: props.providers })}
        />
      )}

      {/* Main content area */}
      <div className={cn("flex-1 flex flex-col", isLocked ? "min-w-0" : "border-l")}>
        {/* Search bar */}
        <div className="px-3 py-2 border-b flex items-center gap-2 relative z-20">
          <SearchIcon className="size-4 shrink-0 text-muted-foreground/50" />
          <input
            type="text"
            placeholder="Search models..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            onTouchStart={(e) => e.stopPropagation()}
            autoFocus
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/50 relative z-20"
          />
        </div>

        {/* Model list */}
        <div className="flex-1 overflow-y-auto model-picker-list">
          {visibleFavoriteModels.length > 0 || allModelsSectionModels.length > 0 ? (
            <div>
              {/* Favorites section with sticky header */}
              {visibleFavoriteModels.length > 0 && (
                <div>
                  <div className="px-3 py-2 text-xs font-semibold text-muted-foreground bg-popover sticky top-0 z-20">
                    FAVORITES
                  </div>
                  <div className="divide-y">
                    {visibleFavoriteModels.map((model) => (
                      <ModelListRow
                        key={`${model.provider}:${model.slug}`}
                        slug={model.slug}
                        name={model.name}
                        provider={model.provider}
                        isSelected={props.provider === model.provider && props.model === model.slug}
                        isFavorite={true}
                        showProvider={!isLocked}
                        onSelect={() => handleModelSelect(model.slug, model.provider)}
                        onToggleFavorite={() => toggleFavorite(model.provider, model.slug)}
                      />
                    ))}
                  </div>
                </div>
              )}

              {/* All models section - always shows with sticky header */}
              {allModelsSectionModels.length > 0 && (
                <div>
                  <div className="px-3 py-2 text-xs font-semibold text-muted-foreground bg-popover sticky top-0 z-20">
                    ALL MODELS
                  </div>
                  <div className="divide-y">
                    {allModelsSectionModels.map((model) => (
                      <ModelListRow
                        key={`${model.provider}:${model.slug}`}
                        slug={model.slug}
                        name={model.name}
                        provider={model.provider}
                        isSelected={props.provider === model.provider && props.model === model.slug}
                        isFavorite={favoritesSet.has(`${model.provider}:${model.slug}`)}
                        showProvider={!isLocked}
                        onSelect={() => handleModelSelect(model.slug, model.provider)}
                        onToggleFavorite={() => toggleFavorite(model.provider, model.slug)}
                      />
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
              No models found
            </div>
          )}
        </div>
      </div>
    </div>
  );
});
