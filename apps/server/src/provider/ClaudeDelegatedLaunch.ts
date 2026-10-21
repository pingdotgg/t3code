import { DelegatedQuotaScope } from "@t3tools/contracts";
import type { Query } from "@anthropic-ai/claude-agent-sdk";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { claudeUsageResponseToLimits } from "./claudeUsageLimits.ts";

export class ClaudeLaunchCapacityError extends Schema.TaggedError<ClaudeLaunchCapacityError>()(
  "ClaudeLaunchCapacityError",
  {
    code: Schema.Literals(["usage_limit", "delegated_capacity_unverified"]),
    quotaScope: Schema.optional(DelegatedQuotaScope),
  },
) {}

const isClaudeLaunchCapacityError = Schema.is(ClaudeLaunchCapacityError);

export function claudeRefusalScope(types: ReadonlyArray<string>): DelegatedQuotaScope {
  const distinct = [...new Set(types)];
  return distinct.length === 1 && /^seven_day_(opus|sonnet|haiku)$/.test(distinct[0]!)
    ? { type: "window", windowId: distinct[0]! }
    : { type: "account" };
}

const encodeAccountIdentity = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Tuple([Schema.String, Schema.NullOr(Schema.String), Schema.String, Schema.String]),
  ),
);

export const readClaudeLaunchAccount = Effect.fn("readClaudeLaunchAccount")(function* (
  query: Pick<Query, "accountInfo">,
  environment: NodeJS.ProcessEnv,
) {
  const endpoint = environment.ANTHROPIC_BASE_URL?.trim();
  if (
    (endpoint && !["https://api.anthropic.com", "https://api.anthropic.com/"].includes(endpoint)) ||
    environment.ANTHROPIC_API_KEY?.trim() ||
    environment.ANTHROPIC_AUTH_TOKEN?.trim()
  )
    return yield* new ClaudeLaunchCapacityError({ code: "delegated_capacity_unverified" });
  const account = yield* Effect.tryPromise(() => query.accountInfo());
  const email = account.email?.trim().toLowerCase();
  if (
    !email ||
    account.apiProvider !== "firstParty" ||
    !account.subscriptionType ||
    !account.tokenSource ||
    account.tokenSource === "none" ||
    (account.apiKeySource && account.apiKeySource !== "none")
  )
    return yield* new ClaudeLaunchCapacityError({ code: "delegated_capacity_unverified" });
  return {
    email,
    credentialFingerprint: encodeAccountIdentity([
      email,
      account.organization ?? null,
      account.subscriptionType,
      account.tokenSource,
    ]),
  };
});

export const verifyClaudeLaunchBinding = Effect.fn("verifyClaudeLaunchBinding")(
  function* (
    query: Pick<Query, "accountInfo" | "usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET">,
    domains: ReadonlyArray<string>,
    model: string,
    environment: NodeJS.ProcessEnv = {},
  ) {
    const account = yield* readClaudeLaunchAccount(query, environment);
    const usage = yield* Effect.tryPromise(() =>
      query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }),
    );
    const confirmed = yield* readClaudeLaunchAccount(query, environment);
    if (
      account.credentialFingerprint !== confirmed.credentialFingerprint ||
      !domains.includes(`claudeAgent:account:${account.email}`) ||
      !domains.includes(`claudeAgent:credential:${account.credentialFingerprint}`)
    )
      return yield* new ClaudeLaunchCapacityError({ code: "delegated_capacity_unverified" });
    if (
      [usage.rate_limits?.five_hour, usage.rate_limits?.seven_day].some(
        (w) =>
          !w ||
          typeof w.utilization !== "number" ||
          !Number.isFinite(w.utilization) ||
          w.utilization < 0 ||
          w.utilization > 100,
      )
    )
      return yield* new ClaudeLaunchCapacityError({ code: "delegated_capacity_unverified" });
    const { limits } = claudeUsageResponseToLimits({
      response: usage,
      checkedAt: DateTime.formatIso(yield* DateTime.now),
    });
    if (
      limits.unavailable ||
      !["five_hour", "seven_day"].every((id) => limits.windows.some((w) => w.id === id))
    )
      return yield* new ClaudeLaunchCapacityError({ code: "delegated_capacity_unverified" });
    const relevant = limits.windows.filter((w) => {
      const family = ["opus", "sonnet", "haiku"].find((name) => w.id === `seven_day_${name}`);
      return family === undefined || model.toLowerCase().includes(family);
    });
    const exhausted = relevant.filter((w) => w.usedPercent >= 100);
    if (exhausted.length)
      return yield* new ClaudeLaunchCapacityError({
        code: "usage_limit",
        quotaScope: claudeRefusalScope(exhausted.map((w) => w.id)),
      });
  },
  Effect.timeout("8 seconds"),
  Effect.mapError((cause) =>
    isClaudeLaunchCapacityError(cause)
      ? cause
      : new ClaudeLaunchCapacityError({ code: "delegated_capacity_unverified" }),
  ),
);
