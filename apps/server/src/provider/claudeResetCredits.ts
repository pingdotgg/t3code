// @effect-diagnostics-next-line nodeBuiltinImport:off -- a synchronous hash for the cache key and file name.
import * as NodeCrypto from "node:crypto";

import type {
  ProviderConsumeResetCreditOutcome,
  ServerProviderResetCreditOption,
  ServerProviderResetCredits,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import {
  claudeScopedWindowId,
  claudeUsageWindowId,
  OVERAGE_INCLUDED_EVENT_TYPE,
} from "./claudeUsageLimits.ts";

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
  clears: Schema.optional(Schema.Array(Schema.Unknown)),
  type: Schema.optional(Schema.Unknown),
  gives_back_weekly: Schema.optional(Schema.Boolean),
});
const decodeGrant = Schema.decodeUnknownOption(Grant);
const CedarEmber = Schema.Struct({
  eligible: Schema.Boolean,
  grants: Schema.optional(Schema.Array(Schema.Unknown)),
  next_grant_id: Schema.optional(Schema.NullOr(Schema.String)),
});
const UsageResponse = Schema.Struct({
  cedar_ember: Schema.optional(Schema.NullOr(Schema.Unknown)),
  limits: Schema.optional(Schema.NullOr(Schema.Array(Schema.Unknown))),
  weekly_scoped_shares: Schema.optional(Schema.NullOr(Schema.Array(Schema.Unknown))),
});
const decodeCedarEmber = Schema.decodeUnknownOption(CedarEmber);
const ScopedLimit = Schema.Struct({
  kind: Schema.Literal("weekly_scoped"),
  scope: Schema.Struct({
    model: Schema.Struct({ display_name: Schema.String.check(Schema.isNonEmpty()) }),
  }),
});
const decodeScopedLimit = Schema.decodeUnknownOption(ScopedLimit);
const Percent = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100 }));
const WeeklyShare = Schema.Struct({
  limit_index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  used_percent_of_weekly: Percent,
  allowance_percent_of_weekly: Percent,
});
const decodeWeeklyShare = Schema.decodeUnknownOption(WeeklyShare);
const GRANTS_CACHE_TTL_MS = 2 * 60_000;
const CachedUsage = Schema.fromJsonString(
  Schema.Struct({ at: Schema.Number, key: Schema.String, body: UsageResponse }),
);
const decodeCachedUsage = Schema.decodeEffect(CachedUsage);
const encodeCachedUsage = Schema.encodeEffect(CachedUsage);
const sha256 = (value: string) => NodeCrypto.createHash("sha256").update(value).digest("hex");
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
const KIND_BUCKETS: Record<ResetKind, ReadonlyArray<string>> = {
  session: ["five_hour"],
  weekly: ["seven_day"],
  fable: [OVERAGE_INCLUDED_EVENT_TYPE],
  full: ["five_hour", "seven_day"],
};

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

