import { type ServerProviderUsageLimits, UsageLimitSourceError } from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  CLAIM_OUTCOMES,
  ClaimResponse,
  ClaudeResetCreditError,
  GRANT_ID,
  PROGRAM,
  REQUEST_ID,
  claudeResetCreditsToContract,
} from "../../provider/claudeResetCredits.ts";
import type { CliproxyHub } from "../../usage/cliproxyApi.ts";
import { usageReadAt, withAccountReadAt } from "../usageReadAt/usageReadAt.ts";

type HubAccount = {
  readonly auth_index: string;
  readonly provider: string;
  readonly email?: string | undefined;
  readonly disabled?: boolean | undefined;
  readonly organization_uuid?: string | undefined;
};

export type ClaudeLogin = {
  readonly email: string | undefined;
  readonly organizationId: string | undefined;
};

const ClaudeWindow = Schema.Struct({
  utilization: Schema.NullOr(Schema.Number),
  resets_at: Schema.NullOr(Schema.String),
});
const ClaudeUsage = Schema.Struct({
  cedar_ember: Schema.optional(Schema.NullOr(Schema.Unknown)),
  five_hour: Schema.optional(Schema.NullOr(ClaudeWindow)),
  seven_day: Schema.optional(Schema.NullOr(ClaudeWindow)),
  spend: Schema.optional(Schema.Unknown),
  extra_usage: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        is_enabled: Schema.Boolean,
        monthly_limit: Schema.NullOr(Schema.Number),
        used_credits: Schema.NullOr(Schema.Number),
        utilization: Schema.NullOr(Schema.Number),
      }),
    ),
  ),
  limits: Schema.optional(
    Schema.Array(
      Schema.Struct({
        kind: Schema.String,
        percent: Schema.optional(Schema.NullOr(Schema.Number)),
        resets_at: Schema.optional(Schema.NullOr(Schema.String)),
        scope: Schema.optional(
          Schema.NullOr(
            Schema.Struct({
              model: Schema.optional(Schema.NullOr(Schema.Struct({ display_name: Schema.String }))),
            }),
          ),
        ),
      }),
    ),
  ),
});
const ApiResponse = Schema.Struct({ status_code: Schema.Number, body: Schema.String });

const decodeClaudeUsage = Schema.decodeUnknownEffect(Schema.fromJsonString(ClaudeUsage));
const decodeApiResponse = Schema.decodeUnknownEffect(ApiResponse);
const decodeClaimResponse = Schema.decodeUnknownEffect(Schema.fromJsonString(ClaimResponse));
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const isUsageLimitSourceError = Schema.is(UsageLimitSourceError);

const CLAUDE_API = "https://api.anthropic.com/api";
export const CLAUDE_USAGE_URL = `${CLAUDE_API}/oauth/usage?cedar_ember=1`;

const REDEEM_URL = /\/(?:consume|reset_rate_limits)$/;

/** A redeem waits on the hub's own call to the provider, which can take longer than a read. */
export const managementTimeout = (body: unknown) =>
  typeof body === "object" &&
  body !== null &&
  "url" in body &&
  typeof body.url === "string" &&
  REDEEM_URL.test(body.url)
    ? "30 seconds"
    : "15 seconds";

const resetCredits = Effect.fn("ClaudeHub.resetCredits")(function* (
  usage: typeof ClaudeUsage.Type,
) {
  return claudeResetCreditsToContract(
    usage.cedar_ember,
    DateTime.toEpochMillis(yield* DateTime.now),
  );
});

/** Adds reset credits and the reading's time from a usage answer to a hub account read from it. */
export const withClaudeUsageAnswer = Effect.fn("ClaudeHub.withUsageAnswer")(function* <
  A extends { readonly usageLimits: ServerProviderUsageLimits },
>(body: string, account: A) {
  const credits = yield* resetCredits(yield* decodeClaudeUsage(body));
  return withAccountReadAt(
    body,
    credits
      ? { ...account, usageLimits: { ...account.usageLimits, resetCredits: credits } }
      : account,
  );
});

