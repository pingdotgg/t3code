import { EnvironmentId, PluginId, type PluginState } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { createElement } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import helloWebSource from "../../../../packages/plugin-sdk/fixtures/hello-web/web.js?raw";
import { fakeTimers, render } from "../../test/render";

vi.mock(import("../state/session"), async (original) => ({
  ...(await original()),
  readPreparedConnection: ((environmentId: string) => ({
    httpBaseUrl: "http://plugins.test/",
    httpAuthorization: environmentId.endsWith(":relay")
      ? { _tag: "Dpop", accessToken: "relay-token" }
      : { _tag: "Bearer", token: "token" },
  })) as never,
}));
const state = await vi.hoisted(async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  const makeLive = () =>
    Atom.make<AsyncResult.AsyncResult<{ readonly plugins: ReadonlyArray<PluginState> }>>(
      AsyncResult.initial(),
    ).pipe(Atom.keepAlive);
  const lives = new Map<string, ReturnType<typeof makeLive>>();
  return {
    lives,
    live: (environmentId: string) => {
      const atom = lives.get(environmentId) ?? makeLive();
      lives.set(environmentId, atom);
      return atom;
    },
    environments: Atom.make<ReadonlyArray<EnvironmentId>>([]).pipe(Atom.keepAlive),
    // Computed only when something reads it, like the real subscription stream.
    channel: Atom.make(() => AsyncResult.success({ value: "first value" })),
  };
});
vi.mock(import("../state/plugins"), () => ({
  pluginEnvironment: {
    pluginsLive: ({ environmentId }: { readonly environmentId: string }) =>
      state.live(environmentId),
    pluginChannel: () => state.channel,
    pluginFileHeaders: {
      label: "plugin-file-headers",
      run: async (_registry: unknown, input: { readonly url: string }) =>
        AsyncResult.success({ authorization: "DPoP relay-token", dpop: `proof for ${input.url}` }),
    },
  } as never,
}));

vi.mock(import("./pluginFollow"), async (original) => ({
  ...(await original()),
  pluginUiEnvironmentsAtom: state.environments,
}));

import { AppAtomRegistryProvider, appAtomRegistry } from "../rpc/atomRegistry";
import { PluginLoaderStarter } from "./PluginLoaderStarter";
import { PluginPanelSurface } from "./PluginPanelSurface";
import { drewPluginsLastTime, pluginUiChoicesAtom, rememberDrawsPlugins } from "./pluginFollow";
import { startPluginLoader } from "./pluginLoader";
import {
  pluginCommandsAtom,
  pluginContributionKey,
  pluginRightPanelAtom,
  pluginRightPanelKey,
  pluginRightPanelsAtom,
  pluginSettingsPanelAtom,
  pluginWebFailuresAtom,
} from "./pluginRegistry";

const webPlugin = (id: string): PluginState => ({
  id: PluginId.make(id),
  name: id,
  version: "0.1.0",
  permissions: [],
  source: "dev",
  enabled: true,
  status: "active",
  hasServer: false,
  hasWeb: true,
  hasSettings: false,
});

// Every case starts with no plugins listed, loading plugin UI from `environments` in order.
function setup(environments: ReadonlyArray<EnvironmentId>) {
  state.lives.clear();
  appAtomRegistry.set(state.environments, environments);
}