export function claudeResetCreditsToContract(
  block: unknown,
  nowMs: number,
  overageIncluded?: string,
): ServerProviderResetCredits | undefined {
  const parsed = decodeCedarEmber(block);
  if (Option.isNone(parsed) || !parsed.value.eligible) return undefined;
  const live = (parsed.value.grants ?? [])
    .flatMap((raw) => Option.toArray(decodeGrant(raw)))
    .filter(
      (grant) =>
        !grant.paused &&
        grant.usable_now &&
        (grant.ends_at == null || isFutureTimestamp(grant.ends_at, nowMs)),
    );
  const next = live.find((grant) => grant.id === parsed.value.next_grant_id);
  const expiresAt = (grant: typeof Grant.Type | undefined) => {
    const at = grant?.ends_at ? DateTime.make(grant.ends_at) : Option.none();
    return Option.isSome(at) ? DateTime.formatIso(at.value) : undefined;
  };
  // Grants of one kind can still clear different limits, so they group by what they clear too.
  const groups = new Map<
    string,
    {
      kind: ResetKind;
      cleared: Array<string>;
      modelOnly: boolean;
      grants: Array<typeof Grant.Type>;
    }
  >();
  for (const grant of live) {
    if (grant.resets_left === 0) continue;
    const kind = grantKind(grant);
    const listed = (grant.clears ?? []).flatMap((bucket) =>
      typeof bucket === "string" && bucket.trim() ? [bucket.trim()] : [],
    );
    const buckets = new Set(listed.length > 0 ? listed : KIND_BUCKETS[kind]);
    // Claude lists the shared Session in a model-scoped reset's clears, but redeeming leaves it.
    const modelOnly =
      buckets.has(OVERAGE_INCLUDED_EVENT_TYPE) &&
      [...buckets].every(
        (bucket) => bucket === OVERAGE_INCLUDED_EVENT_TYPE || bucket === "five_hour",
      );
    // A model's row only counts that model's own resets, so a wider reset stays off it.
    const cleared = [...buckets]
      .filter((bucket) => (bucket === OVERAGE_INCLUDED_EVENT_TYPE) === modelOnly)
      .toSorted();
    const key = `${kind}\n${cleared.join("\n")}`;
    const group = groups.get(key);
    if (group) group.grants.push(grant);
    else groups.set(key, { kind, cleared, modelOnly, grants: [grant] });
  }
  const options = (Object.keys(RESET_KINDS) as Array<ResetKind>).flatMap((kind) =>
    [...groups.values()]
      .filter((group) => group.kind === kind)
      .map(({ cleared, modelOnly, grants }): ServerProviderResetCreditOption => {
        const target = grants[0]!;
        const optionExpiresAt = expiresAt(target);
        const scope = modelOnly ? overageIncluded?.trim() : undefined;
        return {
          creditId: target.id,
          ...RESET_KINDS[kind],
          ...(modelOnly && kind !== "fable"
            ? {
                label: `${scope ?? "Model"} weekly reset`,
                description: `Refills your ${scope ?? "model"} weekly allowance.`,
              }
            : {}),
          availableCount: grants.reduce((sum, grant) => sum + grant.resets_left, 0),
          ...(optionExpiresAt ? { expiresAt: optionExpiresAt } : {}),
          clearsWindowIds: cleared.map((bucket) => claudeUsageWindowId(bucket, overageIncluded)),
          ...(scope ? { scope } : {}),
        };
      }),
  );
  const nextExpiresAt = expiresAt(next);
  return {
    availableCount: next ? live.reduce((sum, grant) => sum + grant.resets_left, 0) : 0,
    ...(nextExpiresAt ? { nextExpiresAt } : {}),
    ...(next ? { nextCreditId: next.id } : {}),
    ...(next ? { options } : {}),
  };
}

export type ClaudeWindowShare = NonNullable<ServerProviderUsageWindow["share"]>;

/** Claude caps a model's weekly usage at a share of Weekly, such as Fable at 50%. */
function claudeWeeklySharesByWindowId(
  limits: ReadonlyArray<unknown> | null | undefined,
  shares: ReadonlyArray<unknown> | null | undefined,
): ReadonlyMap<string, ClaudeWindowShare> {
  const byWindowId = new Map<string, ClaudeWindowShare>();
  for (const share of (shares ?? []).flatMap((raw) => Option.toArray(decodeWeeklyShare(raw)))) {
    const limit = decodeScopedLimit(limits?.[share.limit_index]);
    if (Option.isNone(limit)) continue;
    byWindowId.set(claudeScopedWindowId(limit.value.scope.model.display_name), {
      ofWindowId: "seven_day",
      usedPercent: share.used_percent_of_weekly,
      allowancePercent: share.allowance_percent_of_weekly,
    });
  }
  return byWindowId;
}

export interface ClaudeAccountUsage {
  readonly resetCredits: ServerProviderResetCredits | undefined;
  readonly sharesByWindowId: ReadonlyMap<string, ClaudeWindowShare>;
}

