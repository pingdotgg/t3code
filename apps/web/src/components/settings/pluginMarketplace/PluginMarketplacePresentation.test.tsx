import type { PluginMarketplacePlugin } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { marketplacePluginIncludeLabels } from "~/pluginMarketplace/catalog";

import { HarnessSupportBadges, PluginLogo } from "./PluginMarketplacePresentation";

const plugin: PluginMarketplacePlugin = {
  id: "computer-use@openai-bundled",
  sourceHarness: "codex",
  packageName: "computer-use",
  name: "Computer Use",
  summary: "Control local Mac apps from Codex",
  developer: "OpenAI",
  category: "Productivity",
  version: "1.0.0",
  marketplaceName: "openai-bundled",
  marketplaceSourceType: "git",
  installPolicy: "AVAILABLE",
  authPolicy: "ON_INSTALL",
  installed: true,
  enabled: true,
  brandColor: null,
  hasLocalLogo: true,
  logoDataUrl: "data:image/png;base64,aWNvbg==",
  logoUrl: null,
  contents: {
    skillCount: 1,
    mcpServerCount: 1,
    appCount: 1,
    commandCount: 0,
    agentCount: 0,
    ruleCount: 0,
    hookCount: 0,
    hasHooks: false,
  },
  support: [{ harness: "codex", mcp: true, skills: true, apps: true }],
};

describe("plugin marketplace presentation", () => {
  it("renders the plugin artwork returned by Codex", () => {
    const markup = renderToStaticMarkup(<PluginLogo plugin={plugin} />);

    expect(markup).toContain('role="img"');
    expect(markup).toContain('aria-label="Computer Use logo"');
    expect(markup).toContain('src="data:image/png;base64,aWNvbg=="');
  });

  it("uses readable fallback logo text in light and dark themes", () => {
    const markup = renderToStaticMarkup(
      <PluginLogo plugin={{ ...plugin, hasLocalLogo: false, logoDataUrl: null, logoUrl: null }} />,
    );

    expect(markup).toMatch(/text-(?:blue|emerald|violet|amber|rose|cyan)-700/);
    expect(markup).toMatch(/dark:text-(?:blue|emerald|violet|amber|rose|cyan)-300/);
  });

  it("labels harness badges with each real bundle capability", () => {
    const markup = renderToStaticMarkup(<HarnessSupportBadges support={plugin.support} />);

    expect(markup).toContain('role="group"');
    expect(markup).toContain('role="img"');
    expect(markup).toContain('aria-label="Codex: MCP + skills + apps"');
    expect(markup).not.toContain('aria-label="Cursor:');
  });

  it("includes every extension kind without duplicating hooks", () => {
    expect(
      marketplacePluginIncludeLabels({
        contents: { ...plugin.contents, hasHooks: true },
        extensions: [
          { id: "run", name: "Run", kind: "command", description: "", sourceUrl: null },
          { id: "review", name: "Review", kind: "agent", description: "", sourceUrl: null },
          { id: "start", name: "Start", kind: "hook", description: "", sourceUrl: null },
          { id: "typescript", name: "TypeScript", kind: "lsp", description: "", sourceUrl: null },
          { id: "health", name: "Health", kind: "monitor", description: "", sourceUrl: null },
        ],
      }),
    ).toEqual([
      "MCP",
      "Skills",
      "Apps",
      "Commands",
      "Subagents",
      "Hooks",
      "Language servers",
      "Monitors",
    ]);
  });
});
