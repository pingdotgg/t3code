import { Link } from "@tanstack/react-router";
import {
  CheckIcon,
  ChevronRightIcon,
  FilterIcon,
  LayersIcon,
  PackageOpenIcon,
  RefreshCwIcon,
  SearchIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Button } from "~/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "~/components/ui/empty";
import { InputGroup, InputGroupAddon, InputGroupInput } from "~/components/ui/input-group";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "~/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Skeleton } from "~/components/ui/skeleton";
import { cn } from "~/lib/utils";
import {
  MARKETPLACE_HARNESSES,
  MARKETPLACE_HARNESS_LABELS,
  mergeMarketplaceListings,
  type MarketplacePlugin,
} from "~/pluginMarketplace/catalog";
import {
  filterMarketplacePlugins,
  type MarketplaceCategoryFilter,
  type MarketplaceHarnessFilter,
  type MarketplaceKindFilter,
} from "~/pluginMarketplace/filter";
import { usePluginMarketplaceStore } from "~/pluginMarketplace/store";
import { searchableSetting } from "../settingsSearch";
import { SettingsPageContainer, SettingsSection } from "../settingsLayout";
import { HarnessIcon, HarnessSupportBadges, PluginLogo } from "./PluginMarketplacePresentation";

const KIND_FILTERS: ReadonlyArray<{
  readonly label: string;
  readonly value: MarketplaceKindFilter;
}> = [
  { label: "All", value: "all" },
  { label: "Installed", value: "installed" },
  { label: "MCP", value: "mcp" },
  { label: "Skills", value: "skill" },
  { label: "Apps", value: "app" },
];

function HarnessFilterOption({ harness }: { readonly harness: MarketplaceHarnessFilter }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      {harness === "all" ? (
        <LayersIcon className="size-3.5 shrink-0 text-muted-foreground" />
      ) : (
        <HarnessIcon harness={harness} className="size-3.5" />
      )}
      <span className="truncate">
        {harness === "all" ? "All harnesses" : MARKETPLACE_HARNESS_LABELS[harness]}
      </span>
    </span>
  );
}

function MarketplacePluginCard({
  plugin,
  featured = false,
}: {
  readonly plugin: MarketplacePlugin;
  readonly featured?: boolean;
}) {
  return (
    <article className="min-w-0">
      <Link
        to="/settings/plugins/$pluginId"
        params={{ pluginId: plugin.id }}
        aria-label={`${plugin.installed ? "Manage" : "View"} ${plugin.name}`}
        className={cn(
          "group flex min-w-0 items-center gap-3 rounded-xl border border-foreground/8 bg-card/24 p-3 outline-none transition-colors hover:bg-foreground/4 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background dark:bg-card/40",
          featured && "sm:p-4",
        )}
      >
        <PluginLogo plugin={plugin} size="small" />
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex min-w-0 items-center gap-2">
            <h3 className="truncate font-medium text-base text-foreground sm:text-sm">
              {plugin.name}
            </h3>
            {plugin.installed ? (
              <span className="flex shrink-0 items-center gap-1 text-success-foreground text-xs">
                <CheckIcon className="size-3.5" />
                Installed
              </span>
            ) : null}
          </div>
          <p className="truncate text-base/7 text-muted-foreground sm:text-sm/5">
            {plugin.summary}
          </p>
          <HarnessSupportBadges support={plugin.support} />
        </div>
        <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
      </Link>
    </article>
  );
}

function LoadingMarketplace() {
  return (
    <div className="grid gap-3 lg:grid-cols-2" role="status" aria-label="Loading plugins">
      {Array.from({ length: 8 }, (_, index) => (
        <div
          key={index}
          className="flex items-start gap-3 rounded-xl border border-foreground/8 p-4"
        >
          <Skeleton className="size-10 shrink-0 rounded-xl" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-20" />
          </div>
        </div>
      ))}
    </div>
  );
}