// A Fable reset gives back what that model used of Weekly, so say how much.
const describeShare = (
  option: ServerProviderResetCreditOption,
  sharesByWindowId: ReadonlyMap<string, ClaudeWindowShare>,
): ServerProviderResetCreditOption => {
  const share =
    option.scope && option.label === RESET_KINDS.fable.label
      ? option.clearsWindowIds?.flatMap((id) => sharesByWindowId.get(id) ?? [])[0]
      : undefined;
  if (!share || !option.scope) return option;
  const used = Math.round(share.usedPercent);
  return {
    ...option,
    description: `Refills your ${option.scope} allowance${used > 0 ? ` and gives back the ${used}% of your weekly limit ${option.scope} used` : ""}. It doesn't reset the rest of your weekly limit.`,
  };
};

const accountUsageFromResponse = (
  body: typeof UsageResponse.Type,
  nowMs: number,
  overageIncluded: string | undefined,
): ClaudeAccountUsage => {
  const sharesByWindowId = claudeWeeklySharesByWindowId(body.limits, body.weekly_scoped_shares);
  const resetCredits = claudeResetCreditsToContract(body.cedar_ember, nowMs, overageIncluded);
  return {
    resetCredits: resetCredits?.options
      ? {
          ...resetCredits,
          options: resetCredits.options.map((option) => describeShare(option, sharesByWindowId)),
        }
      : resetCredits,
    sharesByWindowId,
  };
};

export function withClaudeAccountUsage(
  usageLimits: ServerProviderUsageLimits,
  accountUsage: ClaudeAccountUsage | undefined,
): ServerProviderUsageLimits {
  if (!accountUsage) return usageLimits;
  const { resetCredits, sharesByWindowId } = accountUsage;
  return {
    ...usageLimits,
    windows: usageLimits.windows.map((window) => {
      const share = sharesByWindowId.get(window.id);
      return share ? { ...window, share } : window;
    }),
    ...(resetCredits ? { resetCredits } : {}),
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

export const claudeResetCreditsCacheFile = (path: Path.Path, stateDir: string, configDir: string) =>
  path.join(stateDir, `claude-reset-credits-${sha256(configDir).slice(0, 16)}.json`);

export const forgetClaudeResetCredits = Effect.fn("claudeResetCredits.forget")(function* (
  cacheFile: string,
) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.remove(cacheFile, { force: true }).pipe(Effect.ignore);
});

// The cache is on disk because a restart refetches, and a dev server restarting on each edit gets
// the account rate limited.
export const readClaudeAccountUsage = Effect.fn("readClaudeAccountUsage")(
  function* (configDir: string, version: string, overageIncluded?: string, cacheFile?: string) {
    const token = yield* readAccessToken(configDir);
    if (!token) return undefined;
    const fs = yield* FileSystem.FileSystem;
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const key = sha256(`${token}\n${version}`);
    const cached = cacheFile
      ? yield* fs.readFileString(cacheFile).pipe(Effect.flatMap(decodeCachedUsage), Effect.option)
      : Option.none();
    if (
      Option.isSome(cached) &&
      cached.value.key === key &&
      now >= cached.value.at &&
      now - cached.value.at < GRANTS_CACHE_TTL_MS
    ) {
      return accountUsageFromResponse(cached.value.body, now, overageIncluded);
    }
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(
      HttpClientRequest.get(`${API_BASE}/api/oauth/usage`, {
        urlParams: { cedar_ember: "1", skip_spend: "1" },
      }).pipe(withClaudeHeaders(token, version)),
    );
    const body = yield* HttpClientResponse.schemaBodyJson(UsageResponse)(
      yield* HttpClientResponse.filterStatusOk(response),
    );
    if (cacheFile) {
      const { cedar_ember, limits, weekly_scoped_shares } = body;
      yield* encodeCachedUsage({
        at: now,
        key,
        body: { cedar_ember, limits, weekly_scoped_shares },
      }).pipe(
        Effect.flatMap((json) => fs.writeFileString(cacheFile, json)),
        Effect.ignore,
      );
    }
    return accountUsageFromResponse(body, now, overageIncluded);
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