describe("startPluginLoader", () => {
  it("loads active web plugins, runs their commands, records one that fails, and unloads everything when stopped", async () => {
    const environmentId = EnvironmentId.make("environment:plugin-loader");
    setup([environmentId]);
    const navigate = vi.fn();
    // A bundle that never arrives must not hold back the plugins after it.
    let releaseHungBundle: (response: Response) => void = () => {};
    const hungBundle = new Promise<Response>((resolve) => {
      releaseHungBundle = resolve;
    });
    using fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) =>
        String(input).includes("/hung-web/")
          ? hungBundle
          : String(input).includes("/hello-web/")
            ? new Response(helloWebSource)
            : String(input).includes("/no-activate-web/")
              ? new Response("export default {};")
              : new Response("missing", { status: 500 }),
      );
    const helloPanel = pluginRightPanelAtom(
      pluginRightPanelKey(environmentId, "hello-web", "hello"),
    );
    const stop = startPluginLoader(environmentId, navigate);
    using _loader = { [Symbol.dispose]: stop };

    appAtomRegistry.set(
      state.live(environmentId),
      AsyncResult.success({
        plugins: [
          webPlugin("hung-web"),
          webPlugin("hello-web"),
          { ...webPlugin("broken-web"), revision: 3 },
          { ...webPlugin("no-activate-web"), revision: 4 },
        ],
      }),
    );

    await vi.waitFor(() => {
      expect(appAtomRegistry.get(helloPanel)?.title).toBe("Hello panel");
      expect(appAtomRegistry.get(pluginWebFailuresAtom("broken-web")).get(environmentId)).toBe(
        "The request for /web.js failed with 500.",
      );
      expect(appAtomRegistry.get(pluginWebFailuresAtom("no-activate-web")).get(environmentId)).toBe(
        "The web bundle does not export a plugin with an activate function.",
      );
    });
    expect(String(fetchSpy.mock.calls[1]?.[0])).toBe(
      "http://plugins.test/api/plugins/hello-web/web.js?v=0.1.0",
    );
    expect(fetchSpy.mock.calls[1]?.[1]).toEqual({ headers: { authorization: "Bearer token" } });
    // A plugin's atoms come from the app's own copy of effect, so the app's registry runs them.
    expect(Reflect.get(globalThis, "__t3PluginHost")).toMatchObject({ atom: { make: Atom.make } });
    // The fixture typechecks against the SDK's hand-written atom types, so its settings panel
    // checks that effect's functions and hooks still behave as those types say.
    const helloSettings = appAtomRegistry.get(
      pluginSettingsPanelAtom(pluginContributionKey(environmentId, "hello-web")),
    )!.component;
    const settingsPanel = () =>
      createElement(AppAtomRegistryProvider, null, createElement(helloSettings));
    {
      await using screen = await render(settingsPanel());
      const sayHello = screen.getByRole("button", { name: "Say hello" });
      for (let press = 0; press < 4; press++) await userEvent.click(sayHello);
      await expect.element(screen.getByText("Hellos: 3")).toBeVisible();
      await userEvent.click(screen.getByRole("button", { name: "Reset" }));
      await expect.element(screen.getByText("Hellos: 0")).toBeVisible();
      await userEvent.click(sayHello);
      // The count stays in the registry once nothing reads it.
      await screen.rerender(null);
      await screen.rerender(settingsPanel());
      await expect.element(screen.getByText("Hellos: 1")).toBeVisible();
    }

    const [command] = appAtomRegistry.get(pluginCommandsAtom);
    expect(command?.command).toBe("plugin.hello-web.open-settings");
    command?.run();
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith("/settings/plugins"));

    expect(document.querySelectorAll('style[data-plugin="hello-web"]')).toHaveLength(1);

    // Turning a plugin off takes effect while another still hangs. A failed download is tried
    // again on that change; a bundle that downloaded and then failed waits for a restart.
    const fetches = (pluginId: string) =>
      fetchSpy.mock.calls.filter(([input]) => String(input).includes(`/${pluginId}/`)).length;
    expect(fetches("broken-web")).toBe(1);
    expect(fetches("no-activate-web")).toBe(1);
    appAtomRegistry.set(
      state.live(environmentId),
      AsyncResult.success({
        plugins: [
          webPlugin("hung-web"),
          { ...webPlugin("broken-web"), revision: 3 },
          { ...webPlugin("no-activate-web"), revision: 4 },
        ],
      }),
    );
    await vi.waitFor(() => expect(appAtomRegistry.get(helloPanel)).toBeUndefined());
    await vi.waitFor(() => expect(fetches("broken-web")).toBe(2));
    expect(fetches("no-activate-web")).toBe(1);

    stop();
    releaseHungBundle(new Response("missing", { status: 500 }));
    expect(document.querySelectorAll('style[data-plugin="hello-web"]')).toHaveLength(0);
    expect(appAtomRegistry.get(helloPanel)).toBeUndefined();
    expect(appAtomRegistry.get(pluginCommandsAtom)).toEqual([]);
  });

  it("tries a download again after a bad gateway", async () => {
    const environmentId = EnvironmentId.make("environment:plugin-loader-retry");
    setup([environmentId]);
    let badGateways = 1;
    using _fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () =>
        badGateways-- > 0
          ? new Response("bad gateway", { status: 502 })
          : new Response(helloWebSource),
      );
    using _timers = fakeTimers();
    appAtomRegistry.set(
      state.live(environmentId),
      AsyncResult.success({ plugins: [webPlugin("hello-web")] }),
    );
    using _loader = { [Symbol.dispose]: startPluginLoader(environmentId, vi.fn()) };

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(appAtomRegistry.get(pluginCommandsAtom)).toHaveLength(1));
    expect(
      appAtomRegistry.get(pluginWebFailuresAtom("hello-web")).get(environmentId),
    ).toBeUndefined();
  });

  it("reloads a restarted plugin and undoes what it registers after unloading", async () => {
    const environmentId = EnvironmentId.make("environment:plugin-loader-reload");
    setup([environmentId]);
    // The first start registers only when the test releases it, after a restart replaced it.
    const slowSource = `export default { activate(api) {
      const settings = () => api.settings.registerPanel(() => null);
      if (globalThis.__releaseSlowPlugin) return settings();
      return new Promise((release) => { globalThis.__releaseSlowPlugin = release; }).then(() => {
        settings();
        api.rightPanel.register({ name: "slow", title: "Slow", component: () => null });
      });
    } };`;
    using fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) =>
        String(input).includes("/hello-web/")
          ? new Response(helloWebSource)
          : new Response(slowSource),
      );
    const bundleRequests = (pluginId: string) =>
      fetchSpy.mock.calls.filter(([input]) => String(input).includes(`/${pluginId}/`)).length;
    const stop = startPluginLoader(environmentId, vi.fn());
    using _loader = { [Symbol.dispose]: stop };

    appAtomRegistry.set(
      state.live(environmentId),
      AsyncResult.success({ plugins: [webPlugin("hello-web")] }),
    );
    await vi.waitFor(() => expect(appAtomRegistry.get(pluginCommandsAtom)).toHaveLength(1));
    appAtomRegistry.set(
      state.live(environmentId),
      AsyncResult.success({ plugins: [{ ...webPlugin("hello-web"), revision: 2 }] }),
    );
    await vi.waitFor(() => expect(bundleRequests("hello-web")).toBe(2));

    appAtomRegistry.set(
      state.live(environmentId),
      AsyncResult.success({ plugins: [webPlugin("slow-web")] }),
    );
    await vi.waitFor(() =>
      expect(Reflect.get(globalThis, "__releaseSlowPlugin")).toBeTypeOf("function"),
    );
    appAtomRegistry.set(
      state.live(environmentId),
      AsyncResult.success({ plugins: [{ ...webPlugin("slow-web"), revision: 2 }] }),
    );
    const settingsPanel = pluginSettingsPanelAtom(pluginContributionKey(environmentId, "slow-web"));
    await vi.waitFor(() => expect(appAtomRegistry.get(settingsPanel)).toBeDefined());
    const release = Reflect.get(globalThis, "__releaseSlowPlugin") as () => void;
    Reflect.deleteProperty(globalThis, "__releaseSlowPlugin");
    release();
    await Promise.resolve();
    expect(appAtomRegistry.get(settingsPanel)).toBeDefined();
    expect(
      appAtomRegistry.get(
        pluginRightPanelAtom(pluginRightPanelKey(environmentId, "slow-web", "slow")),
      ),
    ).toBeUndefined();
    stop();
    expect(appAtomRegistry.get(settingsPanel)).toBeUndefined();
  });

  it("keeps each environment's right panels to its own threads and takes a plugin's commands and styles from the first environment that has it on", async () => {
    const environmentA = EnvironmentId.make("environment:plugin-loader-scope:a");
    const environmentB = EnvironmentId.make("environment:plugin-loader-scope:b");
    setup([environmentA, environmentB]);
    // Right panels only from environment B, commands and styles from both.
    const source = `export default { activate(api) {
      api.commands.register({ id: "open", title: "Open", run() {} });
      api.injectStyles("/* " + api.id + " */");
      if (!api.environmentId.endsWith(":b")) return;
      api.rightPanel.register({ name: "notes", title: "Notes", component: () => null });
    } };`;
    using _fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response(source));
    appAtomRegistry.set(
      state.live(environmentA),
      AsyncResult.success({ plugins: [webPlugin("notes-web")] }),
    );
    appAtomRegistry.set(
      state.live(environmentB),
      AsyncResult.success({ plugins: [webPlugin("notes-web"), webPlugin("solo-web")] }),
    );
    using _a = { [Symbol.dispose]: startPluginLoader(environmentA, vi.fn()) };
    using _b = { [Symbol.dispose]: startPluginLoader(environmentB, vi.fn()) };
    const commandSources = () =>
      appAtomRegistry
        .get(pluginCommandsAtom)
        .map((entry) => `${entry.pluginId} from ${entry.environmentId}`)
        .toSorted();
    const styleCount = (pluginId: string) =>
      document.querySelectorAll(`style[data-plugin="${pluginId}"]`).length;

    await vi.waitFor(() => {
      expect(commandSources()).toContain(`notes-web from ${environmentA}`);
      expect(appAtomRegistry.get(pluginRightPanelsAtom(environmentB))).toHaveLength(2);
    });
    expect(appAtomRegistry.get(pluginRightPanelsAtom(environmentA))).toEqual([]);
    expect(commandSources()).toEqual([
      `notes-web from ${environmentA}`,
      `solo-web from ${environmentB}`,
    ]);
    expect(styleCount("notes-web")).toBe(1);
    expect(styleCount("solo-web")).toBe(1);

    appAtomRegistry.set(state.live(environmentA), AsyncResult.success({ plugins: [] }));
    await vi.waitFor(() =>
      expect(commandSources()).toEqual([
        `notes-web from ${environmentB}`,
        `solo-web from ${environmentB}`,
      ]),
    );
    expect(styleCount("notes-web")).toBe(1);
  });

  it("ends a restored panel's wait once its plugin loads without that panel", async () => {
    const environmentId = EnvironmentId.make("environment:plugin-loader-no-panel");
    setup([environmentId]);
    using _fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response("export default { activate() {} };"));
    appAtomRegistry.set(pluginUiChoicesAtom, new Map([[environmentId, true]]));
    using _choices = {
      [Symbol.dispose]: () => appAtomRegistry.set(pluginUiChoicesAtom, new Map()),
    };
    appAtomRegistry.set(
      state.live(environmentId),
      AsyncResult.success({ plugins: [webPlugin("quiet-web")] }),
    );
    await using screen = await render(
      createElement(
        AppAtomRegistryProvider,
        null,
        createElement(PluginPanelSurface, {
          environmentId,
          threadId: "thread-1",
          pluginId: "quiet-web",
          panel: "notes",
          onClose: () => {},
        }),
      ),
    );
    await expect.element(screen.getByText("Loading plugin")).toBeVisible();

    using _loader = { [Symbol.dispose]: startPluginLoader(environmentId, vi.fn()) };
    await expect.element(screen.getByText("Plugin not active")).toBeVisible();
  });

  it("starts a channel the plugin subscribes to and hands it the values", async () => {
    const environmentId = EnvironmentId.make("environment:plugin-loader-channel");
    setup([environmentId]);
    const channelSource = `export default { activate(api) {
      api.rpc.subscribe("notes", (value) => api.injectStyles("/* " + String(value) + " */"));
    } };`;
    using _fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response(channelSource));
    const stop = startPluginLoader(environmentId, vi.fn());
    using _loader = { [Symbol.dispose]: stop };

    appAtomRegistry.set(
      state.live(environmentId),
      AsyncResult.success({ plugins: [webPlugin("channel-web")] }),
    );

    await vi.waitFor(() =>
      expect(document.querySelector('style[data-plugin="channel-web"]')?.textContent).toBe(
        "/* first value */",
      ),
    );
  });

  it("signs bundle requests with a DPoP proof over a T3 Connect link", async () => {
    const environmentId = EnvironmentId.make("environment:plugin-loader:relay");
    setup([environmentId]);
    using fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response("export default { activate() {} };"));
    appAtomRegistry.set(
      state.live(environmentId),
      AsyncResult.success({ plugins: [webPlugin("relay-web")] }),
    );
    const stop = startPluginLoader(environmentId, vi.fn());
    using _loader = { [Symbol.dispose]: stop };

    await vi.waitFor(() =>
      expect(fetchSpy.mock.calls[0]?.[1]).toEqual({
        headers: {
          authorization: "DPoP relay-token",
          dpop: "proof for http://plugins.test/api/plugins/relay-web/web.js?v=0.1.0",
        },
      }),
    );
  });
});

