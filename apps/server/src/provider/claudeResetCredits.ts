import type {
  ProviderConsumeResetCreditOutcome,
  ServerProviderResetCredits,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import { claudeUsageWindowId } from "./claudeUsageLimits.ts";

const API_BASE = "https://api.anthropic.com";
const PROGRAM = "cedar_ember";
const GRANT_ID = /^[a-z0-9_-]{1,40}$/;
/** The weekly at-limit reset (`juniper_tide`) has no grant; the colon keeps this id out of GRANT_ID. */
export const WEEKLY_RESET_ID = "weekly:juniper_tide";
const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;
const COMPLETE_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

const Credentials = Schema.Struct({
  claudeAiOauth: Schema.optional(Schema.Struct({ accessToken: Schema.optional(Schema.String) })),
});
const Config = Schema.Struct({
  oauthAccount: Schema.optional(
    Schema.Struct({ organizationUuid: Schema.optional(Schema.String) }),
  ),
});
const Grant = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(GRANT_ID)),
  resets_left: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  ends_at: Schema.optional(Schema.NullOr(Schema.String)),
  paused: Schema.optional(Schema.Boolean),
  usable_now: Schema.optional(Schema.Boolean),
  use_requires_limit: Schema.optional(Schema.NullOr(Schema.Boolean)),
  clears: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  gives_back_weekly: Schema.optional(Schema.NullOr(Schema.Boolean)),
});
const decodeGrant = Schema.decodeUnknownOption(Grant);
const CedarEmber = Schema.Struct({
  eligible: Schema.Boolean,
  grants: Schema.optional(Schema.Array(Schema.Unknown)),
  next_grant_id: Schema.optional(Schema.NullOr(Schema.String)),
});
const UsageResponse = Schema.Struct({
  cedar_ember: Schema.optional(Schema.NullOr(Schema.Unknown)),
  juniper_tide: Schema.optional(Schema.NullOr(Schema.Unknown)),
});
const decodeCedarEmber = Schema.decodeUnknownOption(CedarEmber);
const decodeJuniperTide = Schema.decodeUnknownOption(
  Schema.Struct({ available: Schema.optional(Schema.Boolean) }),
);
export const ClaimResponse = Schema.Struct({
  result: Schema.Literals([
    "reset",
    "already_used",
    "not_limited",
    "cooldown",
    "ineligible",
    "unavailable",
  ]),
});

const RESET_CREDIT_FAILURES = {
  malformedCredit: "Claude returned a malformed reset credit.",
  loginUnreadable: "Claude could not read its login.",
  accountUnreadable: "Claude could not read its account.",
  signedOut: "Sign in to Claude again to redeem resets.",
  rateLimited: "Claude is rate limiting resets. Try again soon.",
  coolingDown: "Claude resets are cooling down. Try again later.",
  unconfirmed:
    "Claude could not confirm the reset. If you are still limited in a moment, try again.",
  requestFailed: "Claude could not redeem the reset.",
} as const;

class ClaudeResetCreditError extends Schema.TaggedError<ClaudeResetCreditError>()(
  "ClaudeResetCreditError",
  {
    reason: Schema.Literals(
      Object.keys(RESET_CREDIT_FAILURES) as Array<keyof typeof RESET_CREDIT_FAILURES>,
    ),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return RESET_CREDIT_FAILURES[this.reason];
  }
}

const isClaudeResetCreditError = Schema.is(ClaudeResetCreditError);

/** Retry unanswered or unconfirmed claims with the same request ID. */
export const isSettledClaudeResetCreditFailure = (error: unknown) =>
  isClaudeResetCreditError(error) &&
  error.reason !== "requestFailed" &&
  error.reason !== "unconfirmed";

const isFutureTimestamp = (value: string, nowMs: number) => {
  if (!COMPLETE_TIMESTAMP.test(value)) return false;
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  return (
    Date.parse(value) > nowMs && Date.UTC(year!, month! - 1, day!) <= Date.UTC(year!, month!, 0)
  );
};

/**
 * Maps the usage endpoint's `cedar_ember` (banked grants) and `juniper_tide` (weekly
 * at-limit reset) blocks. An available weekly reset is used first: it is free and
 * comes back every week, while banked grants expire.
 */
