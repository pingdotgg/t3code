import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type * as EffectAcpErrors from "effect-acp/errors";
import type { ProviderUsageLimitsReport } from "@t3tools/provider-core/server/snapshot";
import { clampPercent } from "@t3tools/provider-core/server/usageLimits";

/** The `account/read` result's monthly Vibe Code budget; everything else is ignored. */
const MistralVibeAccountRead = Schema.Struct({
  budget: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        usagePercentage: Schema.Number,
        resetAt: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
});

const decodeAccountRead = Schema.decodeUnknownOption(MistralVibeAccountRead);

/** A null budget (non-Mistral model, no billing permission, self-hosted) yields no window. */
export function mistralVibeAccountToUsageLimits(
  accountRead: unknown,
  checkedAt: string,
): ProviderUsageLimitsReport | undefined {
  const budget = Option.getOrUndefined(decodeAccountRead(accountRead))?.budget;
  if (budget === undefined || budget === null) return undefined;
  const resetMs = budget.resetAt ? Date.parse(budget.resetAt) : Number.NaN;
  return {
    checkedAt,
    windows: [
      {
        id: "monthly-budget",
        kind: "monthly",
        label: "Monthly Vibe Code budget",
        usedPercent: clampPercent(budget.usagePercentage),
        ...(Number.isFinite(resetMs)
          ? { resetsAt: DateTime.formatIso(DateTime.makeUnsafe(resetMs)) }
          : {}),
      },
    ],
  };
}

/** Reads the budget from a live session and reports it; a failed read or an old agent reports nothing. */
export const readMistralVibeUsageLimits = Effect.fn("MistralVibe.readUsageLimits")(
  function* (input: {
    readonly runtime: {
      readonly requestExt: (
        method: string,
        params: unknown,
      ) => Effect.Effect<unknown, EffectAcpErrors.AcpError>;
    };
    readonly sessionId: string;
    readonly onUsageLimits: (report: ProviderUsageLimitsReport) => Effect.Effect<void>;
  }) {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const accountRead = yield* input.runtime.requestExt("_account/read", {
      sessionId: input.sessionId,
    });
    const report = mistralVibeAccountToUsageLimits(accountRead, checkedAt);
    if (report !== undefined) yield* input.onUsageLimits(report);
  },
  (effect) => effect.pipe(Effect.ignore),
);
