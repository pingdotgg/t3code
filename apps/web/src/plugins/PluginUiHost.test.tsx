import { PluginId, type PluginInfo } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { defineWebPlugin, type PluginUiContext } from "@t3tools/plugin-sdk-web";
import { describe, expect, it } from "vite-plus/test";
import * as Stream from "effect/Stream";

import {
  GENERATED_SETTINGS_PAGE_ID,
  createPluginUiHostState,
  getPluginWebEntryUrl,
  parsePluginIdParam,
  PluginSurfaceErrorBoundary,
  resolvePluginRouteRegistration,
  resolvePluginSettingsPageRegistration,
  syncPluginUiHostRegistrations,
  type PluginSurfaceErrorBoundaryProps,
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
    hasStyles: false,
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
              ctx.registerCommand({
                id: "refresh",
                title: "Refresh",
                run: () => undefined,
              });
              ctx.registerProjectAction({
                id: "new-board",
                render: () => null,
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
    expect(snapshot.commands).toHaveLength(1);
    expect(snapshot.commands[0]?.pluginId).toBe(fixturePluginId);
    expect(snapshot.commands[0]?.context.pluginId).toBe(fixturePluginId);
    expect(snapshot.projectActions).toHaveLength(1);
    expect(snapshot.projectActions[0]?.pluginId).toBe(fixturePluginId);
    expect(snapshot.projectActions[0]?.id).toBe("new-board");
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
    expect(failedSnapshot.commands).toHaveLength(0);
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

  it("retries a failed web plugin import on the next sync, then keeps the loaded plugin", async () => {
    const state = createPluginUiHostState();
    let attempts = 0;
    const importWebPlugin = async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("transient 404");
      }
      return {
        default: defineWebPlugin({
          register(ctx) {
            ctx.registerRoute({ path: "overview", component: () => null });
          },
        }),
      };
    };
    const sync = () =>
      syncPluginUiHostRegistrations({
        state,
        plugins: [pluginInfo()],
        waitForHost: async () => undefined,
        importWebPlugin,
      });

    const failed = await sync();
    expect(failed.routes).toHaveLength(0);
    expect(failed.failures[fixturePluginId]).toContain("transient 404");

    const recovered = await sync();
    expect(recovered.routes).toHaveLength(1);
    expect(recovered.failures).toEqual({});
    expect(attempts).toBe(2);

    // A successfully loaded plugin is NOT re-imported by later syncs.
    await sync();
    expect(attempts).toBe(2);
  });

  it("parses valid plugin id route params and rejects invalid ones without throwing", () => {
    expect(parsePluginIdParam("fixture-plugin")).toBe("fixture-plugin");
    expect(parsePluginIdParam("NOT_VALID!!")).toBeNull();
    expect(parsePluginIdParam("!!")).toBeNull();
    expect(parsePluginIdParam("")).toBeNull();
    expect(parsePluginIdParam("Fixture-Plugin")).toBeNull();
    expect(parsePluginIdParam("a")).toBeNull();
  });
});

describe("PluginSurfaceErrorBoundary", () => {
  const makeErroredBoundary = (props: Omit<PluginSurfaceErrorBoundaryProps, "children">) => {
    const boundary = new PluginSurfaceErrorBoundary({ children: null, ...props });
    boundary.state = { error: new Error("boom") };
    const resets: Array<unknown> = [];
    boundary.setState = ((next: unknown) => {
      resets.push(next);
    }) as typeof boundary.setState;
    return { boundary, resets };
  };

  it("captures render errors via getDerivedStateFromError", () => {
    const error = new Error("boom");
    expect(PluginSurfaceErrorBoundary.getDerivedStateFromError(error)).toEqual({ error });
  });

  it("keeps the error while the same surface re-renders", () => {
    const resetKey = () => null;
    const { boundary, resets } = makeErroredBoundary({ label: "route:a:overview", resetKey });
    boundary.componentDidUpdate({ children: null, label: "route:a:overview", resetKey });
    expect(resets).toEqual([]);
  });

  it("resets when the boundary is reused for a different surface", () => {
    const { boundary, resets } = makeErroredBoundary({ label: "route:b:overview" });
    boundary.componentDidUpdate({ children: null, label: "route:a:overview" });
    expect(resets).toEqual([{ error: null }]);
  });

  it("resets when a registry re-sync reloads the plugin surface", () => {
    const { boundary, resets } = makeErroredBoundary({
      label: "route:a:overview",
      resetKey: () => null,
    });
    boundary.componentDidUpdate({
      children: null,
      label: "route:a:overview",
      resetKey: () => null,
    });
    expect(resets).toEqual([{ error: null }]);
  });

  it("does not reset while no error is stored", () => {
    const { boundary, resets } = makeErroredBoundary({ label: "route:b:overview" });
    boundary.state = { error: null };
    boundary.componentDidUpdate({ children: null, label: "route:a:overview" });
    expect(resets).toEqual([]);
  });
});

