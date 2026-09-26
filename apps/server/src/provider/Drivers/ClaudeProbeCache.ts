/**
 * One server-wide cache for the Claude capabilities probe. Claude instances
 * with the same probe input read the same account, so they share one cached
 * result, and concurrent reads of one input join one SDK probe. Each entry
 * keeps 5 minutes, a failed probe (`undefined`) included, like the old
 * per-instance cache.
 *
 * @module provider/Drivers/ClaudeProbeCache
 */
import type { ClaudeSettings, ProviderInstanceEnvironment } from "@t3tools/contracts";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Layer from "effect/Layer";

import { type ClaudeCapabilitiesProbe, probeClaudeCapabilities } from "../Layers/ClaudeProvider.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";

/**
 * Every instance input the probe reads, and also the cache key. The lookup
 * gets only this value, so the probe cannot read an input the key leaves out.
 * Keys compare structurally.
 */
export type ClaudeProbeInput = Pick<ClaudeSettings, "binaryPath" | "homePath"> & {
  readonly cwd: string;
  readonly environment: ProviderInstanceEnvironment;
};

export class ClaudeProbeCache extends Context.Service<
  ClaudeProbeCache,
  Cache.Cache<ClaudeProbeInput, ClaudeCapabilitiesProbe | undefined>
>()("t3/provider/Drivers/ClaudeProbeCache") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Cache.make({
  // Far above any real input count. Each refresh reads keys in the same
  // order, so a cap below the live key count would re-probe every key.
  capacity: 256,
  timeToLive: Duration.minutes(5),
  lookup: (input: ClaudeProbeInput) =>
    probeClaudeCapabilities(input, mergeProviderInstanceEnvironment(input.environment), input.cwd),
});

export const layer = Layer.effect(ClaudeProbeCache, make);
