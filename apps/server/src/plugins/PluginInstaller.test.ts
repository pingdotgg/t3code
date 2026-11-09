import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { PluginId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import type { DiscoveredPlugin } from "./pluginDiscovery.ts";
import { PluginNotFoundError } from "./PluginHost.ts";
import * as PluginInstaller from "./PluginInstaller.ts";
import * as PluginSettingsStore from "./PluginSettingsStore.ts";
import * as PluginStorage from "./PluginStorage.ts";

const linked = PluginId.make("linked");
const linkedCopy: DiscoveredPlugin = {
  id: linked,
  rootDir: "/plugins/linked",
  folder: "/plugins/linked",
  source: "dev",
  manifest: { id: linked, name: "Linked", version: "1.0.0", engines: { t3: ">=0.0.1" } },
};

/**
 * A host holding one linked plugin, whose lifecycle lock records whether it is held, and stores
 * that record what they deleted and whether the lock was held then.
 */
const harness = Effect.fn(function* () {
  let locked = false;
  const cleared: Array<{ readonly what: string; readonly locked: boolean }> = [];
  const host: PluginInstaller.PluginInstallerHost = {
    lifecycle: (body) =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          locked = true;
        }),
        () => body,
        () =>
          Effect.sync(() => {
            locked = false;
          }),
      ),
    plugins: Effect.succeed([linkedCopy]),
    pluginOf: (pluginId) =>
      pluginId === linked
        ? Effect.succeed(linkedCopy)
        : Effect.fail(new PluginNotFoundError({ pluginId })),
    stop: () => Effect.void,
    rescan: Effect.void,
    reload: (pluginId) => Effect.fail(new PluginNotFoundError({ pluginId })),
    config: Effect.succeed({}),
    writeConfig: () => Effect.void,
  };
  const { installer } = yield* PluginInstaller.make(host).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(PluginSettingsStore.PluginSettingsStore)({
          clear: () => Effect.sync(() => cleared.push({ what: "settings", locked })),
        }),
        Layer.mock(PluginStorage.PluginStorage)({
          clear: () => Effect.sync(() => cleared.push({ what: "storage", locked })),
        }),
        ServerConfig.layerTest(process.cwd(), { prefix: "t3code-plugin-installer-test-" }),
      ),
    ),
  );
  return { installer, cleared };
});

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))("PluginInstaller", (it) => {
  it.effect("deletes a removed plugin's data before another plugin change can start", () =>
    Effect.gen(function* () {
      const { installer, cleared } = yield* harness();
      yield* installer.uninstall(linked);
      assert.deepStrictEqual(cleared, [
        { what: "settings", locked: true },
        { what: "storage", locked: true },
      ]);
    }),
  );
});
