import { describe, expect, it } from "vite-plus/test";
import { PluginCommandName, PluginKeybindingCommandName } from "@t3tools/contracts";

import {
  claimPluginKeybindingCommand,
  isActiveClientPluginKeybindingCommand,
} from "./pluginKeybindingBridge";
import {
  createPluginContextBase,
  removePluginUiRegistrationsForAssetKeys,
  removePluginUiRegistrationsForScope,
  type PluginUiRpcClient,
} from "./pluginUiRuntime";
import { pluginAssetFactoryKey } from "./pluginNavigation";
import {
  markPluginAssetFailed,
  markPluginAssetLoading,
  readPluginHostState,
  registerPluginAssetFactory,
  resetPluginHostState,
  setPluginCatalogReady,
} from "./pluginHostStore";
import { makePluginCatalogEntry } from "./testing/pluginPlacementFixtures";

describe("pluginHost", () => {
  it("recognizes only active client keybinding commands", () => {
    const catalog = [
      makePluginCatalogEntry({
        pluginId: "t3.voice-input",
        name: "Voice Input",
        placementId: "settings-sidebar",
        placementLabel: "Voice Input",
        placementPosition: "settings.sidebar",
        routeSurface: "settings",
        commands: [
          {
            name: PluginKeybindingCommandName.make("toggleRecording"),
            target: "client",
            label: "Toggle voice recording",
            keybinding: true,
          },
          {
            name: PluginCommandName.make("voiceInput.transcribe"),
            target: "server",
            label: "Transcribe voice input",
          },
        ],
      }),
    ];

    expect(
      isActiveClientPluginKeybindingCommand(catalog, "plugin.t3.voice-input.toggleRecording"),
    ).toBe(true);
    expect(
      isActiveClientPluginKeybindingCommand(catalog, "plugin.t3.voice-input.voiceInput.transcribe"),
    ).toBe(false);
    expect(isActiveClientPluginKeybindingCommand([], "plugin.t3.voice-input.toggleRecording")).toBe(
      false,
    );
  });

  it("matches dotted plugin command ids exactly", () => {
    const catalog = [
      makePluginCatalogEntry({
        pluginId: "foo",
        name: "Foo",
        placementId: "foo",
        placementLabel: "Foo",
        placementPosition: "sidebar.primary",
        commands: [
          {
            name: PluginCommandName.make("bar.baz"),
            target: "server",
            label: "Server command",
          },
        ],
      }),
      makePluginCatalogEntry({
        pluginId: "foo.bar",
        name: "Foo Bar",
        placementId: "foo-bar",
        placementLabel: "Foo Bar",
        placementPosition: "sidebar.primary",
        commands: [
          {
            name: PluginKeybindingCommandName.make("baz"),
            target: "client",
            label: "Client command",
            keybinding: true,
          },
        ],
      }),
    ];

    expect(isActiveClientPluginKeybindingCommand(catalog, "plugin.foo.bar.baz")).toBe(true);
    expect(isActiveClientPluginKeybindingCommand(catalog, "plugin.foo.bar.qux")).toBe(false);
  });

  it("does not claim inactive plugin keybinding commands", () => {
    expect(claimPluginKeybindingCommand([], "plugin.t3.voice-input.toggleRecording")).toBe(false);
  });

  it("dispatches claimed plugin keybindings to the active composer", () => {
    const catalog = [
      makePluginCatalogEntry({
        pluginId: "t3.voice-input",
        name: "Voice Input",
        placementId: "settings-sidebar",
        placementLabel: "Voice Input",
        placementPosition: "settings.sidebar",
        routeSurface: "settings",
        commands: [
          {
            name: PluginKeybindingCommandName.make("toggleRecording"),
            target: "client",
            label: "Toggle voice recording",
            keybinding: true,
          },
        ],
      }),
    ];
    const received: Array<{ readonly command: string; readonly composerId?: string }> = [];
    const eventTarget = new EventTarget();
    const previousWindow = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = eventTarget;
    const listener = (event: Event) => {
      received.push(
        (event as CustomEvent<{ readonly command: string; readonly composerId?: string }>).detail,
      );
    };
    eventTarget.addEventListener("t3:plugin-keybinding-command", listener);
    try {
      expect(
        claimPluginKeybindingCommand(
          catalog,
          "plugin.t3.voice-input.toggleRecording",
          "composer-1",
        ),
      ).toBe(true);
    } finally {
      eventTarget.removeEventListener("t3:plugin-keybinding-command", listener);
      (globalThis as { window?: unknown }).window = previousWindow;
    }

    expect(received).toEqual([
      { command: "plugin.t3.voice-input.toggleRecording", composerId: "composer-1" },
    ]);
  });

  it("clears cached plugin UI APIs for a host scope", () => {
    const catalogEntry = makePluginCatalogEntry({
      pluginId: "t3.voice-input",
      name: "Voice Input",
      placementId: "settings-sidebar",
      placementLabel: "Voice Input",
      placementPosition: "settings.sidebar",
      routeSurface: "settings",
    });
    const client = {
      plugins: {
        invoke: async () => ({ output: null }),
        subscribe: () => () => {},
      },
    } satisfies PluginUiRpcClient;
    const first = createPluginContextBase({
      cacheKey: "scope-a\u00001\u0000t3.voice-input\u00000.1.0\u0000/client.js",
      client,
      catalogEntry,
      navigate: () => {},
    });
    const second = createPluginContextBase({
      cacheKey: "scope-a\u00001\u0000t3.voice-input\u00000.1.0\u0000/client.js",
      client,
      catalogEntry,
      navigate: () => {},
    });

    removePluginUiRegistrationsForScope("scope-a");
    const afterReset = createPluginContextBase({
      cacheKey: "scope-a\u00001\u0000t3.voice-input\u00000.1.0\u0000/client.js",
      client,
      catalogEntry,
      navigate: () => {},
    });

    expect(second.api).toBe(first.api);
    expect(afterReset.api).not.toBe(first.api);
  });

  it("clears cached plugin UI APIs for stale asset keys", () => {
    const catalogEntry = makePluginCatalogEntry({
      pluginId: "t3.voice-input",
      name: "Voice Input",
      placementId: "settings-sidebar",
      placementLabel: "Voice Input",
      placementPosition: "settings.sidebar",
      routeSurface: "settings",
    });
    const client = {
      plugins: {
        invoke: async () => ({ output: null }),
        subscribe: () => () => {},
      },
    } satisfies PluginUiRpcClient;
    const assetKey = "scope-stale\u00001\u0000t3.voice-input\u00000.1.0\u0000/client.js";
    const first = createPluginContextBase({
      cacheKey: assetKey,
      client,
      catalogEntry,
      navigate: () => {},
    });

    removePluginUiRegistrationsForAssetKeys([assetKey]);
    const afterReset = createPluginContextBase({
      cacheKey: assetKey,
      client,
      catalogEntry,
      navigate: () => {},
    });

    expect(afterReset.api).not.toBe(first.api);
  });

  it("drops plugin asset factories that are no longer present in the catalog", () => {
    const hostScope = "scope-prune";
    const catalogEntry = makePluginCatalogEntry({
      pluginId: "t3.prune",
      name: "Prune Plugin",
      placementId: "prune-sidebar",
      placementLabel: "Prune Plugin",
      placementPosition: "sidebar.primary",
    });
    const generation = resetPluginHostState(hostScope, null);
    setPluginCatalogReady({
      client: null,
      hostScope,
      generation,
      catalog: [catalogEntry],
    });
    const assetKey = pluginAssetFactoryKey(hostScope, generation, catalogEntry);
    registerPluginAssetFactory({
      pluginId: catalogEntry.manifest.id,
      assetKey,
      factory: () => ({ routes: {} }),
    });

    expect(readPluginHostState().assets.get(assetKey)?.status).toBe("registered");

    setPluginCatalogReady({
      client: null,
      hostScope,
      generation,
      catalog: [],
    });

    expect(readPluginHostState().assets.get(assetKey)).toBeUndefined();
  });

  it("allows failed plugin client assets to retry for the current generation", () => {
    const hostScope = "scope-retry";
    const catalogEntry = makePluginCatalogEntry({
      pluginId: "t3.retry",
      name: "Retry Plugin",
      placementId: "retry-sidebar",
      placementLabel: "Retry Plugin",
      placementPosition: "sidebar.primary",
    });
    const generation = resetPluginHostState(hostScope, null);
    setPluginCatalogReady({
      client: null,
      hostScope,
      generation,
      catalog: [catalogEntry],
    });
    const assetKey = pluginAssetFactoryKey(hostScope, generation, catalogEntry);

    markPluginAssetLoading({
      hostScope,
      generation,
      pluginId: catalogEntry.manifest.id,
      assetKey,
    });
    markPluginAssetFailed({
      hostScope,
      generation,
      pluginId: catalogEntry.manifest.id,
      assetKey,
      message: "failed once",
    });

    expect(readPluginHostState().assets.get(assetKey)?.status).toBe("failed");

    markPluginAssetLoading({
      hostScope,
      generation,
      pluginId: catalogEntry.manifest.id,
      assetKey,
    });

    expect(readPluginHostState().assets.get(assetKey)?.status).toBe("loading");
  });
});
