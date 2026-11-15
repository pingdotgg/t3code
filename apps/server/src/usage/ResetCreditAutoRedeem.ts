/** Spends a reset credit for opted-in accounts shortly before it expires unused. */
import {
  isResetCreditExpiringSoon,
  type ProviderConsumeResetCreditInput,
  type ProviderConsumeResetCreditOutcome,
  resetCreditAccountKey,
  type ServerProviderResetCredits,
  type UsageLimitSourceError,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";

import type { ProviderDriverError } from "../provider/Errors.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as Settings from "../serverSettings.ts";
import * as UsageLimitSources from "./UsageLimitSources.ts";

interface Candidate {
  readonly input: ProviderConsumeResetCreditInput;
  readonly credits: ServerProviderResetCredits | undefined;
  readonly redeem: Effect.Effect<
    ProviderConsumeResetCreditOutcome,
    ProviderDriverError | UsageLimitSourceError
  >;
}

// A redemption can succeed while its re-probe fails, leaving a stale snapshot; one attempt per
// credit keeps that from spending a second one. ponytail: no retry after a transient failure.
const attemptSignature = (candidate: Candidate) =>
  `${resetCreditAccountKey(candidate.input)}@${candidate.credits?.nextExpiresAt}#${candidate.credits?.availableCount}`;

const check = Effect.fn("ResetCreditAutoRedeem.check")(function* (attempted: Set<string>) {
  const settings = yield* (yield* Settings.ServerSettingsService).getSettings;
  const enabled = settings.resetCreditAutoRedeem;
  if (!Object.values(enabled).some(Boolean)) return;

  const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const hubs = yield* UsageLimitSources.UsageLimitSources;
  const candidates: Array<Candidate> = [];
  for (const instance of yield* registry.listInstances) {
    const consume = instance.consumeResetCredit;
    if (!instance.enabled || !consume) continue;
    const credits = (yield* instance.snapshot.getSnapshot).usageLimits?.resetCredits;
    candidates.push({
      input: { instanceId: instance.instanceId },
      credits,
      // The expiring credit is the next one; drivers without credit ids ignore it.
      redeem: consume(credits?.nextCreditId),
    });
  }
  for (const source of yield* hubs.current) {
    for (const account of source.accounts) {
      const creditId = account.usageLimits.resetCredits?.nextCreditId;
      if (!creditId) continue;
      const input = { sourceId: source.id, accountId: account.id, creditId };
      candidates.push({
        input,
        credits: account.usageLimits.resetCredits,
        redeem: hubs.consumeResetCredit(input).pipe(Effect.map((result) => result.outcome)),
      });
    }
  }

  const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
  yield* Effect.forEach(
    candidates.filter(
      (candidate) =>
        enabled[resetCreditAccountKey(candidate.input)] === true &&
        isResetCreditExpiringSoon(candidate.credits, nowMs) &&
        !attempted.has(attemptSignature(candidate)),
    ),
    (candidate) =>
      Effect.sync(() => attempted.add(attemptSignature(candidate))).pipe(
        Effect.andThen(candidate.redeem),
        Effect.tap((outcome) =>
          Effect.logInfo("auto-redeemed expiring reset credit", {
            account: resetCreditAccountKey(candidate.input),
            outcome,
          }),
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("auto-redeem of expiring reset credit failed", {
            account: resetCreditAccountKey(candidate.input),
            cause,
          }),
        ),
      ),
    { discard: true },
  );
});

// One-minute checks are far inside the 30-minute lead, so a slow probe cannot skip a credit.
export const layer = Layer.effectDiscard(
  Effect.suspend(() => {
    const attempted = new Set<string>();
    return check(attempted).pipe(
      Effect.ignoreCause({ log: true }),
      Effect.repeat(Schedule.spaced("1 minute")),
      Effect.forkScoped,
    );
  }),
);
