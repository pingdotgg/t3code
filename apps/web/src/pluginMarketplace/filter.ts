import type { MarketplaceHarnessId, MarketplacePlugin, MarketplacePluginKind } from "./catalog";

export type MarketplaceKindFilter = "all" | "installed" | MarketplacePluginKind;
export type MarketplaceHarnessFilter = "all" | MarketplaceHarnessId;
export type MarketplaceCategoryFilter = "all" | string;

export interface MarketplaceFilters {
  readonly query: string;
  readonly kind: MarketplaceKindFilter;
  readonly harness: MarketplaceHarnessFilter;
  readonly category: MarketplaceCategoryFilter;
}

export function normalizeMarketplaceSearchText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLocaleLowerCase()
    .replace(/\s+/gu, " ")
    .trim();
}

export function filterMarketplacePlugins(
  plugins: ReadonlyArray<MarketplacePlugin>,
  filters: MarketplaceFilters,
): MarketplacePlugin[] {
  const query = normalizeMarketplaceSearchText(filters.query);

  return plugins.filter((plugin) => {
    if (filters.kind === "installed" && !plugin.installed) return false;
    if (filters.kind === "mcp" && plugin.contents.mcpServerCount === 0) return false;
    if (filters.kind === "skill" && plugin.contents.skillCount === 0) return false;
    if (filters.kind === "app" && plugin.contents.appCount === 0) return false;
    if (
      filters.harness !== "all" &&
      !plugin.support.some((support) => support.harness === filters.harness)
    ) {
      return false;
    }
    if (filters.category !== "all" && plugin.category !== filters.category) return false;
    if (query.length === 0) return true;

    const searchText = normalizeMarketplaceSearchText(
      [
        plugin.name,
        plugin.packageName,
        plugin.summary,
        plugin.developer,
        plugin.category,
        plugin.marketplaceName,
        ...plugin.support.map((support) => support.harness),
      ].join(" "),
    );

    return searchText.includes(query);
  });
}
