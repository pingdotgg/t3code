import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import * as ClaudeCapabilitiesProbeCache from "./claudeCapabilitiesProbeCache.ts";

const signedIn = {
  email: "dev@example.com",
  subscriptionType: "max",
  tokenSource: undefined,
  apiProvider: "firstParty",
  slashCommands: [],
};

describe("ClaudeCapabilitiesProbeCache", () => {
  it.effect("runs one probe per key until the key is invalidated", () =>
    Effect.gen(function* () {
      const cache = yield* ClaudeCapabilitiesProbeCache.ClaudeCapabilitiesProbeCache;
      const probes = yield* Ref.make<ReadonlyArray<string>>([]);
      const probe = (label: string) =>
        Ref.update(probes, (seen) => [...seen, label]).pipe(Effect.as(signedIn));

      // Two instances on the same binary and home share one probe.
      yield* cache.get("claude\0/home/a", probe("first instance"));
      yield* cache.get("claude\0/home/a", probe("second instance"));
      // A different home is a different account and probes on its own.
      yield* cache.get("claude\0/home/b", probe("other home"));
      yield* cache.invalidate("claude\0/home/a");
      yield* cache.get("claude\0/home/a", probe("after invalidate"));

      assert.deepStrictEqual(yield* Ref.get(probes), [
        "first instance",
        "other home",
        "after invalidate",
      ]);
    }).pipe(Effect.provide(ClaudeCapabilitiesProbeCache.layer)),
  );

  it.effect("does not cache a failed probe", () =>
    Effect.gen(function* () {
      const cache = yield* ClaudeCapabilitiesProbeCache.ClaudeCapabilitiesProbeCache;
      const runs = yield* Ref.make(0);
      const failedProbe = Ref.update(runs, (n) => n + 1).pipe(Effect.as(undefined));

      yield* cache.get("claude\0/home/a", failedProbe);
      yield* cache.get("claude\0/home/a", failedProbe);

      assert.strictEqual(yield* Ref.get(runs), 2);
    }).pipe(Effect.provide(ClaudeCapabilitiesProbeCache.layer)),
  );
});
