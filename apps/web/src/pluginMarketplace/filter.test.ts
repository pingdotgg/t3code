import type { PluginMarketplacePlugin } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { mergeMarketplaceListings } from "./catalog";
import { filterMarketplacePlugins } from "./filter";

function plugin(
  id: string,
  input: {
    readonly category: string;
    readonly summary: string;
    readonly mcp?: number;
    readonly skills?: number;
    readonly apps?: number;
    readonly harness?: "codex" | "claude";
    readonly installed?: boolean;
  },
): PluginMarketplacePlugin {
  const mcp = input.mcp ?? 0;
  const skills = input.skills ?? 0;
  const apps = input.apps ?? 0;
  return {
    id: `${id}@marketplace`,
    sourceHarness: input.harness ?? "codex",
    packageName: id,
    name: id.replaceAll("-", " "),
    summary: input.summary,
    developer: "OpenAI",
    category: input.category,
    version: "1.0.0",
    marketplaceName: "marketplace",
    marketplaceSourceType: "git",
    installPolicy: "AVAILABLE",
    authPolicy: "ON_INSTALL",
    installed: input.installed ?? false,
    enabled: input.installed ?? false,
    brandColor: null,
    hasLocalLogo: false,
    logoDataUrl: null,
    logoUrl: null,
    contents: {
      mcpServerCount: mcp,
      skillCount: skills,
      appCount: apps,
      commandCount: 0,
      agentCount: 0,
      ruleCount: 0,
      hookCount: 0,
      hasHooks: false,
    },
    support: [
      {
        harness: input.harness ?? "codex",
        mcp: mcp > 0,
        skills: skills > 0,
        apps: apps > 0,
      },
    ],
  };
}

const PLUGINS = [
  plugin("github", {
    category: "Developer tools",
    summary: "Review pull requests and manage repositories",
    mcp: 1,
    skills: 3,
  }),
  plugin("computer-use", {
    category: "Productivity",
    summary: "Control local Mac apps from Codex",
    mcp: 1,
    skills: 1,
    apps: 1,
    installed: true,
  }),
  plugin("design-tools", {
    category: "Design",
    summary: "Turn designs into code",
    skills: 2,
    harness: "claude",
  }),
];

const DEFAULT_FILTERS = {
  query: "",
  kind: "all",
  harness: "all",
  category: "all",
} as const;

describe("filterMarketplacePlugins", () => {
  it("searches live catalog metadata", () => {
    expect(
      filterMarketplacePlugins(PLUGINS, { ...DEFAULT_FILTERS, query: "pull request" }).map(
        (entry) => entry.packageName,
      ),
    ).toEqual(["github"]);
    expect(
      filterMarketplacePlugins(PLUGINS, { ...DEFAULT_FILTERS, query: "computer-use" }).map(
        (entry) => entry.packageName,
      ),
    ).toEqual(["computer-use"]);
  });

  it("filters MCP, skill, and app bundles from manifest counts", () => {
    expect(
      filterMarketplacePlugins(PLUGINS, { ...DEFAULT_FILTERS, kind: "mcp" }).map(
        (entry) => entry.packageName,
      ),
    ).toEqual(["github", "computer-use"]);
    expect(
      filterMarketplacePlugins(PLUGINS, { ...DEFAULT_FILTERS, kind: "skill" }).map(
        (entry) => entry.packageName,
      ),
    ).toEqual(["github", "computer-use", "design-tools"]);
    expect(
      filterMarketplacePlugins(PLUGINS, { ...DEFAULT_FILTERS, kind: "app" }).map(
        (entry) => entry.packageName,
      ),
    ).toEqual(["computer-use"]);
  });

  it("filters installed packages as a first-class marketplace view", () => {
    expect(
      filterMarketplacePlugins(PLUGINS, { ...DEFAULT_FILTERS, kind: "installed" }).map(
        (entry) => entry.packageName,
      ),
    ).toEqual(["computer-use"]);
  });

  it("combines harness and category filters", () => {
    expect(
      filterMarketplacePlugins(PLUGINS, {
        ...DEFAULT_FILTERS,
        harness: "claude",
        category: "Design",
      }).map((entry) => entry.packageName),
    ).toEqual(["design-tools"]);
  });
});

describe("mergeMarketplaceListings", () => {
  it("groups same-named packages and keeps unrelated names apart", () => {
    const figma = mergeMarketplaceListings([
      {
        ...plugin("figma", { category: "Design", summary: "Codex Figma", mcp: 1, installed: true }),
        name: "Figma",
      },
      {
        ...plugin("figma-claude", {
          category: "Design",
          summary: "Claude Figma",
          skills: 1,
          harness: "claude",
        }),
        name: "Figma",
      },
      plugin("docs-canvas", { category: "Design", summary: "Different plugin" }),
    ]);

    expect(figma.map((entry) => entry.name)).toEqual(["Figma", "docs canvas"]);
    expect(figma[0]?.installed).toBe(true);
    expect(figma[0]?.support.map((entry) => entry.harness)).toEqual(["codex", "claude"]);
    expect(figma[0]?.contents.mcpServerCount).toBe(1);
    expect(figma[0]?.contents.skillCount).toBe(1);
  });
});
