import { type PluginInfo, PluginId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { AsyncResult } from "effect/unstable/reactivity";

import {
  keepLastKnownPluginList,
  makePluginListStream,
  pluginRpc,
  resolvePluginListWithCache,
} from "./plugins";

const pluginId = PluginId.make("fixture-plugin");

describe("web plugin state", () => {
  it.effect("loads plugin list initially and refreshes on every server-lifecycle event", () =>
    Effect.gen(function* () {
      let calls = 0;
      const lists = yield* makePluginListStream(
        Stream.make(
          // A `ready` event is the reconnect signal (replayed to every new
          // subscriber), so it must trigger a reload — not only `plugin-state-changed`.
          {
            version: 1 as const,
            sequence: 1,
            type: "ready" as const,
            payload: { at: "2026-07-03T00:00:00.000Z", environment: {} as never },
          },
          {
            version: 1 as const,
            sequence: 2,
            type: "plugins" as const,
            payload: {
              kind: "plugin-state-changed" as const,
              pluginId,
              state: "active" as const,
            },
          },
        ),
        Effect.sync(() => {
          calls += 1;
          return [
            {
              id: pluginId,
              name: "Fixture",
              version: "1.0.0",
              state: "active" as const,
              capabilities: [],
              hasWeb: true,
              lastError: null,
            },
          ];
        }),
      ).pipe(Stream.runCollect);

      // Initial eager load + reload on `ready` + reload on `plugins` = 3.
      expect(calls).toBe(3);
      expect(Array.from(lists)).toHaveLength(3);
    }),
  );

  it.effect("keeps the last known plugin list across failed refreshes", () =>
    Effect.gen(function* () {
      const pluginA: PluginInfo = {
        id: pluginId,
        name: "A",
        version: "1.0.0",
        state: "active",
        capabilities: [],
        hasWeb: true,
        lastError: null,
      };
      const pluginB: PluginInfo = { ...pluginA, name: "B", version: "2.0.0" };
      const listA: ReadonlyArray<PluginInfo> = [pluginA];
      const listB: ReadonlyArray<PluginInfo> = [pluginB];

      const emitted = yield* keepLastKnownPluginList(
        Stream.make(
          Option.some(listA), // first successful load
          Option.none<ReadonlyArray<PluginInfo>>(), // failed refresh -> keep listA
          Option.some(listB), // successful refresh -> listB
          Option.none<ReadonlyArray<PluginInfo>>(), // failed refresh -> keep listB
        ),
      ).pipe(Stream.runCollect);

      expect(Array.from(emitted)).toEqual([listA, listA, listB, listB]);

      // A transient failure BEFORE any success emits nothing, so the underlying
      // result atom keeps its previous value (and the persistent per-env cache is
      // not overwritten with a spurious empty list).
      const emittedInitialFailure = yield* keepLastKnownPluginList(
        Stream.make(
          Option.none<ReadonlyArray<PluginInfo>>(), // initial load failed -> emit nothing
          Option.none<ReadonlyArray<PluginInfo>>(), // still failing -> emit nothing
          Option.some(listA), // first success -> listA
          Option.none<ReadonlyArray<PluginInfo>>(), // failed refresh -> keep listA
        ),
      ).pipe(Stream.runCollect);

      expect(Array.from(emittedInitialFailure)).toEqual([listA, listA]);
    }),
  );

  it("keeps the last successful plugin list across transient non-success results", () => {
    const pluginA: PluginInfo = {
      id: pluginId,
      name: "A",
      version: "1.0.0",
      state: "active",
      capabilities: [],
      hasWeb: true,
      lastError: null,
    };
    const listA: ReadonlyArray<PluginInfo> = [pluginA];
    const cache = new Map<string, ReadonlyArray<PluginInfo>>();
    const env = "env-1";

    // No cache yet + a non-success (Initial) result -> empty.
    expect(resolvePluginListWithCache(env, AsyncResult.initial<ReadonlyArray<PluginInfo>>(), cache)).toEqual([]);
    // A successful load returns the list and seeds the cache.
    expect(resolvePluginListWithCache(env, AsyncResult.success<ReadonlyArray<PluginInfo>>(listA), cache)).toEqual(listA);
    // A transient blip (result reset to Initial) keeps the last known list.
    expect(resolvePluginListWithCache(env, AsyncResult.initial<ReadonlyArray<PluginInfo>>(), cache)).toEqual(listA);
    // A genuine empty (successful) load clears it.
    expect(
      resolvePluginListWithCache(env, AsyncResult.success<ReadonlyArray<PluginInfo>>([]), cache),
    ).toEqual([]);
    // ...and a subsequent blip keeps the (now empty) last known list.
    expect(resolvePluginListWithCache(env, AsyncResult.initial<ReadonlyArray<PluginInfo>>(), cache)).toEqual([]);
  });

  it("binds plugin RPC helpers to one plugin id", () => {
    const calls: Array<readonly [PluginId, string, unknown]> = [];
    const rpc = pluginRpc(pluginId, {
      call: (id, method, payload) => {
        calls.push([id, method, payload] as const);
        return Promise.resolve({ ok: true });
      },
      subscribe: (id, method, payload) => Stream.make({ id, method, payload }),
    });

    void rpc.call("echo", { value: 1 });

    expect(calls).toEqual([[pluginId, "echo", { value: 1 }]]);
  });
});