export function claudeResetCreditsToContract(
  block: unknown,
  nowMs: number,
  overageIncluded?: string,
  weeklyBlock?: unknown,
): ServerProviderResetCredits | undefined {
  const banked = bankedCredits(block, nowMs, overageIncluded);
  if (!Option.exists(decodeJuniperTide(weeklyBlock), (weekly) => weekly.available === true)) {
    return banked;
  }
  return {
    ...banked,
    availableCount: (banked?.availableCount ?? 0) + 1,
    nextCreditId: WEEKLY_RESET_ID,
    grants: [
      { id: WEEKLY_RESET_ID, availableCount: 1, clearsWindowIds: ["seven_day"] },
      ...(banked?.grants ?? []),
    ],
  };
}

function bankedCredits(
  block: unknown,
  nowMs: number,
  overageIncluded: string | undefined,
): ServerProviderResetCredits | undefined {
  const parsed = decodeCedarEmber(block);
  if (Option.isNone(parsed) || !parsed.value.eligible) return undefined;
  const current = (parsed.value.grants ?? [])
    .flatMap((raw) => Option.toArray(decodeGrant(raw)))
    .filter(
      (grant) =>
        grant.resets_left > 0 && (grant.ends_at == null || isFutureTimestamp(grant.ends_at, nowMs)),
    );
  const waitingReason = (grant: (typeof current)[number]) =>
    grant.paused
      ? ("paused" as const)
      : grant.usable_now
        ? undefined
        : grant.use_requires_limit
          ? ("afterLimit" as const)
          : ("unavailable" as const);
  const live = current.filter((grant) => waitingReason(grant) === undefined);
  const next = live.find((grant) => grant.id === parsed.value.next_grant_id);
  const expiresAt = (grant: (typeof current)[number]) => {
    const date = grant.ends_at ? DateTime.make(grant.ends_at) : Option.none();
    return Option.isSome(date) ? DateTime.formatIso(date.value) : undefined;
  };
  // Without Claude's next grant nothing is offered, but waiting grants are still listed.
  const grants = (next ? current : current.filter(waitingReason)).map((grant) => {
    const grantExpiresAt = expiresAt(grant);
    const clears = grant.clears?.map((bucket) => claudeUsageWindowId(bucket, overageIncluded));
    const waiting = waitingReason(grant);
    return {
      id: grant.id,
      availableCount: grant.resets_left,
      ...(grantExpiresAt ? { expiresAt: grantExpiresAt } : {}),
      ...(clears?.length ? { clearsWindowIds: clears } : {}),
      ...(grant.gives_back_weekly ? { givesBackWeekly: true } : {}),
      ...(waiting ? { waiting } : {}),
    };
  });
  if (!next) return { availableCount: 0, ...(grants.length > 0 ? { grants } : {}) };
  const nextExpiresAt = expiresAt(next);
  return {
    availableCount: live.reduce((sum, grant) => sum + grant.resets_left, 0),
    ...(nextExpiresAt ? { nextExpiresAt } : {}),
    nextCreditId: next.id,
    grants,
  };
}

const readJson = Effect.fn("claudeResetCredits.readJson")(function* <S extends Schema.Top>(
  schema: S,
  file: string,
) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString(file).pipe(
    Effect.catchTags({
      PlatformError: (error) =>
        error.reason._tag === "NotFound" ? Effect.succeed("{}") : Effect.fail(error),
    }),
    Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(schema))),
  );
});

const readAccessToken = Effect.fn("claudeResetCredits.readAccessToken")(function* (
  configDir: string,
) {
  if ((yield* HostProcess.Platform) === "darwin") return undefined;
  const path = yield* Path.Path;
  const credentials = yield* readJson(Credentials, path.join(configDir, ".credentials.json"));
  return credentials.claudeAiOauth?.accessToken?.trim() || undefined;
});

const withClaudeHeaders = (token: string, version: string) =>
  HttpClientRequest.setHeaders({
    authorization: `Bearer ${token}`,
    "anthropic-beta": "oauth-2025-04-20",
    "user-agent": `claude-cli/${version} (external, cli)`,
  });