describe("PluginLoaderStarter", () => {
  it("starts with the app where plugins drew last time, and remembers whether they do", async () => {
    const environmentId = EnvironmentId.make("environment:plugin-loader-starter");
    setup([environmentId]);
    using fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response("export default { activate() {} };"));
    using _memory = { [Symbol.dispose]: () => rememberDrawsPlugins(environmentId, false) };
    appAtomRegistry.set(
      state.live(environmentId),
      AsyncResult.success({ plugins: [webPlugin("eager-web")] }),
    );
    // Idle comes at once on the first start and never on the second.
    using idle = vi.spyOn(window, "requestIdleCallback").mockImplementation((run) => {
      run({ didTimeout: false, timeRemaining: () => 0 });
      return 0;
    });
    const starter = () =>
      createElement(AppAtomRegistryProvider, null, createElement(PluginLoaderStarter));
    await using screen = await render(starter());
    await vi.waitFor(() => expect(drewPluginsLastTime(environmentId)).toBe(true));

    await screen.rerender(null);
    idle.mockReturnValue(0);
    const fetches = fetchSpy.mock.calls.length;
    await screen.rerender(starter());
    await vi.waitFor(() => expect(fetchSpy.mock.calls.length).toBeGreaterThan(fetches));

    appAtomRegistry.set(state.live(environmentId), AsyncResult.success({ plugins: [] }));
    await vi.waitFor(() => expect(drewPluginsLastTime(environmentId)).toBe(false));
  });
});
