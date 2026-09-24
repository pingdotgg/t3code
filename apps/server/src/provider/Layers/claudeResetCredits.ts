/**
 * Claude banked resets (the CLI's `cedar_ember` program). The CLI reads the
 * grants from the OAuth usage endpoint and claims one against the
 * organization; this module does the same with the credentials the CLI keeps
 * in its config directory. macOS keeps them in the keychain, so there the
 * feature is not offered.
 *
 * @module provider/Layers/claudeResetCredits
 */
import * as NodeOS from "node:os";
import type {
  ProviderConsumeResetCreditOutcome,
  ServerProviderResetCredits,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

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
    Schema.Struct({ organizationUuid: Schema.optional(Schema.String) }),
  ),
});
const Grant = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(GRANT_ID)),
  resets_left: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  ends_at: Schema.optional(Schema.NullOr(Schema.String)),
  paused: Schema.optional(Schema.Boolean),
  usable_now: Schema.optional(Schema.Boolean),
});
const decodeGrant = Schema.decodeUnknownOption(Grant);
const CedarEmber = Schema.Struct({
  eligible: Schema.Boolean,
  grants: Schema.optional(Schema.Array(Schema.Unknown)),
  next_grant_id: Schema.optional(Schema.NullOr(Schema.String)),
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

/**
 * Every reset failure except `requestFailed` and `unconfirmed` is final:
 * Claude answered, or nothing was sent. An unanswered or unconfirmed claim
 * retries with the same request id.
 */
export const isSettledClaudeResetCreditFailure = (error: unknown) =>
  isClaudeResetCreditError(error) &&
  error.reason !== "requestFailed" &&
  error.reason !== "unconfirmed";

/** Rejects unparseable and calendar-invalid timestamps such as February 30. */
const isFutureTimestamp = (value: string, nowMs: number) => {
  if (!COMPLETE_TIMESTAMP.test(value)) return false;
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  return (
    Date.parse(value) > nowMs && Date.UTC(year!, month! - 1, day!) <= Date.UTC(year!, month!, 0)
  );
};

/** Grants that are paused or past `ends_at` cannot be claimed and do not count. */
export function claudeResetCreditsToContract(
  block: unknown,
  nowMs: number,
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
  const nextExpiresAt = next?.ends_at ? DateTime.make(next.ends_at) : Option.none();
  return {
    availableCount: next ? live.reduce((sum, grant) => sum + grant.resets_left, 0) : 0,
    ...(Option.isSome(nextExpiresAt)
      ? { nextExpiresAt: DateTime.formatIso(nextExpiresAt.value) }
      : {}),
    ...(next ? { nextCreditId: next.id } : {}),
  };
}

const readJson = <S extends Schema.Top>(schema: S, file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.readFileString(file).pipe(
      Effect.catchTags({
        PlatformError: (error) =>
          error.reason._tag === "NotFound" ? Effect.succeed("{}") : Effect.fail(error),
      }),
      Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(schema))),
    );
  });

const readAccessToken = (configDir: string) =>
  Effect.gen(function* () {
    if ((yield* HostProcessPlatform) === "darwin") return undefined;
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

/**
 * Reads the banked resets for the login in `configDir`. Any failure reads as
 * "no resets" so the usage bars never break on this optional extra.
 */
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
  Effect.catch(() => Effect.succeed(undefined)),
);

/** The CLI keeps the account record beside its settings, or in the home directory by default. */
export const claudeAccountConfigPath = (configDir: string | undefined) =>
  Effect.map(Path.Path, (path) =>
    configDir ? path.join(configDir, ".claude.json") : path.join(NodeOS.homedir(), ".claude.json"),
  );

const CLAIM_OUTCOMES = {
  reset: "reset",
  not_limited: "nothingToReset",
  already_used: "alreadyRedeemed",
  ineligible: "noCredit",
} as const satisfies Record<string, ProviderConsumeResetCreditOutcome>;

/**
 * Claims `grantId`. `requestId` is the idempotency key: a retry with the same
 * id is the same claim. Ids are checked before anything is sent.
 */
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
  // Claude could not say whether the claim landed, so, like the CLI, keep the
  // request id and let the retry ask about the same claim.
  if (body.result === "unavailable") {
    return yield* new ClaudeResetCreditError({ reason: "unconfirmed" });
  }
  return CLAIM_OUTCOMES[body.result];
});
