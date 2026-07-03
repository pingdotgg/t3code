import { PluginId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { makePluginListStream, pluginRpc } from "./plugins";

const pluginId = PluginId.make("fixture-plugin");

describe("web plugin state", () => {
  it.effect("loads plugin list initially and refreshes on plugin lifecycle changes", () =>
    Effect.gen(function* () {
      let calls = 0;
      const lists = yield* makePluginListStream(
        Stream.make(
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

      expect(calls).toBe(2);
      expect(Array.from(lists)).toHaveLength(2);
    }),
  );

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
