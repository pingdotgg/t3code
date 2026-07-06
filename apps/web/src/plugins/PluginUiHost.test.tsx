import { PluginId, type PluginInfo } from "@t3tools/contracts";
import { defineWebPlugin } from "@t3tools/plugin-sdk-web";
import { describe, expect, it } from "vite-plus/test";
import * as Stream from "effect/Stream";

import {
  createPluginUiHostState,
  getPluginWebEntryUrl,
  resolvePluginRouteRegistration,
  resolvePluginSettingsPageRegistration,
  syncPluginUiHostRegistrations,
} from "./PluginUiHost";

const fixturePluginId = PluginId.make("fixture-plugin");
const failingPluginId = PluginId.make("failing-plugin");

function pluginInfo(overrides: Partial<PluginInfo> = {}): PluginInfo {
  return {
    id: fixturePluginId,
    name: "Fixture",
    version: "1.2.3",
    state: "active",
    capabilities: [],
    hasWeb: true,
    lastError: null,
    ...overrides,
  };
}

describe("PluginUiHost", () => {
  it("awaits host readiness before importing and captures plugin registrations", async () => {
    const state = createPluginUiHostState();
    const order: string[] = [];
    const rpcCalls: string[] = [];

    const snapshot = await syncPluginUiHostRegistrations({
      state,
      plugins: [pluginInfo()],
      waitForHost: async () => {
        order.push("ready");
      },
      importWebPlugin: async (url) => {
        order.push(`import:${url}`);
        return {
          default: defineWebPlugin({
            register(ctx) {
              ctx.registerRoute({
                path: "overview",
                component: () => null,
              });
              ctx.registerSidebarSection({
                id: "main",
                title: "Main",
                render: () => null,
              });
              ctx.registerSettingsPage({
                id: "general",
                title: "General",
                component: () => null,
              });
              void ctx.rpc.call("ping");
            },
          }),
        };
      },
      createRpc: (pluginId) => ({
        call: (method) => {
          rpcCalls.push(`${pluginId}:${method}`);
          return Promise.resolve(null);
        },
        subscribe: (method, payload) => Stream.make({ method, payload }),
      }),
    });

    expect(order).toEqual(["ready", "import:/plugins/fixture-plugin/1.2.3/web/index.js"]);
    expect(rpcCalls).toEqual(["fixture-plugin:ping"]);
    expect(snapshot.routes).toHaveLength(1);
    expect(snapshot.sidebarSections).toHaveLength(1);
    expect(snapshot.settingsPages).toHaveLength(1);
    expect(snapshot.failures).toEqual({});
  });

  it("contains failing imports and removes surfaces when a plugin leaves active state", async () => {
    const state = createPluginUiHostState();

    const activeSnapshot = await syncPluginUiHostRegistrations({
      state,
      plugins: [pluginInfo()],
      waitForHost: async () => undefined,
      importWebPlugin: async () => ({
        default: defineWebPlugin({
          register(ctx) {
            ctx.registerRoute({ path: "overview", component: () => null });
          },
        }),
      }),
    });
    expect(activeSnapshot.routes).toHaveLength(1);

    const failedSnapshot = await syncPluginUiHostRegistrations({
      state,
      plugins: [pluginInfo({ id: failingPluginId, name: "Failing", version: "2.0.0" })],
      waitForHost: async () => undefined,
      importWebPlugin: async () => {
        throw new Error("boom");
      },
    });
    expect(failedSnapshot.routes).toHaveLength(0);
    expect(failedSnapshot.failures[failingPluginId]).toContain("boom");

    const emptySnapshot = await syncPluginUiHostRegistrations({
      state,
      plugins: [],
      waitForHost: async () => undefined,
      importWebPlugin: async () => {
        throw new Error("should not import");
      },
    });
    expect(emptySnapshot.routes).toEqual([]);
    expect(emptySnapshot.failures).toEqual({});
  });

  it("resolves registered plugin routes and settings pages without crashing unknown paths", async () => {
    const state = createPluginUiHostState();
    const snapshot = await syncPluginUiHostRegistrations({
      state,
      plugins: [pluginInfo()],
      waitForHost: async () => undefined,
      importWebPlugin: async () => ({
        default: defineWebPlugin({
          register(ctx) {
            ctx.registerRoute({ path: "overview", component: () => null });
            ctx.registerSettingsPage({
              id: "general",
              title: "General",
              component: () => null,
            });
          },
        }),
      }),
    });

    expect(resolvePluginRouteRegistration(snapshot, fixturePluginId, "overview")?.path).toBe(
      "overview",
    );
    expect(resolvePluginRouteRegistration(snapshot, fixturePluginId, "missing")).toBeNull();
    expect(resolvePluginSettingsPageRegistration(snapshot, fixturePluginId, "general")?.id).toBe(
      "general",
    );
    expect(resolvePluginSettingsPageRegistration(snapshot, fixturePluginId, "missing")).toBeNull();
  });

  it("uses the conventional same-origin web entry URL", () => {
    expect(getPluginWebEntryUrl(pluginInfo())).toBe("/plugins/fixture-plugin/1.2.3/web/index.js");
  });
});
