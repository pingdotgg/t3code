/**
 * The Claude capabilities probe spawns a `claude` process to read account,
 * slash-command and usage metadata. Its result depends only on the binary,
 * the config directory, the working directory and the instance environment,
 * so instances that agree on those would spawn identical probes. This
 * service keeps one TTL cache for the whole server, keyed on those inputs,
 * so such instances share one successful probe per TTL instead of one each.
 *
 * @module provider/Layers/claudeCapabilitiesProbeCache
 */
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Exit from "effect/Exit";
import * as Hash from "effect/Hash";
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

/**
 * Compares by `key` alone, so equal keys hit one entry, while the probe rides
 * along for the lookup and is released when the bounded cache drops the entry.
 */
class ProbeKey implements Equal.Equal {
  readonly key: string;
  readonly probe: Probe;

  constructor(key: string, probe: Probe) {
    this.key = key;
    this.probe = probe;
  }

  [Equal.symbol](that: unknown): boolean {
    return that instanceof ProbeKey && that.key === this.key;
  }
  [Hash.symbol](): number {
    return Hash.string(this.key);
  }
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  // A failed probe (undefined) is not cached, so one instance's failure never
  // stands in for its siblings' next check.
  const cache = yield* Cache.makeWith((key: ProbeKey) => key.probe, {
    capacity: 256,
    timeToLive: (exit) =>
      Exit.isSuccess(exit) && exit.value !== undefined ? CAPABILITIES_PROBE_TTL : Duration.zero,
  });

  return {
    get: (key, probe) => Cache.get(cache, new ProbeKey(key, probe)),
    invalidate: (key) => Cache.invalidate(cache, new ProbeKey(key, Effect.undefined)),
  } satisfies ClaudeCapabilitiesProbeCache["Service"];
});

export const layer = Layer.effect(ClaudeCapabilitiesProbeCache, make);
