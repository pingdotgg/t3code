import type {
  ProviderConsumeResetCreditOutcome,
  ServerProviderResetCreditOption,
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

const API_BASE = "https://api.anthropic.com";
const PROGRAM = "cedar_ember";
const GRANT_ID = /^[a-z0-9_-]{1,40}$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;
const COMPLETE_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

const Credentials = Schema.Struct({
  claudeAiOauth: Schema.optional(Schema.Struct({ accessToken: Schema.optional(Schema.String) })),
});
const Config = Schema.Struct({
  oauthAccount: Schema.optional(
    Schema.Struct({
      organizationUuid: Schema.optional(Schema.String),
      accountUuid: Schema.optional(Schema.Unknown),
    }),
  ),
});
const Grant = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(GRANT_ID)),
  resets_left: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  ends_at: Schema.optional(Schema.NullOr(Schema.String)),
  paused: Schema.optional(Schema.Boolean),
  usable_now: Schema.optional(Schema.Boolean),
  use_requires_limit: Schema.optional(Schema.Boolean),
  clears: Schema.optional(Schema.Array(Schema.Unknown)),
  blocking: Schema.optional(Schema.Array(Schema.Unknown)),
  type: Schema.optional(Schema.Unknown),
  gives_back_weekly: Schema.optional(Schema.Boolean),
  unavailable_reason: Schema.optional(Schema.Unknown),
});
const decodeGrant = Schema.decodeUnknownOption(Grant);
const CedarEmber = Schema.Struct({
  eligible: Schema.Boolean,
  grants: Schema.optional(Schema.Array(Schema.Unknown)),
  next_grant_id: Schema.optional(Schema.NullOr(Schema.String)),
  at_limit: Schema.optional(Schema.Unknown),
  exhausted: Schema.optional(Schema.Unknown),
  cooldown_until: Schema.optional(Schema.Unknown),
});
const UsageResponse = Schema.Struct({
  cedar_ember: Schema.optional(Schema.NullOr(Schema.Unknown)),
});
const decodeCedarEmber = Schema.decodeUnknownOption(CedarEmber);
const ClaimResponse = Schema.Struct({
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

// Claude Code's own grouping: a grant that gives back weekly usage is a Fable reset, else its
// declared type, else what it clears.
const RESET_KINDS = {
  session: { label: "5-hour reset", description: "Refills your 5-hour limit." },
  weekly: { label: "Weekly reset", description: "Refills your weekly limit." },
  fable: {
    label: "Fable reset",
    description:
      "Refills your Fable allowance and gives back what Fable used on your weekly limit. It doesn't reset your whole week.",
  },
  full: { label: "Full reset", description: "Refills your 5-hour and weekly limits." },
} as const;
type ResetKind = keyof typeof RESET_KINDS;

const grantKind = (grant: typeof Grant.Type): ResetKind => {
  if (grant.gives_back_weekly) return "fable";
  if (grant.type === "session" || grant.type === "weekly" || grant.type === "full") {
    return grant.type;
  }
  const clears = grant.clears ?? [];
  const session = clears.includes("five_hour");
  const other = clears.some((limit) => limit !== "five_hour");
  return session && !other ? "session" : other && !session ? "weekly" : "full";
};

const WAITING_REASONS = {
  cooldown: "Try again in a minute",
  blocked_five_hour: "Can't be used while you're at your 5-hour limit",
  blocked_seven_day: "Can't be used while you're at your weekly limit",
  blocked_opus: "Can't be used while you're at your weekly Opus limit",
  blocked_sonnet: "Can't be used while you're at your weekly Sonnet limit",
  blocked_other: "Can't be used while you're at a limit it doesn't refill",
  cannot_clear: "Doesn't refill the limit you've reached",
  needs_limit: "Usable once you reach a limit it refills",
  unavailable: "Can't be used right now",
} as const;
const BLOCKING_REASONS: Record<string, keyof typeof WAITING_REASONS> = {
  five_hour: "blocked_five_hour",
  seven_day: "blocked_seven_day",
  seven_day_opus: "blocked_opus",
  seven_day_sonnet: "blocked_sonnet",
};

type WaitingReason = keyof typeof WAITING_REASONS;

// Claude Code's own order: the server's stated reason, else a cooldown, what blocks the grant,
// a limit it can't clear, and last whether it needs a limit at all.
const waitingReasonKey = (
  grant: typeof Grant.Type,
  status: typeof CedarEmber.Type,
  nowMs: number,
): WaitingReason => {
  const stated = grant.unavailable_reason;
  if (typeof stated === "string" && Object.hasOwn(WAITING_REASONS, stated)) {
    return stated as WaitingReason;
  }
  const cooldown = status.cooldown_until;
  if (typeof cooldown === "string" && isFutureTimestamp(cooldown, nowMs)) return "cooldown";
  const blocking = grant.blocking ?? [];
  for (const limit of blocking) {
    const reason =
      typeof limit === "string" && Object.hasOwn(BLOCKING_REASONS, limit)
        ? BLOCKING_REASONS[limit]
        : undefined;
    if (reason) return reason;
  }
  if (blocking.length > 0) return "blocked_other";
  const exhausted = Array.isArray(status.exhausted) ? status.exhausted : [];
  const clears = (limit: unknown) =>
    (grant.clears ?? []).includes(limit) || (limit === "seven_day" && grant.gives_back_weekly);
  if (status.at_limit === true && !exhausted.some(clears)) return "cannot_clear";
  return grant.use_requires_limit === false ? "unavailable" : "needs_limit";
};

const waitingReason = (grant: typeof Grant.Type, status: typeof CedarEmber.Type, nowMs: number) => {
  const reason = waitingReasonKey(grant, status, nowMs);
  return reason === "blocked_seven_day" && grant.gives_back_weekly
    ? "No Fable usage this week to give back"
    : WAITING_REASONS[reason];
};

/**
 * The legacy fields keep their usable-only meaning so older clients never offer Use on a waiting
 * reset; `bankedOptions` lists every banked reset, and one Claude won't take right now says why.
 */
export function claudeResetCreditsToContract(
  block: unknown,
  nowMs: number,
): ServerProviderResetCredits | undefined {
  const parsed = decodeCedarEmber(block);
  if (Option.isNone(parsed) || !parsed.value.eligible) return undefined;
  const status = parsed.value;
  const banked = (status.grants ?? [])
    .flatMap((raw) => Option.toArray(decodeGrant(raw)))
    .filter(
      (grant) =>
        !grant.paused && (grant.ends_at == null || isFutureTimestamp(grant.ends_at, nowMs)),
    );
  const live = banked.filter((grant) => grant.usable_now);
  const next = live.find((grant) => grant.id === status.next_grant_id);
  const expiresAt = (grant: typeof Grant.Type | undefined) => {
    const at = grant?.ends_at ? DateTime.make(grant.ends_at) : Option.none();
    return Option.isSome(at) ? DateTime.formatIso(at.value) : undefined;
  };
  const kindOptions = (grants: ReadonlyArray<typeof Grant.Type>) => {
    const byKind = new Map<ResetKind, Array<typeof Grant.Type>>();
    for (const grant of grants) {
      if (grant.resets_left === 0) continue;
      const kind = grantKind(grant);
      byKind.set(kind, [...(byKind.get(kind) ?? []), grant]);
    }
    return (Object.keys(RESET_KINDS) as Array<ResetKind>).flatMap(
      (kind): Array<ServerProviderResetCreditOption> => {
        const ofKind = byKind.get(kind);
        const target = ofKind?.find((grant) => grant.usable_now) ?? ofKind?.[0];
        if (!ofKind || !target) return [];
        const optionExpiresAt = expiresAt(target);
        return [
          {
            creditId: target.id,
            ...RESET_KINDS[kind],
            availableCount: ofKind.reduce((sum, grant) => sum + grant.resets_left, 0),
            ...(optionExpiresAt ? { expiresAt: optionExpiresAt } : {}),
            ...(target.usable_now
              ? {}
              : { unavailableReason: waitingReason(target, status, nowMs) }),
          },
        ];
      },
    );
  };
  const bankedOptions = kindOptions(banked);
  const nextExpiresAt = expiresAt(next);
  return {
    availableCount: next ? live.reduce((sum, grant) => sum + grant.resets_left, 0) : 0,
    ...(nextExpiresAt ? { nextExpiresAt } : {}),
    ...(next ? { nextCreditId: next.id } : {}),
    ...(next ? { options: kindOptions(live) } : {}),
    ...(bankedOptions.length > 0 ? { bankedOptions } : {}),
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
  function* (configDir: string, version: string) {
    const token = yield* readAccessToken(configDir);
    if (!token) return undefined;
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(
      HttpClientRequest.get(`${API_BASE}/api/oauth/usage`, {
        urlParams: { cedar_ember: "1", skip_spend: "1" },
      }).pipe(withClaudeHeaders(token, version)),
    );
    const body = yield* HttpClientResponse.schemaBodyJson(UsageResponse)(
      yield* HttpClientResponse.filterStatusOk(response),
    );
    return claudeResetCreditsToContract(
      body.cedar_ember,
      DateTime.toEpochMillis(yield* DateTime.now),
    );
  },
  Effect.timeout("10 seconds"),
  Effect.orElseSucceed(() => undefined),
);

export const readClaudeOauthAccount = (accountConfigPath: string) =>
  readJson(Config, accountConfigPath).pipe(
    Effect.map((config) => config.oauthAccount),
    Effect.orElseSucceed(() => undefined),
  );

export const readClaudeOrganizationId = (accountConfigPath: string) =>
  readClaudeOauthAccount(accountConfigPath).pipe(
    Effect.map((account) => account?.organizationUuid?.trim() || undefined),
  );

export const claudeAccountConfigPath = Effect.fn("claudeAccountConfigPath")(function* (
  configDir: string | undefined,
) {
  const path = yield* Path.Path;
  return configDir
    ? path.join(configDir, ".claude.json")
    : path.join(yield* HostProcess.HomeDirectory, ".claude.json");
});

/** The grant a redeem request names, or the answer when no claim should be sent for it. */
export const claudeRedeemTarget = (
  credits: ServerProviderResetCredits | undefined,
  creditId: string | undefined,
): { readonly grantId: string } | { readonly outcome: "noCredit" | "nothingToReset" } => {
  if (creditId === undefined) {
    return credits?.nextCreditId ? { grantId: credits.nextCreditId } : { outcome: "noCredit" };
  }
  const option = (credits?.bankedOptions ?? credits?.options)?.find(
    (candidate) => candidate.creditId === creditId,
  );
  if (!option) return { outcome: "noCredit" };
  // A client reading an older snapshot can still ask for a reset that is now waiting.
  return option.unavailableReason ? { outcome: "nothingToReset" } : { grantId: creditId };
};

const CLAIM_OUTCOMES = {
  reset: "reset",
  not_limited: "nothingToReset",
  already_used: "alreadyRedeemed",
  ineligible: "noCredit",
} as const satisfies Record<string, ProviderConsumeResetCreditOutcome>;

/** requestId is the claim's idempotency key. */
export const consumeClaudeResetCredit = Effect.fn("consumeClaudeResetCredit")(function* (input: {
  readonly configDir: string;
  readonly accountConfigPath: string;
  readonly version: string;
  readonly grantId: string;
  readonly requestId: string;
}) {
  if (!GRANT_ID.test(input.grantId) || !REQUEST_ID.test(input.requestId)) {
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
        HttpClientRequest.bodyJsonUnsafe({
          program: PROGRAM,
          grant_id: input.grantId,
          request_id: input.requestId,
        }),
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
