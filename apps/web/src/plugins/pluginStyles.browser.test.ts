import { EnvironmentId, PluginId, type PluginState } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock(import("../state/session"), async (original) => ({
  ...(await original()),
  readPreparedConnection: (() => ({
    httpBaseUrl: "http://plugins.test/",
    httpAuthorization: { _tag: "Bearer", token: "token" },
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
    live: (environmentId: string) => {
      const atom = lives.get(environmentId) ?? makeLive();
      lives.set(environmentId, atom);
      return atom;
    },
    environments: Atom.make<ReadonlyArray<EnvironmentId>>([]).pipe(Atom.keepAlive),
  };
});
vi.mock(import("../state/plugins"), () => ({
  pluginEnvironment: {
    pluginsLive: ({ environmentId }: { readonly environmentId: string }) =>
      state.live(environmentId),
  } as never,
}));
vi.mock(import("./pluginFollow"), async (original) => ({
  ...(await original()),
  pluginUiEnvironmentsAtom: state.environments,
}));

import { appAtomRegistry } from "../rpc/atomRegistry";
import { startPluginStyles } from "./pluginStyles";

const stylesPluginState: PluginState = {
  id: PluginId.make("styles-plugin"),
  name: "styles-plugin",
  version: "0.1.0",
  permissions: [],
  source: "dev",
  enabled: true,
  status: "active",
  hasServer: false,
  hasWeb: false,
  hasSettings: false,
};

describe("startPluginStyles", () => {
  it("adds the stylesheets of a plugin that is on in order, from the first environment that has it on, swaps changed ones and removes them when it is off", async () => {
    // Each sheet names the file and revision it was fetched as.
    using fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input));
      return new Response(`/* ${url.pathname.split("/").pop()} ${url.searchParams.get("v")} */`);
    });
    const environmentId = EnvironmentId.make("environment:plugin-styles");
    const otherEnvironmentId = EnvironmentId.make("environment:plugin-styles-other");
    appAtomRegistry.set(state.environments, [environmentId, otherEnvironmentId]);
    const stylesPlugin: PluginState = {
      ...stylesPluginState,
      styles: [
        { file: "base.css", revision: "r1" },
        { file: "compact.css", revision: "r2" },
      ],
    };
    const sheets = () =>
      Array.from(document.querySelectorAll('style[data-plugin="styles-plugin"]'), (sheet) =>
        sheet.textContent?.trim(),
      );
    // The other environment has the plugin too, and starts first.
    appAtomRegistry.set(
      state.live(otherEnvironmentId),
      AsyncResult.success({ plugins: [stylesPlugin] }),
    );
    using _otherStyles = { [Symbol.dispose]: startPluginStyles(otherEnvironmentId) };
    appAtomRegistry.set(
      state.live(environmentId),
      AsyncResult.success({ plugins: [stylesPlugin] }),
    );
    const stop = startPluginStyles(environmentId);
    using _styles = { [Symbol.dispose]: stop };

    await vi.waitFor(() => expect(sheets()).toEqual(["/* base.css r1 */", "/* compact.css r2 */"]));
    // After the app's own styles, so a rule of the same specificity wins.
    expect(document.head.lastElementChild?.textContent).toBe("/* compact.css r2 */");
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(
      "http://plugins.test/api/plugins/styles-plugin/styles/base.css?v=r1",
    );
    expect(fetchSpy.mock.calls[0]?.[1]).toEqual({ headers: { authorization: "Bearer token" } });

    appAtomRegistry.set(
      state.live(environmentId),
      AsyncResult.success({
        plugins: [
          {
            ...stylesPlugin,
            styles: [
              { file: "base.css", revision: "r1" },
              { file: "compact.css", revision: "r3" },
            ],
          },
        ],
      }),
    );
    await vi.waitFor(() => expect(sheets()).toEqual(["/* base.css r1 */", "/* compact.css r3 */"]));

    const otherFetches = fetchSpy.mock.calls.length;
    appAtomRegistry.set(
      state.live(environmentId),
      AsyncResult.success({
        plugins: [{ ...stylesPluginState, enabled: false, status: "disabled" }],
      }),
    );
    // Off in the first environment, the plugin's styles come from the other one.
    await vi.waitFor(() => expect(sheets()).toEqual(["/* base.css r1 */", "/* compact.css r2 */"]));
    expect(fetchSpy.mock.calls.length).toBe(otherFetches + 2);

    appAtomRegistry.set(
      state.live(environmentId),
      AsyncResult.success({ plugins: [stylesPlugin] }),
    );
    await vi.waitFor(() => expect(sheets()).toEqual(["/* base.css r1 */", "/* compact.css r2 */"]));
    stop();
    expect(sheets()).toEqual([]);
  });
});
