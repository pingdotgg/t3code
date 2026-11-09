import { EnvironmentId, PluginId, type PluginState } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../test/render";

const state = await vi.hoisted(async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  return {
    live: Atom.make<AsyncResult.AsyncResult<{ readonly plugins: ReadonlyArray<PluginState> }>>(
      AsyncResult.initial(),
    ),
  };
});
vi.mock(import("../state/plugins"), () => ({
  pluginEnvironment: { pluginsLive: () => state.live } as never,
}));

import { AppAtomRegistryProvider, appAtomRegistry } from "../rpc/atomRegistry";
import { PluginPanelSurface } from "./PluginPanelSurface";
import { pluginUiChoicesAtom } from "./pluginFollow";
import { registerPluginRightPanel, setPluginWebFailure } from "./pluginRegistry";

const environmentId = EnvironmentId.make("environment:plugin-panel");

const helloWeb = (status: PluginState["status"]): PluginState => ({
  id: PluginId.make("hello-web"),
  name: "Hello web",
  version: "0.1.0",
  permissions: [],
  source: "dev",
  enabled: status !== "disabled",
  status,
  hasServer: false,
  hasWeb: true,
  hasSettings: false,
});

const setList = (plugins: ReadonlyArray<PluginState>) =>
  appAtomRegistry.set(state.live, AsyncResult.success({ plugins }));

// Every case starts with no plugins listed yet and plugin UI loading from the environment.
function setup() {
  appAtomRegistry.set(state.live, AsyncResult.initial());
  setPluginWebFailure(environmentId, "hello-web", undefined);
  appAtomRegistry.set(pluginUiChoicesAtom, new Map([[environmentId, true]]));
  return { [Symbol.dispose]: () => appAtomRegistry.set(pluginUiChoicesAtom, new Map()) };
}

const surface = () => (
  <AppAtomRegistryProvider>
    <PluginPanelSurface
      environmentId={environmentId}
      threadId="thread-1"
      pluginId="hello-web"
      panel="hello"
      onClose={() => {}}
    />
  </AppAtomRegistryProvider>
);

describe("PluginPanelSurface", () => {
  it("renders a plugin's panel, then a notice with a way out once the plugin unloads", async () => {
    using _setup = setup();
    setList([helloWeb("active")]);
    const unregister = registerPluginRightPanel({
      environmentId,
      pluginId: "hello-web",
      owner: { environmentId, pluginId: "hello-web", pluginName: "Hello web" },
      name: "hello",
      title: "Hello panel",
      component: (props) => <p>Panel for {props.threadId}</p>,
    });
    using _panel = { [Symbol.dispose]: unregister };
    await using _screen = await render(surface());

    await expect.element(page.getByText("Panel for thread-1")).toBeVisible();
    setList([helloWeb("disabled")]);
    unregister();
    await expect.element(page.getByText("Plugin not active")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Close" })).toBeVisible();
  });

  it("shows a restored panel loading while its plugin starts, not a false notice", async () => {
    using _setup = setup();
    await using _screen = await render(surface());

    await expect.element(page.getByText("Loading plugin")).toBeVisible();
    setList([helloWeb("active")]);
    await expect.element(page.getByText('Hello web is loading its "hello" panel.')).toBeVisible();
    // A web part that fails to load is not coming, so the wait ends.
    setPluginWebFailure(environmentId, "hello-web", "boom");
    await expect.element(page.getByText("Plugin not active")).toBeVisible();
  });
});
