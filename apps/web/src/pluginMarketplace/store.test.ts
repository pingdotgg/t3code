import type { PluginMarketplaceDetail, PluginMarketplacePlugin } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("./api", () => ({
  fetchPluginMarketplaceCatalog: vi.fn(),
  fetchPluginMarketplaceDetail: vi.fn(),
  installPlugin: vi.fn(),
  removePlugin: vi.fn(),
}));

import {
  fetchPluginMarketplaceCatalog,
  fetchPluginMarketplaceDetail,
  installPlugin,
  removePlugin,
} from "./api";
import { usePluginMarketplaceStore } from "./store";

const summary: PluginMarketplacePlugin = {
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
  installed: false,
  enabled: false,
  brandColor: null,
  hasLocalLogo: false,
  logoDataUrl: null,
  logoUrl: null,
  contents: {
    skillCount: 1,
    mcpServerCount: 1,
    appCount: 0,
    commandCount: 0,
    agentCount: 0,
    ruleCount: 0,
    hookCount: 0,
    hasHooks: false,
  },
  support: [{ harness: "codex", mcp: true, skills: true, apps: false }],
};

const detail: PluginMarketplaceDetail = {
  ...summary,
  installed: true,
  enabled: true,
  description: "Controls local apps through the real Codex plugin.",
  marketplaceUrl: null,
  homepage: null,
  repository: null,
  capabilities: [],
  defaultPrompts: [],
  skills: [
    {
      id: "computer-use",
      name: "Computer Use",
      description: "Operate local app UI.",
      invocation: "$computer-use:computer-use",
    },
  ],
  mcpServers: [
    {
      id: "computer-use",
      name: "Computer Use",
      transport: "stdio",
      url: null,
      oauthResource: null,
      note: null,
      toolTimeoutSeconds: null,
      environmentVariables: [],
    },
  ],
  apps: [],
  extensions: [],
  installTargets: [
    {
      pluginId: summary.id,
      harness: "codex",
      marketplaceName: "openai-bundled",
      version: "1.0.0",
      installed: true,
      enabled: true,
      installPolicy: "AVAILABLE",
      marketplaceUrl: null,
      contents: summary.contents,
    },
  ],
};

describe("plugin marketplace store", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    usePluginMarketplaceStore.setState({
      catalogStatus: "idle",
      plugins: [],
      searchHits: [],
      catalogError: null,
      details: {},
      pending: {},
    });
  });

  it("loads the Codex catalog from the environment API", async () => {
    vi.mocked(fetchPluginMarketplaceCatalog).mockResolvedValue({ plugins: [summary] });

    await usePluginMarketplaceStore.getState().loadCatalog();

    expect(fetchPluginMarketplaceCatalog).toHaveBeenCalledOnce();
    expect(usePluginMarketplaceStore.getState().plugins).toEqual([summary]);
    expect(usePluginMarketplaceStore.getState().catalogStatus).toBe("ready");
  });

  it("queues forced catalog refreshes behind an in-flight request", async () => {
    let resolveFirst: ((value: { plugins: PluginMarketplacePlugin[] }) => void) | undefined;
    vi.mocked(fetchPluginMarketplaceCatalog)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValueOnce({ plugins: [{ ...summary, installed: true, enabled: true }] });

    const first = usePluginMarketplaceStore.getState().loadCatalog(true);
    const forced = usePluginMarketplaceStore.getState().loadCatalog(true);
    resolveFirst?.({ plugins: [summary] });
    await Promise.all([first, forced]);

    expect(fetchPluginMarketplaceCatalog).toHaveBeenCalledTimes(2);
    expect(usePluginMarketplaceStore.getState().plugins[0]?.installed).toBe(true);
  });

  it("runs a real install mutation and refreshes catalog and details", async () => {
    vi.mocked(installPlugin).mockResolvedValue({ pluginId: summary.id, installed: true });
    vi.mocked(fetchPluginMarketplaceCatalog).mockResolvedValue({
      plugins: [{ ...summary, installed: true, enabled: true }],
    });
    vi.mocked(fetchPluginMarketplaceDetail).mockResolvedValue(detail);

    await usePluginMarketplaceStore.getState().setInstalled(summary.id, true);

    expect(installPlugin).toHaveBeenCalledWith(summary.id);
    expect(usePluginMarketplaceStore.getState().plugins[0]?.installed).toBe(true);
    expect(usePluginMarketplaceStore.getState().details[summary.id]?.plugin).toEqual(detail);
    expect(usePluginMarketplaceStore.getState().pending[summary.id]).toBe(false);
  });

  it("runs remove through Codex", async () => {
    vi.mocked(removePlugin).mockResolvedValue({ pluginId: summary.id, installed: false });
    vi.mocked(fetchPluginMarketplaceCatalog).mockResolvedValue({ plugins: [summary] });
    vi.mocked(fetchPluginMarketplaceDetail).mockResolvedValue({
      ...detail,
      installed: false,
      enabled: false,
    });

    await usePluginMarketplaceStore.getState().setInstalled(summary.id, false);

    expect(removePlugin).toHaveBeenCalledWith(summary.id);
    expect(usePluginMarketplaceStore.getState().details[summary.id]?.plugin?.installed).toBe(false);
  });

  it("keeps ChatGPT public search hits that the browse catalog omitted", async () => {
    const tickTick = {
      ...summary,
      id: "codex:app-ticktick@chatgpt-public",
      packageName: "app-ticktick",
      name: "TickTick:To-Do List & Calendar",
      marketplaceName: "ChatGPT Public",
    };
    vi.mocked(fetchPluginMarketplaceCatalog)
      .mockResolvedValueOnce({ plugins: [summary] })
      .mockResolvedValueOnce({ plugins: [summary, tickTick] });

    await usePluginMarketplaceStore.getState().loadCatalog();
    await usePluginMarketplaceStore.getState().searchCatalog("tick");

    expect(fetchPluginMarketplaceCatalog).toHaveBeenNthCalledWith(2, "tick");
    expect(usePluginMarketplaceStore.getState().searchHits).toEqual([tickTick]);

    await usePluginMarketplaceStore.getState().searchCatalog("t");
    expect(usePluginMarketplaceStore.getState().searchHits).toEqual([]);
  });
});