/** Claude reads and reset claims through a CLIProxyAPI hub's management API. */
export const makeClaudeHub = Effect.fn("makeClaudeHub")(function* <A extends HubAccount>(
  management: (
    hub: CliproxyHub,
    path: string,
    body?: unknown,
  ) => Effect.Effect<unknown, UsageLimitSourceError>,
  authFiles: (
    hub: CliproxyHub,
  ) => Effect.Effect<ReadonlyArray<A>, UsageLimitSourceError | Schema.SchemaError>,
) {
  const random = yield* SecureRandom.SecureRandom;

  const apiCall = Effect.fn("ClaudeHub.apiCall")(function* (
    hub: CliproxyHub,
    account: HubAccount,
    url: string,
    data?: unknown,
  ) {
    const raw = yield* management(hub, "api-call", {
      auth_index: account.auth_index,
      method: data === undefined ? "GET" : "POST",
      url,
      header: {
        Authorization: "Bearer $TOKEN$",
        "anthropic-beta": "oauth-2025-04-20",
        ...(data === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(data === undefined ? {} : { data: yield* encodeJson(data) }),
    });
    return yield* decodeApiResponse(raw);
  });

  /** Usage in the Claude SDK's get_usage shape, plus reset credits. */
  const usage = Effect.fn("ClaudeHub.usage")(
    function* (hub: CliproxyHub, account: HubAccount) {
      const response = yield* apiCall(hub, account, CLAUDE_USAGE_URL);
      if (response.status_code < 200 || response.status_code >= 300) {
        return yield* new UsageLimitSourceError({
          detail: `The provider refused the hub request (HTTP ${response.status_code}).`,
        });
      }
      const usage = yield* decodeClaudeUsage(response.body);
      const model_scoped = (usage.limits ?? []).flatMap((limit) =>
        limit.kind === "weekly_scoped" && limit.scope?.model && typeof limit.percent === "number"
          ? [
              {
                display_name: limit.scope.model.display_name,
                utilization: limit.percent,
                resets_at: limit.resets_at ?? null,
              },
            ]
          : [],
      );
      return {
        response: {
          rate_limits_available: true,
          rate_limits: {
            five_hour: usage.five_hour ?? null,
            seven_day: usage.seven_day ?? null,
            model_scoped,
            spend: usage.spend,
            extra_usage: usage.extra_usage ?? null,
          },
        },
        resetCredits: yield* resetCredits(usage),
        readAt: usageReadAt(response.body),
      };
    },
    Effect.mapError((error) =>
      isUsageLimitSourceError(error)
        ? error
        : new UsageLimitSourceError({ detail: "The hub returned an unexpected usage response." }),
    ),
  );

  const claim = Effect.fn("ClaudeHub.claim")(function* (
    hub: CliproxyHub,
    account: HubAccount,
    grantId: string,
    requestId: string,
  ) {
    if (!GRANT_ID.test(grantId) || !REQUEST_ID.test(requestId)) {
      return yield* new ClaudeResetCreditError({ reason: "malformedCredit" });
    }
    const organization = account.organization_uuid?.trim();
    if (!organization) {
      return yield* new UsageLimitSourceError({
        detail: "The hub does not know this Claude account's organization.",
      });
    }
    const response = yield* apiCall(
      hub,
      account,
      `${CLAUDE_API}/organizations/${encodeURIComponent(organization)}/reset_rate_limits`,
      { program: PROGRAM, grant_id: grantId, request_id: requestId },
    );
    if (response.status_code === 429) {
      return yield* new ClaudeResetCreditError({ reason: "rateLimited" });
    }
    if (response.status_code === 401 || response.status_code === 403) {
      return yield* new ClaudeResetCreditError({ reason: "signedOut" });
    }
    if (response.status_code < 200 || response.status_code >= 300) {
      return yield* new ClaudeResetCreditError({ reason: "requestFailed" });
    }
    const body = yield* decodeClaimResponse(response.body).pipe(
      Effect.mapError((cause) => new ClaudeResetCreditError({ reason: "requestFailed", cause })),
    );
    if (body.result === "cooldown") {
      return yield* new ClaudeResetCreditError({ reason: "coolingDown" });
    }
    // Unknown outcomes retain the request ID so retries address the same claim.
    if (body.result === "unavailable") {
      return yield* new ClaudeResetCreditError({ reason: "unconfirmed" });
    }
    return CLAIM_OUTCOMES[body.result];
  });

  const clearCooldown = (hub: CliproxyHub, account: HubAccount) =>
    management(hub, "reset-quota", { auth_index: account.auth_index });

  /**
   * The account for a directly signed-in Claude login, taken from the first source that
   * lists exactly one match.
   * A source that cannot list its accounts fails the lookup; it never counts as no match.
   * Each hub is read only when its turn comes, so a later hub cannot fail an earlier match.
   */
  const findLogin = Effect.fn("ClaudeHub.findLogin")(function* (
    hubs: ReadonlyArray<Effect.Effect<CliproxyHub, UsageLimitSourceError>>,
    login: ClaudeLogin,
  ) {
    const { email, organizationId } = login;
    if (!email || !organizationId) return undefined;
    for (const readHub of hubs) {
      const hub = yield* readHub;
      const accounts = yield* authFiles(hub).pipe(
        Effect.mapError((error) =>
          isUsageLimitSourceError(error)
            ? error
            : new UsageLimitSourceError({ detail: "The hub could not list accounts." }),
        ),
      );
      const matches = accounts.filter(
        (account) =>
          account.provider === "claude" &&
          !account.disabled &&
          account.email?.toLowerCase() === email.toLowerCase() &&
          account.organization_uuid === organizationId,
      );
      if (matches.length === 1) return { hub, account: matches[0]! };
    }
    return undefined;
  });

  // Claim errors stay typed so the caller's coordinator keeps the request id for retries.
  const claimLogin = Effect.fn("ClaudeHub.claimLogin")(function* (
    hub: CliproxyHub,
    account: HubAccount,
    grantId: string,
    requestId: string,
  ) {
    const outcome = yield* claim(hub, account, grantId, requestId);
    if (outcome === "reset" || outcome === "alreadyRedeemed") {
      yield* clearCooldown(hub, account).pipe(Effect.ignore);
    }
    return outcome;
  });

  /** Redeems a reset on a Claude account the hub lists. */
  const consume = Effect.fn("ClaudeHub.consume")(function* (
    hub: CliproxyHub,
    account: HubAccount,
    grantId: string,
  ) {
    if (account.disabled) {
      return yield* new UsageLimitSourceError({
        detail: "The hub account is missing or disabled.",
      });
    }
    // A Claude grant can hold several resets, so each claim needs its own request id.
    const outcome = yield* claim(hub, account, grantId, yield* random.uuidV4()).pipe(
      Effect.catchTags({
        ClaudeResetCreditError: (error) =>
          Effect.fail(new UsageLimitSourceError({ detail: error.message })),
      }),
    );
    if (outcome !== "reset" && outcome !== "alreadyRedeemed") return { outcome };
    const cleared = yield* clearCooldown(hub, account).pipe(Effect.result);
    return {
      outcome,
      ...(cleared._tag === "Failure"
        ? {
            warning:
              "Credit redeemed, but the hub cooldown could not be cleared. Routing may resume after its cooldown expires.",
          }
        : {}),
    } as const;
  });

  return { usage, findLogin, claimLogin, consume };
});
