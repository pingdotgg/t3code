/**
 * The Claude capabilities probe spawns a `claude` process to read account,
 * slash-command and usage metadata. Its result depends only on the binary,
 * the config directory, the working directory and the instance environment,
 * so instances that agree on those would spawn identical probes. This
 * service keeps one TTL cache for the whole server, keyed on those inputs,
 * so such instances share one probe per TTL instead of one each.
 *
 * @module provider/Layers/claudeCapabilitiesProbeCache
 */
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { ClaudeCapabilitiesProbe } from "./ClaudeProvider.ts";

const CAPABILITIES_PROBE_TTL = Duration.minutes(5);

type Probe = Effect.Effect<ClaudeCapabilitiesProbe | undefined>;

export class ClaudeCapabilitiesProbeCache extends Context.Service<
  ClaudeCapabilitiesProbeCache,
  {
    /** Cached probe result for `key`, running `probe` when missing or expired. */
    readonly get: (key: string, probe: Probe) => Probe;
    /** Drop `key` so the next `get` probes again, for every instance sharing it. */
    readonly invalidate: (key: string) => Effect.Effect<void>;
  }
>()("t3/provider/Layers/claudeCapabilitiesProbeCache") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  // Equal keys mean equivalent probes, so whichever instance asked last
  // supplies the probe the lookup runs.
  const probes = new Map<string, Probe>();
  const cache = yield* Cache.make({
    capacity: 256,
    timeToLive: CAPABILITIES_PROBE_TTL,
    lookup: (key: string) => Effect.suspend(() => probes.get(key) ?? Effect.succeed(undefined)),
  });

  return {
    get: (key, probe) =>
      Effect.suspend(() => {
        probes.set(key, probe);
        return Cache.get(cache, key);
      }),
    invalidate: (key) => Cache.invalidate(cache, key),
  } satisfies ClaudeCapabilitiesProbeCache["Service"];
});

export const layer = Layer.effect(ClaudeCapabilitiesProbeCache, make);
