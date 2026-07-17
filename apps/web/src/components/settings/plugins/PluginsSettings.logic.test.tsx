import { renderToStaticMarkup } from "react-dom/server";
import {
  PluginId,
  type MarketplaceVersion,
  type PluginInstallStaged,
  type PluginInfo,
  type PluginSourcesAddResult,
} from "@t3tools/contracts";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { InstalledPluginsSection } from "./PluginsSettings";
import {
  ALL_PLUGIN_SOURCES_VALUE,
  abortPluginInstallConsentFlow,
  addPluginSourceFlow,
  beginPluginInstallConsentFlow,
  confirmPluginInstallConsentFlow,
  effectiveInstallSourceId,
  latestMarketplaceVersion,
  pluginRequiresRelaunch,
  removePluginSourceFlow,
} from "./PluginsSettings.logic";

const pluginId = PluginId.make("hello-board");

const plugin = (overrides: Partial<PluginInfo> = {}): PluginInfo => ({
  id: pluginId,
  name: "Hello Board",
  version: "1.0.0",
  state: "active",
  capabilities: ["database"],
  hasWeb: true,
  hasStyles: false,
  lastError: null,
  ...overrides,
});

function commandFailure<A>(message: string): AtomCommandResult<A, unknown> {
  return AsyncResult.failure(Cause.fail(new Error(message)));
}

const marketplaceVersion = (version: string): MarketplaceVersion => ({
  version,
  tarball: `https://example.test/plugin-${version}.tgz`,
  sha256: "a".repeat(64),
  hostApi: "^1.0.0",
  publishedAt: "2026-07-03T00:00:00.000Z",
});

describe("latestMarketplaceVersion", () => {
  it("picks the semver-max instead of trusting the publisher-controlled order", () => {
    const versions = [marketplaceVersion("0.9.0"), marketplaceVersion("1.0.0")];
    expect(latestMarketplaceVersion(versions)?.version).toBe("1.0.0");
    expect(latestMarketplaceVersion(versions.toReversed())?.version).toBe("1.0.0");
  });

  it("excludes prereleases when a stable release exists", () => {
    expect(
      latestMarketplaceVersion([marketplaceVersion("1.0.0"), marketplaceVersion("1.1.0-rc.1")])
        ?.version,
    ).toBe("1.0.0");
  });

  it("falls back to the newest prerelease when nothing stable is published", () => {
    expect(
      latestMarketplaceVersion([
        marketplaceVersion("1.0.0-rc.2"),
        marketplaceVersion("1.0.0-rc.10"),
      ])?.version,
    ).toBe("1.0.0-rc.10");
  });

  it("returns null for empty version lists", () => {
    expect(latestMarketplaceVersion([])).toBeNull();
  });
});

describe("Plugins settings logic", () => {
  it("detects relaunch states and selected install source", () => {
    expect(pluginRequiresRelaunch(plugin({ state: "pending-remove" }))).toBe(true);
    expect(pluginRequiresRelaunch(plugin({ state: "pending-upgrade" }))).toBe(true);
    expect(pluginRequiresRelaunch(plugin({ state: "disabled-by-host" }))).toBe(true);
    expect(pluginRequiresRelaunch(plugin({ state: "active" }))).toBe(false);

    expect(effectiveInstallSourceId(ALL_PLUGIN_SOURCES_VALUE, [{ id: "src-one" }])).toBe("src-one");
    expect(
      effectiveInstallSourceId(ALL_PLUGIN_SOURCES_VALUE, [{ id: "src-one" }, { id: "src-two" }]),
    ).toBeNull();
    expect(effectiveInstallSourceId("src-two", [{ id: "src-one" }])).toBe("src-two");
  });

  it("surfaces source add and remove server errors from stubbed commands", async () => {
    const addSource = vi.fn(async () =>
      commandFailure<PluginSourcesAddResult>("Plugin sources must be HTTPS URLs."),
    );
    const removeSource = vi.fn(async () =>
      commandFailure<{}>("Source is used by an installed plugin."),
    );

    await expect(addPluginSourceFlow({ addSource }, " http://invalid.test ")).resolves.toEqual({
      ok: false,
      error: "Plugin sources must be HTTPS URLs.",
    });
    expect(addSource).toHaveBeenCalledWith({ url: "http://invalid.test" });

    await expect(removePluginSourceFlow({ removeSource }, "src-used")).resolves.toEqual({
      ok: false,
      error: "Source is used by an installed plugin.",
    });
    expect(removeSource).toHaveBeenCalledWith({ sourceId: "src-used" });
  });

  it("runs install consent begin, confirm, and abort through stubbed commands", async () => {
    const staged: PluginInstallStaged = {
      stageToken: "stage-1",
      manifest: {
        id: pluginId,
        name: "Hello Board",
        version: "1.0.0",
        hostApi: "^1.0.0",
        capabilities: ["database"],
        entries: { server: "server/index.js", web: "web/index.js" },
      },
      capabilityDescriptions: {
        database: "Read and write plugin tables in the local database.",
      },
    };
    const beginInstall = vi.fn(async () => AsyncResult.success(staged));
    const confirmInstall = vi.fn(async () => AsyncResult.success({ plugin: plugin() }));
    const abortInstall = vi.fn(async () => AsyncResult.success({}));

    const begin = await beginPluginInstallConsentFlow(
      { beginInstall },
      { sourceId: "src-local", pluginId, version: "1.0.0" },
    );
    expect(begin).toEqual({ ok: true, value: staged });
    expect(beginInstall).toHaveBeenCalledWith({
      sourceId: "src-local",
      pluginId,
      version: "1.0.0",
    });

    await expect(
      confirmPluginInstallConsentFlow({ confirmInstall }, { stageToken: "stage-1" }),
    ).resolves.toEqual({ ok: true, value: { plugin: plugin() } });
    expect(confirmInstall).toHaveBeenCalledWith({ stageToken: "stage-1" });

    await expect(
      abortPluginInstallConsentFlow({ abortInstall }, { stageToken: "stage-1" }),
    ).resolves.toEqual({ ok: true, value: {} });
    expect(abortInstall).toHaveBeenCalledWith({ stageToken: "stage-1" });
  });
});

describe("InstalledPluginsSection", () => {
  it("renders installed plugins with failed and pending state details", () => {
    const html = renderToStaticMarkup(
      <InstalledPluginsSection
        plugins={[
          plugin({
            state: "failed",
            lastError: "activation boom",
          }),
          plugin({
            id: PluginId.make("pending-board"),
            name: "Pending Board",
            state: "pending-remove",
          }),
        ]}
        updates={new Map()}
        busy={false}
        error={null}
        onToggleEnabled={() => {}}
        onCheckUpdates={() => {}}
        onBeginUpgrade={() => {}}
        onRequestUninstall={() => {}}
      />,
    );

    expect(html).toContain("Hello Board");
    expect(html).toContain("Failed");
    expect(html).toContain("activation boom");
    expect(html).toContain("Pending removal");
    expect(html).toContain("Relaunch to apply");
    expect(html).toContain("Database");
  });
});
