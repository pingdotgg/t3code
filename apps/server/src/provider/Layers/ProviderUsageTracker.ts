/**
 * ProviderUsageTracker - projects `account.rate-limits.updated` runtime
 * events onto `ServerProvider.usage`.
 *
 * Subscribes to the canonical runtime event stream, normalizes each
 * provider's native rate-limit payload (Claude SDK `rate_limit_event`,
 * Codex `account/rateLimits/updated`) into the `ServerProviderUsage`
 * contract shape, and hands the merged result to the provider registry,
 * which broadcasts it to clients through the existing provider status
 * stream.
 *
 * @module ProviderUsageTracker
 */
import { defaultInstanceIdForDriver, ProviderDriverKind } from "@t3tools/contracts";
import type { ProviderRuntimeEvent } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { ProviderRegistry } from "../Services/ProviderRegistry.ts";
import { ProviderService } from "../Services/ProviderService.ts";
import { applyClaudeRateLimitEvent, applyCodexRateLimitEvent } from "../providerUsage.ts";

const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");
const CODEX_DRIVER = ProviderDriverKind.make("codex");

export const ProviderUsageTrackerLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const providerService = yield* ProviderService;
    const providerRegistry = yield* ProviderRegistry;

    const trackRateLimits = Effect.fn("trackRateLimits")(function* (
      event: Extract<ProviderRuntimeEvent, { type: "account.rate-limits.updated" }>,
    ) {
      const instanceId = event.providerInstanceId ?? defaultInstanceIdForDriver(event.provider);
      const providers = yield* providerRegistry.getProviders;
      const previous = providers.find((candidate) => candidate.instanceId === instanceId)?.usage;
      const nowIso = DateTime.formatIso(yield* DateTime.now);
      const usage =
        event.provider === CLAUDE_DRIVER
          ? applyClaudeRateLimitEvent(previous, event.payload, nowIso)
          : event.provider === CODEX_DRIVER
            ? applyCodexRateLimitEvent(previous, event.payload, nowIso)
            : undefined;
      if (!usage) {
        return;
      }
      yield* providerRegistry.setProviderInstanceUsage({ instanceId, usage });
    });

    yield* providerService.streamEvents.pipe(
      Stream.filter(
        (event): event is Extract<ProviderRuntimeEvent, { type: "account.rate-limits.updated" }> =>
          event.type === "account.rate-limits.updated",
      ),
      Stream.runForEach((event) =>
        trackRateLimits(event).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("provider usage tracking failed for rate-limit event", cause),
          ),
        ),
      ),
      Effect.forkScoped,
    );
  }),
);
