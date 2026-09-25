import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import * as ClaudeCapabilitiesProbeCache from "./claudeCapabilitiesProbeCache.ts";

describe("ClaudeCapabilitiesProbeCache", () => {
  it.effect("runs one probe per key until the key is invalidated", () =>
    Effect.gen(function* () {
      const cache = yield* ClaudeCapabilitiesProbeCache.ClaudeCapabilitiesProbeCache;
      const probes = yield* Ref.make<ReadonlyArray<string>>([]);
      const probe = (label: string) =>
        Ref.update(probes, (seen) => [...seen, label]).pipe(Effect.as(undefined));

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
});
