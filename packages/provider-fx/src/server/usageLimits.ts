import type { ServerProviderUsageLimits } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";

// Vercel reports only the credit left. A pass refills to this each billing period, and a pass
// bought mid-period starts with a prorated share, so its first period reads as partly used.
const TOKEN_PASS_PERIOD_CREDIT_USD = 150;

/**
 * `fx credits --json`, fx 0.0.17+. `token_pass` is null for a team without an
 * active pass and absent on an older fx. `remaining` is US dollars, or null
 * when AI Gateway could not read the credit.
 */
const FxCredits = Schema.fromJsonString(
  Schema.Struct({
    error: Schema.optional(Schema.String),
    token_pass: Schema.optional(
      Schema.NullOr(
        Schema.Struct({
          remaining: Schema.optional(Schema.NullOr(Schema.String)),
          resets_at: Schema.optional(Schema.NullOr(Schema.String)),
        }),
      ),
    ),
  }),
);
const decodeFxCredits = Schema.decodeUnknownOption(FxCredits);

/** The Token Pass credit of the Vercel team fx is signed in to, as one Limits window. */
export function fxCreditsToLimits(input: {
  /** Stdout of a successful `fx credits --json`, or none when it failed. */
  readonly credits: Option.Option<string>;
  readonly checkedAt: string;
  /** Every login on a team spends the same pass, so the team names the account. */
  readonly team: string | undefined;
}): ServerProviderUsageLimits {
  const { checkedAt } = input;
  const probeFailed = makeUnavailableUsageLimits({
    checkedAt,
    reason: "probeFailed",
    message: "fx could not read the Token Pass credit.",
  });
  const credits = Option.getOrUndefined(Option.flatMap(input.credits, decodeFxCredits));
  if (credits === undefined || credits.error !== undefined) return probeFailed;
  if (credits.token_pass === undefined || credits.token_pass === null) {
    return makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
  }
  const remaining = credits.token_pass.remaining?.trim();
  // The amounts fx passes on: an overdrawn pass is negative, and a bare point is allowed.
  if (!remaining || !/^-?(\d+\.?\d*|\.\d+)$/.test(remaining)) return probeFailed;
  const reset = DateTime.make(credits.token_pass.resets_at ?? "");
  return {
    ...makeUsageLimits({
      checkedAt,
      windows: [
        {
          id: "token_pass",
          kind: "monthly",
          label: "Token Pass",
          usedPercent: clampPercent(100 - (Number(remaining) / TOKEN_PASS_PERIOD_CREDIT_USD) * 100),
          ...(Option.isSome(reset) ? { resetsAt: DateTime.formatIso(reset.value) } : {}),
        },
      ],
    }),
    ...(input.team ? { credentialFingerprint: `vercel-team:${input.team}` } : {}),
  };
}
