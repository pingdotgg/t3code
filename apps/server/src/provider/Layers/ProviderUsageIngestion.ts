/**
 * ProviderUsageIngestionLive — the free usage feed.
 *
 * Both the Claude and Codex adapters already emit
 * `account.rate-limits.updated` whenever the upstream harness volunteers a
 * fresh quota reading, which in practice is at the end of every turn. Until
 * now nothing consumed those events. This layer routes them into
 * `ProviderUsageLimitsStore`, which costs zero additional network calls and
 * keeps the meters current for anyone actively working.
 *
 * @module ProviderUsageIngestionLive
 */
import { ProviderDriverKind, type ProviderRuntimeEvent } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { ProviderService } from "../Services/ProviderService.ts";
import { ProviderUsageLimitsStore } from "../ProviderUsageLimits.ts";
import { normalizeClaudeRateLimitEvent, normalizeCodexUsage } from "../usageLimits.ts";

// Driver kind slugs, not display names: Claude's driver is `claudeAgent`.
const CLAUDE_AGENT = ProviderDriverKind.make("claudeAgent");
const CODEX = ProviderDriverKind.make("codex");

/**
 * Which normalizer applies is a function of the driver that produced the
 * event, not of the payload's shape — the two vocabularies overlap enough
 * that sniffing would be guesswork. Drivers with no usage reporting yield
 * `null` and the event is dropped, same as before this layer existed.
 *
 * Both feeds are `partial`. Claude's SDK event describes exactly one bucket,
 * and Codex documents `account/rateLimits/updated` as a sparse rolling
 * update that clients must merge. Treating either as a full reading would
 * blank whichever meters the event happened not to mention.
 */
export const normalizeRuntimeUsageEvent = (
  event: Extract<ProviderRuntimeEvent, { type: "account.rate-limits.updated" }>,
  updatedAt: string,
) => {
  if (event.provider === CLAUDE_AGENT) {
    return normalizeClaudeRateLimitEvent(event.payload.rateLimits, updatedAt);
  }
  if (event.provider === CODEX) {
    return normalizeCodexUsage(event.payload.rateLimits, updatedAt);
  }
  return null;
};

export const ProviderUsageIngestionLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const providerService = yield* ProviderService;
    const usageStore = yield* ProviderUsageLimitsStore;

    yield* Stream.runForEach(providerService.streamEvents, (event) =>
      Effect.gen(function* () {
        if (event.type !== "account.rate-limits.updated") {
          return;
        }
        // Pre-instance-migration emitters may omit the routing key. Usage is
        // account-level state hung off one configured instance, so without
        // an instance id there is nowhere correct to put it.
        const instanceId = event.providerInstanceId;
        if (instanceId === undefined) {
          return;
        }
        const updatedAt = DateTime.formatIso(yield* DateTime.now);
        const usage = normalizeRuntimeUsageEvent(event, updatedAt);
        if (usage === null) {
          return;
        }
        // Guard against the same rebuild race as the OAuth pull: an event
        // emitted by the old instance's session can still be in this stream
        // when the instance is rebuilt and the store cleared. The snapshot
        // taken here is the newest possible one for this event — anything
        // older than the current generation belongs to a configuration that
        // no longer exists.
        const generation = yield* usageStore.generation(instanceId);
        yield* usageStore.set(instanceId, usage, "partial", { ifGenerationIs: generation });
      }).pipe(
        // Per event, not per subscription. `streamEvents` cannot fail and only
        // ends when the service scope closes, so the fiber's real risk is a
        // defect thrown while handling one event — which would otherwise take
        // the whole feed down for the life of the process and leave every
        // meter frozen with nothing logged at the point of failure. Same
        // stance as the on-demand pull: a reading we cannot take is ambient,
        // so drop it and keep listening.
        Effect.ignoreCause({ log: true }),
      ),
    ).pipe(Effect.forkScoped);
  }),
);
