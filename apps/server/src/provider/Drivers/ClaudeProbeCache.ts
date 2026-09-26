/**
 * One server-wide cache for the Claude capabilities probe. Claude instances
 * whose probe inputs match (same binary, home, cwd and instance env vars)
 * read the same account, so they share one cached result instead of each
 * starting its own SDK session. A small gate limits how many SDK probes run
 * at once across all instances.
 *
 * @module provider/Drivers/ClaudeProbeCache
 */
import type { ClaudeSettings, ProviderInstanceEnvironment } from "@t3tools/contracts";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";

import { type ClaudeCapabilitiesProbe, probeClaudeCapabilities } from "../Layers/ClaudeProvider.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";

/**
 * Every instance input the probe reads, and also the cache key. The lookup
 * gets only this value, so the probe cannot depend on an input the key leaves
 * out. Keys compare structurally.
 */
export type ClaudeProbeInput = Pick<ClaudeSettings, "binaryPath" | "homePath"> & {
  readonly cwd: string;
  readonly environment: ProviderInstanceEnvironment;
};

const PROBE_TTL = Duration.minutes(5);
// A failed probe or usage read leaves every instance with that input unverified
// or without limits, so retry soon.
const FAILED_PROBE_TTL = Duration.seconds(30);
const MAX_CONCURRENT_PROBES = 3;
// Keep this far above any real instance count. The cache evicts the least
// recently used key, and every refresh reads the keys in the same order, so a
// cap below the live key count makes each refresh re-probe every instance.
// Stale keys only come from instance edits, and entries are small.
const MAX_CACHED_PROBES = 1024;

export class ClaudeProbeCache extends Context.Service<
  ClaudeProbeCache,
  {
    /** Cached probe result for `input`, or `undefined` when the probe failed. */
    readonly capabilities: (
      input: ClaudeProbeInput,
    ) => Effect.Effect<ClaudeCapabilitiesProbe | undefined>;
    /** Drop the result for `input`, so the next read probes again. */
    readonly invalidate: (input: ClaudeProbeInput) => Effect.Effect<void>;
  }
>()("t3/provider/Drivers/ClaudeProbeCache") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const gate = yield* Semaphore.make(MAX_CONCURRENT_PROBES);
  // The probe keeps its own timeout inside the gate, so time spent waiting
  // for a permit cannot turn into a false failure.
  const cache = yield* Cache.makeWith(
    (input: ClaudeProbeInput) =>
      gate.withPermits(1)(
        probeClaudeCapabilities(
          input,
          mergeProviderInstanceEnvironment(input.environment),
          input.cwd,
        ),
      ),
    {
      capacity: MAX_CACHED_PROBES,
      timeToLive: (exit) =>
        Exit.isSuccess(exit) && exit.value?.usage !== undefined ? PROBE_TTL : FAILED_PROBE_TTL,
    },
  );
  return {
    capabilities: (input) => Cache.get(cache, input),
    invalidate: (input) => Cache.invalidate(cache, input),
  } satisfies ClaudeProbeCache["Service"];
});

export const layer = Layer.effect(ClaudeProbeCache, make);