describe("PluginUiHost declarative settings", () => {
  // Now assertable: declaring settings produces a host-generated settings page, so
  // a settings-only plugin contributes a real surface. (An earlier version asserted
  // state.loaded, which tracks ATTEMPTS — it passed even with register mandatory and
  // proved nothing.)
  it("generates a settings page for a plugin that declares settings and no register", async () => {
    const state = createPluginUiHostState();

    const snapshot = await syncPluginUiHostRegistrations({
      state,
      plugins: [pluginInfo({ capabilities: ["settings"] })],
      waitForHost: async () => {},
      importWebPlugin: async () => ({
        default: { settings: { schema: Schema.Struct({ baseUrl: Schema.String }) } },
      }),
    });

    expect(snapshot.settingsPages).toHaveLength(1);
    expect(snapshot.settingsPages[0]).toMatchObject({
      pluginId: pluginInfo().id,
      id: GENERATED_SETTINGS_PAGE_ID,
    });
  });

  it("keeps the generated page alongside a plugin's own settings pages", async () => {
    const state = createPluginUiHostState();

    const snapshot = await syncPluginUiHostRegistrations({
      state,
      plugins: [pluginInfo({ capabilities: ["settings"] })],
      waitForHost: async () => {},
      importWebPlugin: async () => ({
        default: {
          settings: { schema: Schema.Struct({ baseUrl: Schema.String }) },
          register(ctx: PluginUiContext) {
            ctx.registerSettingsPage({ id: "custom", title: "Custom", component: () => null });
          },
        },
      }),
    });

    expect(snapshot.settingsPages.map((page) => page.id)).toEqual([
      GENERATED_SETTINGS_PAGE_ID,
      "custom",
    ]);
  });

  // The SERVER validates and stores settings, so a page without the capability would
  // render a form whose every write fails. The capability also transitively requires
  // a server entry — the manifest rejects any capability on a web-only plugin — so
  // this is also what stops a web-only plugin declaring settings.
  it("does not generate a settings page when the plugin lacks the settings capability", async () => {
    const state = createPluginUiHostState();

    const snapshot = await syncPluginUiHostRegistrations({
      state,
      plugins: [pluginInfo({ capabilities: [] })],
      waitForHost: async () => {},
      importWebPlugin: async () => ({
        default: { settings: { schema: Schema.Struct({ baseUrl: Schema.String }) } },
      }),
    });

    expect(snapshot.settingsPages).toEqual([]);
  });

  it("does not generate a settings page for a plugin that declares none", async () => {
    const state = createPluginUiHostState();

    const snapshot = await syncPluginUiHostRegistrations({
      state,
      plugins: [pluginInfo()],
      waitForHost: async () => {},
      importWebPlugin: async () => ({
        default: defineWebPlugin({ register() {} }),
      }),
    });

    expect(snapshot.settingsPages).toEqual([]);
  });

  it("still calls register when a plugin declares both settings and register", async () => {
    const state = createPluginUiHostState();
    let registered = false;

    await syncPluginUiHostRegistrations({
      state,
      plugins: [pluginInfo()],
      waitForHost: async () => {},
      importWebPlugin: async () => ({
        default: {
          settings: { schema: Schema.Struct({ baseUrl: Schema.String }) },
          register() {
            registered = true;
          },
        },
      }),
    });

    expect(registered).toBe(true);
  });
});
