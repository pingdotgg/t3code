import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { AuthOrchestrationReadScope, PluginId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as EnvironmentTheme from "../environmentTheme.ts";
import type { DiscoveredPlugin } from "./pluginDiscovery.ts";
import { makePluginFailures } from "./pluginFailures.ts";
import { makePluginStates, type PluginRecord } from "./pluginStates.ts";

const held = PluginId.make("held");
const plugin: DiscoveredPlugin = {
  id: held,
  rootDir: "/plugins/held",
  folder: "/plugins/held",
  source: "installed",
  manifest: { id: held, name: "Held", version: "1.0.0", engines: { t3: ">=0.0.1" } },
};

it.layer(NodeServices.layer)("makePluginStates", (it) => {
  it.effect("sends a client that connects during a publish no list older than its first", () =>
    Effect.gen(function* () {
      const reached = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      // Only the first publish hands over a theme folder, and it holds there.
      const layerHeldThemes = Layer.mock(EnvironmentTheme.EnvironmentThemeService)({
        setPluginThemeDirectories: () =>
          Deferred.succeed(reached, undefined).pipe(Effect.andThen(Deferred.await(release))),
      });
      const records = yield* Ref.make<ReadonlyArray<PluginRecord>>([{ plugin, status: "loading" }]);
      const states = yield* makePluginStates({
        records,
        config: Effect.succeed({ enabled: { [held]: true } }),
        failures: yield* makePluginFailures,
      }).pipe(Effect.provide(layerHeldThemes));

      const publishing = yield* states.publish.pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(reached);
      // Changed after that publish read the records, so its own publish comes later.
      yield* Ref.set(records, [{ plugin, status: "active", revision: 1 }]);
      const seen = yield* Queue.unbounded<string>();
      yield* states.streamForClient([AuthOrchestrationReadScope]).pipe(
        Stream.runForEach(({ plugins }) => Queue.offer(seen, plugins[0]?.status ?? "none")),
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(publishing);
      const first = yield* Queue.take(seen);
      yield* Ref.set(records, [{ plugin, status: "disabled" }]);
      yield* states.publish;
      assert.deepStrictEqual([first, yield* Queue.take(seen)], ["active", "disabled"]);
    }),
  );
});
