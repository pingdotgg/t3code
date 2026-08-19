import type {
  PluginMarketplaceDetail,
  PluginMarketplaceHarnessId,
  PluginMarketplaceHarnessSupport,
  PluginMarketplacePlugin,
} from "@t3tools/contracts";

export const MARKETPLACE_HARNESSES = ["codex", "claude", "cursor"] as const;

export type MarketplaceHarnessId = PluginMarketplaceHarnessId;
export type MarketplaceHarnessSupport = PluginMarketplaceHarnessSupport;
export type MarketplacePlugin = PluginMarketplacePlugin;
export type MarketplacePluginKind = "mcp" | "skill" | "app";

export const MARKETPLACE_HARNESS_LABELS: Readonly<Record<MarketplaceHarnessId, string>> = {
  codex: "Codex",
  claude: "Claude",
  cursor: "Cursor",
};

export function marketplaceListingGroupKey(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLocaleLowerCase()
    .replace(/\s+/gu, " ")
    .trim();
}

const LISTING_HARNESS_RANK: Readonly<Record<MarketplaceHarnessId, number>> = {
  codex: 0,
  claude: 1,
  cursor: 2,
};

function listingHasArtwork(plugin: Pick<MarketplacePlugin, "hasLocalLogo" | "logoUrl">) {
  return plugin.hasLocalLogo || Boolean(plugin.logoUrl?.trim());
}

function compareMarketplaceListings(left: MarketplacePlugin, right: MarketplacePlugin): number {
  return (
    Number(right.installed) - Number(left.installed) ||
    Number(listingHasArtwork(right)) - Number(listingHasArtwork(left)) ||
    Number(right.installPolicy === "AVAILABLE") - Number(left.installPolicy === "AVAILABLE") ||
    Number(right.marketplaceName !== "ChatGPT Public") -
      Number(left.marketplaceName !== "ChatGPT Public") ||
    LISTING_HARNESS_RANK[left.sourceHarness] - LISTING_HARNESS_RANK[right.sourceHarness] ||
    left.id.localeCompare(right.id)
  );
}

export function mergeMarketplaceListings(
  plugins: ReadonlyArray<MarketplacePlugin>,
): MarketplacePlugin[] {
  const groups = new Map<string, MarketplacePlugin[]>();
  for (const plugin of plugins) {
    const key = marketplaceListingGroupKey(plugin.name);
    const group = groups.get(key) ?? [];
    group.push(plugin);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => {
    const primary = [...group].toSorted(compareMarketplaceListings)[0]!;
    const byHarness = new Map<MarketplaceHarnessId, MarketplaceHarnessSupport>();
    for (const plugin of group) {
      for (const entry of plugin.support) {
        const current = byHarness.get(entry.harness);
        byHarness.set(entry.harness, {
          harness: entry.harness,
          mcp: Boolean(current?.mcp || entry.mcp),
          skills: Boolean(current?.skills || entry.skills),
          apps: Boolean(current?.apps || entry.apps),
        });
      }
    }
    return {
      ...primary,
      installed: group.some((plugin) => plugin.installed),
      enabled: group.some((plugin) => plugin.enabled),
      support: [...byHarness.values()].toSorted(
        (left, right) => LISTING_HARNESS_RANK[left.harness] - LISTING_HARNESS_RANK[right.harness],
      ),
      contents: {
        skillCount: Math.max(0, ...group.map((plugin) => plugin.contents.skillCount)),
        mcpServerCount: Math.max(0, ...group.map((plugin) => plugin.contents.mcpServerCount)),
        appCount: Math.max(0, ...group.map((plugin) => plugin.contents.appCount)),
        commandCount: Math.max(0, ...group.map((plugin) => plugin.contents.commandCount)),
        agentCount: Math.max(0, ...group.map((plugin) => plugin.contents.agentCount)),
        ruleCount: Math.max(0, ...group.map((plugin) => plugin.contents.ruleCount)),
        hookCount: Math.max(0, ...group.map((plugin) => plugin.contents.hookCount)),
        hasHooks: group.some((plugin) => plugin.contents.hasHooks),
      },
    };
  });
}

export function marketplacePluginKinds(
  plugin: Pick<MarketplacePlugin, "contents">,
): ReadonlyArray<MarketplacePluginKind> {
  return [
    plugin.contents.mcpServerCount > 0 ? "mcp" : null,
    plugin.contents.skillCount > 0 ? "skill" : null,
    plugin.contents.appCount > 0 ? "app" : null,
  ].filter((kind): kind is MarketplacePluginKind => kind !== null);
}

const EXTENSION_INCLUDE_LABELS: Readonly<
  Record<PluginMarketplaceDetail["extensions"][number]["kind"], string>
> = {
  command: "Commands",
  agent: "Subagents",
  rule: "Rules",
  hook: "Hooks",
  lsp: "Language servers",
  monitor: "Monitors",
};

export function marketplacePluginIncludeLabels(
  plugin: Pick<PluginMarketplaceDetail, "contents" | "extensions">,
): ReadonlyArray<string> {
  const extensionKinds = [...new Set(plugin.extensions.map((extension) => extension.kind))];
  return [
    ...marketplacePluginKinds(plugin).map((kind) =>
      kind === "mcp" ? "MCP" : kind === "skill" ? "Skills" : "Apps",
    ),
    ...extensionKinds.map((kind) => EXTENSION_INCLUDE_LABELS[kind]),
    ...(plugin.contents.hasHooks && !extensionKinds.includes("hook") ? ["Hooks"] : []),
  ];
}