export const readClaudeResetCredits = Effect.fn("readClaudeResetCredits")(
  function* (configDir: string, version: string, overageIncluded: string | undefined) {
    const token = yield* readAccessToken(configDir);
    if (!token) return undefined;
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(
      HttpClientRequest.get(`${API_BASE}/api/oauth/usage`, {
        urlParams: { cedar_ember: "1", at_wall: "1", skip_spend: "1" },
      }).pipe(withClaudeHeaders(token, version)),
    );
    const body = yield* HttpClientResponse.schemaBodyJson(UsageResponse)(
      yield* HttpClientResponse.filterStatusOk(response),
    );
    return claudeResetCreditsToContract(
      body.cedar_ember,
      DateTime.toEpochMillis(yield* DateTime.now),
      overageIncluded,
      body.juniper_tide,
    );
  },
  Effect.timeout("10 seconds"),
  Effect.orElseSucceed(() => undefined),
);

export const readClaudeOrganizationId = (accountConfigPath: string) =>
  readJson(Config, accountConfigPath).pipe(
    Effect.map((config) => config.oauthAccount?.organizationUuid?.trim() || undefined),
    Effect.orElseSucceed(() => undefined),
  );

export const claudeAccountConfigPath = Effect.fn("claudeAccountConfigPath")(function* (
  configDir: string | undefined,
) {
  const path = yield* Path.Path;
  return configDir
    ? path.join(configDir, ".claude.json")
    : path.join(yield* HostProcess.HomeDirectory, ".claude.json");
});

export const CLAIM_OUTCOMES = {
  reset: "reset",
  not_limited: "nothingToReset",
  already_used: "alreadyRedeemed",
  ineligible: "noCredit",
} as const satisfies Record<string, ProviderConsumeResetCreditOutcome>;

/**
 * Builds the body Claude's CLI posts to `reset_rate_limits` for each attempt: the weekly
 * reset names only its program, a grant also carries its id and the attempt's request id.
 * Undefined for a malformed credit id.
 */
export const claudeClaim = (
  creditId: string,
): ((requestId: string) => Record<string, string>) | undefined =>
  creditId === WEEKLY_RESET_ID
    ? () => ({ program: "juniper_tide" })
    : GRANT_ID.test(creditId)
      ? (requestId) => ({ program: PROGRAM, grant_id: creditId, request_id: requestId })
      : undefined;

/** requestId is the claim's idempotency key. */
export const consumeClaudeResetCredit = Effect.fn("consumeClaudeResetCredit")(function* (input: {
  readonly configDir: string;
  readonly accountConfigPath: string;
  readonly version: string;
  readonly creditId: string;
  readonly requestId: string;
}) {
  const claim = claudeClaim(input.creditId);
  if (!claim || !REQUEST_ID.test(input.requestId)) {
    return yield* new ClaudeResetCreditError({ reason: "malformedCredit" });
  }
  const token = yield* readAccessToken(input.configDir).pipe(
    Effect.mapError((cause) => new ClaudeResetCreditError({ reason: "loginUnreadable", cause })),
  );
  const config = yield* readJson(Config, input.accountConfigPath).pipe(
    Effect.mapError((cause) => new ClaudeResetCreditError({ reason: "accountUnreadable", cause })),
  );
  const organization = config.oauthAccount?.organizationUuid?.trim();
  if (!token || !organization) {
    return yield* new ClaudeResetCreditError({ reason: "signedOut" });
  }
  const client = yield* HttpClient.HttpClient;
  const response = yield* client
    .execute(
      HttpClientRequest.post(
        new URL(
          `/api/organizations/${encodeURIComponent(organization)}/reset_rate_limits`,
          API_BASE,
        ),
      ).pipe(
        withClaudeHeaders(token, input.version),
        HttpClientRequest.bodyJsonUnsafe(claim(input.requestId)),
      ),
    )
    .pipe(
      Effect.timeout("25 seconds"),
      Effect.mapError((cause) => new ClaudeResetCreditError({ reason: "requestFailed", cause })),
    );
  if (response.status === 429) {
    return yield* new ClaudeResetCreditError({ reason: "rateLimited" });
  }
  if (response.status === 401 || response.status === 403) {
    return yield* new ClaudeResetCreditError({ reason: "signedOut" });
  }
  const body = yield* HttpClientResponse.filterStatusOk(response).pipe(
    Effect.flatMap(HttpClientResponse.schemaBodyJson(ClaimResponse)),
    Effect.timeout("25 seconds"),
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
