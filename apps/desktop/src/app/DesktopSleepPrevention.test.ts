import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ElectronPowerSaveBlocker from "../electron/ElectronPowerSaveBlocker.ts";
import { setClientSettings } from "../ipc/methods/clientSettings.ts";
import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";
import * as DesktopSleepPrevention from "./DesktopSleepPrevention.ts";

function makeTestLayer(initiallyEnabled: boolean) {
  const calls: string[] = [];
  const started = new Set<number>();
  let nextId = 0;
  const powerSaveBlocker = ElectronPowerSaveBlocker.make({
    start: (type) => {
      const id = nextId++;
      started.add(id);
      calls.push(`start:${type}:${id}`);
      return id;
    },
    stop: (id) => {
      calls.push(`stop:${id}`);
      return started.delete(id);
    },
    isStarted: (id) => started.has(id),
  });
  const settings = {
    ...DEFAULT_CLIENT_SETTINGS,
    preventSleepForRemoteConnections: initiallyEnabled,
  };

  return {
    calls,
    layer: Layer.mergeAll(
      DesktopClientSettings.layerTest(Option.some(settings)),
      Layer.succeed(ElectronPowerSaveBlocker.ElectronPowerSaveBlocker, powerSaveBlocker),
    ),
  };
}

describe("DesktopSleepPrevention", () => {
  it.effect("restores the persisted assertion before a renderer is involved", () => {
    const { calls, layer } = makeTestLayer(true);

    return Effect.gen(function* () {
      yield* DesktopSleepPrevention.restore();
      assert.deepStrictEqual(calls, ["start:prevent-app-suspension:0"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("applies preference changes after the desktop settings write", () => {
    const { calls, layer } = makeTestLayer(false);
    const enabledSettings = {
      ...DEFAULT_CLIENT_SETTINGS,
      preventSleepForRemoteConnections: true,
    };

    return Effect.gen(function* () {
      yield* setClientSettings.handler(enabledSettings);

      const clientSettings = yield* DesktopClientSettings.DesktopClientSettings;
      const persistedSettings = yield* clientSettings.get;
      assert.isTrue(Option.getOrThrow(persistedSettings).preventSleepForRemoteConnections);
      assert.deepStrictEqual(calls, ["start:prevent-app-suspension:0"]);
    }).pipe(Effect.provide(layer));
  });
});