function MarketplaceResults({
  plugins,
  filtered,
  onSelectCategory,
}: {
  readonly plugins: ReadonlyArray<MarketplacePlugin>;
  readonly filtered: boolean;
  readonly onSelectCategory: (category: string) => void;
}) {
  if (plugins.length === 0) {
    return (
      <Empty className="min-h-64 border border-dashed border-foreground/10">
        <EmptyMedia variant="icon">
          <PackageOpenIcon />
        </EmptyMedia>
        <EmptyHeader>
          <EmptyTitle>No plugins found</EmptyTitle>
          <EmptyDescription>Try a different search, harness, or category.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  if (filtered) {
    return (
      <section className="space-y-2" aria-labelledby="marketplace-results-title">
        <div className="flex items-baseline justify-between gap-3">
          <h2 id="marketplace-results-title" className="font-semibold text-lg text-foreground">
            Results
          </h2>
          <p className="tabular-nums text-base text-muted-foreground sm:text-sm">
            {plugins.length} {plugins.length === 1 ? "plugin" : "plugins"}
          </p>
        </div>
        <div className="grid gap-3 lg:grid-cols-2">
          {plugins.map((plugin) => (
            <MarketplacePluginCard key={plugin.id} plugin={plugin} />
          ))}
        </div>
      </section>
    );
  }

  const discover = plugins.filter((plugin) => !plugin.installed).slice(0, 4);
  const discoverIds = new Set(discover.map((plugin) => plugin.id));
  const categories = [...new Set(plugins.map((plugin) => plugin.category))].toSorted();
  const sections = categories
    .map((category) => ({
      category,
      plugins: plugins.filter(
        (plugin) => plugin.category === category && !discoverIds.has(plugin.id),
      ),
    }))
    .filter((section) => section.plugins.length > 0);

  return (
    <div className="flex flex-col gap-10">
      {discover.length > 0 ? (
        <section className="space-y-2" aria-labelledby="discover-plugins-title">
          <h2 id="discover-plugins-title" className="font-semibold text-lg text-foreground">
            Discover
          </h2>
          <div className="grid gap-3 lg:grid-cols-2">
            {discover.map((plugin) => (
              <MarketplacePluginCard key={plugin.id} plugin={plugin} featured />
            ))}
          </div>
        </section>
      ) : null}
      {sections.map((section) => {
        const headingId = `marketplace-category-${section.category.replaceAll(" ", "-")}`;
        return (
          <section key={section.category} className="space-y-2" aria-labelledby={headingId}>
            <h2 id={headingId} className="font-semibold text-lg text-foreground">
              {section.category}
            </h2>
            <div className="grid gap-3 lg:grid-cols-2">
              {section.plugins.slice(0, 6).map((plugin) => (
                <MarketplacePluginCard key={plugin.id} plugin={plugin} />
              ))}
            </div>
            {section.plugins.length > 6 ? (
              <Button
                size="sm"
                variant="ghost-muted"
                onClick={() => onSelectCategory(section.category)}
              >
                Show {section.plugins.length - 6} more
              </Button>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}

export function PluginMarketplace() {
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<MarketplaceKindFilter>("all");
  const [harness, setHarness] = useState<MarketplaceHarnessFilter>("all");
  const [category, setCategory] = useState<MarketplaceCategoryFilter>("all");
  const plugins = usePluginMarketplaceStore((state) => state.plugins);
  const searchHits = usePluginMarketplaceStore((state) => state.searchHits);
  const status = usePluginMarketplaceStore((state) => state.catalogStatus);
  const error = usePluginMarketplaceStore((state) => state.catalogError);
  const loadCatalog = usePluginMarketplaceStore((state) => state.loadCatalog);
  const searchCatalog = usePluginMarketplaceStore((state) => state.searchCatalog);

  useEffect(() => {
    void loadCatalog(true).catch(() => undefined);
  }, [loadCatalog]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void searchCatalog(query).catch(() => undefined);
    }, 250);
    return () => window.clearTimeout(timeout);
  }, [query, searchCatalog]);

  const catalogPlugins = useMemo(() => {
    if (searchHits.length === 0) return mergeMarketplaceListings(plugins);
    const knownIds = new Set(plugins.map((plugin) => plugin.id));
    return mergeMarketplaceListings([
      ...plugins,
      ...searchHits.filter((plugin) => !knownIds.has(plugin.id)),
    ]);
  }, [plugins, searchHits]);
  const categories = useMemo(
    () => [...new Set(catalogPlugins.map((plugin) => plugin.category))].toSorted(),
    [catalogPlugins],
  );
  const filteredPlugins = useMemo(
    () => filterMarketplacePlugins(catalogPlugins, { query, kind, harness, category }),
    [catalogPlugins, category, harness, kind, query],
  );
  const isFiltered =
    query.trim().length > 0 || kind !== "all" || harness !== "all" || category !== "all";
  const activeFilterCount =
    Number(kind !== "all") + Number(harness !== "all") + Number(category !== "all");
  const resetFilters = () => {
    setKind("all");
    setHarness("all");
    setCategory("all");
  };

  return (
    <SettingsPageContainer className="max-w-5xl gap-10">
      <header className="space-y-5 px-1 sm:px-0">
        <div className="space-y-1">
          <h1 className="text-balance font-semibold text-3xl tracking-tight text-foreground">
            Plugins
          </h1>
          <p className="max-w-[68ch] text-pretty text-base/7 text-muted-foreground sm:text-sm/6">
            Discover real Codex, Claude Code, and Cursor plugins, including their MCP servers and
            skills, in one place.
          </p>
        </div>
        <div className="flex min-w-0 items-center gap-2">
          <InputGroup className="min-w-0 flex-1">
            <InputGroupAddon>
              <SearchIcon />
            </InputGroupAddon>
            <InputGroupInput
              type="search"
              name="plugin-search"
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              placeholder="Search plugins"
              aria-label="Search plugins"
              size="lg"
            />
          </InputGroup>
          <Popover>
            <PopoverTrigger
              render={
                <Button
                  size="icon-lg"
                  variant={activeFilterCount > 0 ? "secondary" : "outline"}
                  aria-label={
                    activeFilterCount > 0
                      ? `Filters, ${activeFilterCount} active`
                      : "Filter plugins"
                  }
                />
              }
            >
              <FilterIcon />
            </PopoverTrigger>
            <PopoverPopup
              align="end"
              side="bottom"
              sideOffset={8}
              className="w-72 max-w-[calc(100vw-2rem)]"
              viewportClassName="p-3"
            >
              <div className="flex flex-col gap-3">
                <div className="flex min-w-0 items-center justify-between gap-3">
                  <PopoverTitle className="text-base sm:text-sm">Filters</PopoverTitle>
                  {activeFilterCount > 0 ? (
                    <Button size="xs" variant="ghost-muted" onClick={resetFilters}>
                      Reset
                    </Button>
                  ) : null}
                </div>
                <div className="flex flex-col gap-1.5">
                  <p className="font-medium text-base text-foreground sm:text-sm">Type</p>
                  <Select
                    value={kind}
                    onValueChange={(value) => value && setKind(value as MarketplaceKindFilter)}
                  >
                    <SelectTrigger size="sm" aria-label="Filter by plugin type">
                      <SelectValue>
                        {KIND_FILTERS.find((option) => option.value === kind)?.label ?? "All"}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {KIND_FILTERS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <p className="font-medium text-base text-foreground sm:text-sm">Harness</p>
                  <Select
                    value={harness}
                    onValueChange={(value) =>
                      value && setHarness(value as MarketplaceHarnessFilter)
                    }
                  >
                    <SelectTrigger size="sm" aria-label="Filter by harness">
                      <SelectValue>
                        <HarnessFilterOption harness={harness} />
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">
                        <HarnessFilterOption harness="all" />
                      </SelectItem>
                      {MARKETPLACE_HARNESSES.map((harnessId) => (
                        <SelectItem key={harnessId} value={harnessId}>
                          <HarnessFilterOption harness={harnessId} />
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <p className="font-medium text-base text-foreground sm:text-sm">Category</p>
                  <Select value={category} onValueChange={(value) => value && setCategory(value)}>
                    <SelectTrigger size="sm" aria-label="Filter by category">
                      <SelectValue>{category === "all" ? "All categories" : category}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All categories</SelectItem>
                      {categories.map((categoryValue) => (
                        <SelectItem key={categoryValue} value={categoryValue}>
                          {categoryValue}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </PopoverPopup>
          </Popover>
        </div>
      </header>

      <SettingsSection
        {...searchableSetting("plugin-marketplace")}
        className="space-y-0"
        contentClassName="space-y-10"
        hideHeader
      >
        {status === "idle" || status === "loading" ? <LoadingMarketplace /> : null}
        {status === "error" ? (
          <Empty className="min-h-64 border border-dashed border-foreground/10">
            <EmptyMedia variant="icon">
              <PackageOpenIcon />
            </EmptyMedia>
            <EmptyHeader>
              <EmptyTitle>Plugin marketplaces are unavailable</EmptyTitle>
              <EmptyDescription>{error}</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void loadCatalog(true).catch(() => undefined)}
              >
                <RefreshCwIcon />
                Try again
              </Button>
            </EmptyContent>
          </Empty>
        ) : null}
        {status === "ready" ? (
          <>
            {error ? (
              <p
                className="rounded-lg border border-warning/32 bg-warning-surface px-3 py-2 text-warning-foreground text-sm"
                role="alert"
              >
                Showing cached plugin data because the latest refresh failed: {error}
              </p>
            ) : null}
            <MarketplaceResults
              plugins={filteredPlugins}
              filtered={isFiltered}
              onSelectCategory={setCategory}
            />
          </>
        ) : null}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
