/**
 * modelproxy's dashboard status API, read as the signed-in operator, mapped onto the usage-limit
 * source shape. The per-account states (live, ready, cooling, spent) are derived exactly as
 * modelproxy's own dashboard derives them, so Lathe and the gateway never disagree.
 *
 * @module usage/modelproxyApi
 */
import {
  ForwardCompatibleArray,
  ForwardCompatibleOptional,
  ProviderDriverKind,
  TrimmedNonEmptyString,
  type ServerProviderResetCredits,
  type ServerProviderUsageWindow,
  type UsageLimitSourceAccount,
  type UsageLimitSourceProxyAccountState,
  type UsageLimitSourceProxyStatus,
} from "@lathe/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest } from "effect/http";

import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "@lathe/provider-core/server/usageLimits";

const Runway = Schema.Struct({
  kind: Schema.Literals(["at", "idle", "beyondHorizon", "resetsFirst", "unknown", "disabled"]),
  at: Schema.optional(Schema.String),
});
const ResetCredit = Schema.Struct({
  id: Schema.optional(Schema.String),
  expiresAt: Schema.optional(Schema.String),
});
/** The gateway's banked limit resets for one subscription account. */
const ResetCredits = Schema.Struct({
  weekly: Schema.Number,
  usableNow: Schema.Number,
  fable: Schema.optional(Schema.Number),
  nextWeekly: Schema.optional(ResetCredit),
  nextFable: Schema.optional(ResetCredit),
});
const Account = Schema.Struct({
  name: Schema.String,
  type: Schema.String,
  provider: Schema.String,
  current: Schema.Boolean,
  disabled: Schema.Boolean,
  util5h: Schema.Number,
  has5h: Schema.Boolean,
  reset5h: Schema.optional(Schema.String),
  util7d: Schema.Number,
  has7d: Schema.Boolean,
  reset7d: Schema.optional(Schema.String),
  perModel: Schema.optional(Schema.Record(Schema.String, Schema.Number)),
  perModelReset: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  credits: Schema.optional(Schema.Boolean),
  spendUsd: Schema.Number,
  capUsd: Schema.optional(Schema.Number),
  spendWindow: Schema.optional(Schema.String),
  inflight: Schema.Number,
  coolingUntil: Schema.optional(Schema.String),
  circuits: Schema.optional(Schema.Array(Schema.Struct({ state: Schema.String }))),
  health: Schema.optional(Schema.Struct({ state: Schema.String })),
  // Absent from gateways that predate reset credits, and until a probe reads them.
  // One the build cannot read is dropped rather than costing the whole status.
  resetCredits: ForwardCompatibleOptional(ResetCredits),
});
/** `model` routes rename a request; `fallback` routes spill a spent model elsewhere. */
const Route = Schema.Struct({
  kind: Schema.optional(Schema.String),
  from: TrimmedNonEmptyString,
  to: TrimmedNonEmptyString,
  provider: TrimmedNonEmptyString,
});
/** Only the fields Lathe reads; the payload carries much more and may grow. */
export const ModelproxyStatus = Schema.Struct({
  current: Schema.String,
  threshold: Schema.Number,
  fableThreshold: Schema.optional(Schema.Number),
  inflightTotal: Schema.Number,
  queueDepth: Schema.Number,
  forecast: Schema.Struct({ fleet: Runway }),
  accounts: Schema.Array(Account),
  // One route this build cannot read must not cost the whole status.
  routes: Schema.optional(ForwardCompatibleArray(Route)),
});
export type ModelproxyStatus = typeof ModelproxyStatus.Type;
type ModelproxyAccount = typeof Account.Type;

const decodeStatus = Schema.decodeUnknownEffect(ModelproxyStatus);
const decodeStatusJson = Schema.decodeUnknownEffect(Schema.fromJsonString(ModelproxyStatus));

/** The gateway's answer to a redemption; the outcome stays open so a newer gateway's word still reads. */
const RedeemReply = Schema.Struct({ outcome: Schema.String });
const decodeRedeemReplyJson = Schema.decodeUnknownEffect(Schema.fromJsonString(RedeemReply));

/** The gateway spends the credit and re-probes the account (bounded at 30s) before it answers. */
const REDEEM_TIMEOUT = "90 seconds";
const REDEEM_MAY_HAVE_APPLIED =
  "The reset may have applied. Trying again will not spend a second credit.";
const REDEEM_UNANSWERED = `The gateway did not answer. ${REDEEM_MAY_HAVE_APPLIED}`;

const STREAM_IDLE_TIMEOUT = "45 seconds";

export class ModelproxyReadError extends Schema.TaggedError<ModelproxyReadError>()(
  "ModelproxyReadError",
  {
    detail: Schema.String,
    /** The gateway rejected the token, so a fresh sign-in is needed rather than a retry. */
    unauthorized: Schema.optional(Schema.Boolean),
    /**
     * The read may succeed on its own a moment later: no answer, a 5xx, or a
     * body that was not JSON (an interrupted response or a network proxy's
     * own page). A wrong URL or a payload this build cannot read is not.
     */
    transient: Schema.optional(Schema.Boolean),
    /** The gateway predates the status stream; only the polled read works there. */
    unsupported: Schema.optional(Schema.Boolean),
    /** The HTTP status of a redeem the gateway answered with an error. */
    status: Schema.optional(Schema.Number),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

const SESSION_MINS = 5 * 60;
const WEEK_MINS = 7 * 24 * 60;

function driverFor(provider: string): ProviderDriverKind | null {
  switch (provider) {
    case "anthropic":
    case "":
      return ProviderDriverKind.make("claudeAgent");
    case "openai":
      return ProviderDriverKind.make("codex");
    default:
      return null;
  }
}

function elapsed(reset: string | undefined, nowMs: number): boolean {
  if (!reset) return false;
  const at = Date.parse(reset);
  return Number.isFinite(at) && at <= nowMs;
}

function windows(account: ModelproxyAccount, nowMs: number): ServerProviderUsageWindow[] {
  const out: ServerProviderUsageWindow[] = [];
  // A window whose reset has passed rolled over to full headroom; the
  // gateway still carries the last observation, so 0% is the honest figure.
  const util = (value: number, reset: string | undefined) =>
    elapsed(reset, nowMs) ? 0 : clampPercent(Math.round(value * 10_000) / 100);
  if (account.has5h) {
    out.push({
      id: "five_hour",
      kind: "session",
      label: "Session",
      windowDurationMins: SESSION_MINS,
      usedPercent: util(account.util5h, account.reset5h),
      ...(account.reset5h ? { resetsAt: account.reset5h } : {}),
    });
  }
  if (account.has7d) {
    out.push({
      id: "seven_day",
      kind: "weekly",
      label: "Weekly",
      windowDurationMins: WEEK_MINS,
      usedPercent: util(account.util7d, account.reset7d),
      ...(account.reset7d ? { resetsAt: account.reset7d } : {}),
    });
  }
  for (const [family, value] of Object.entries(account.perModel ?? {})) {
    const reset = account.perModelReset?.[family];
    out.push({
      id: `seven_day_${family.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`,
      kind: "weekly",
      label: `Weekly · ${family[0]?.toUpperCase()}${family.slice(1)}`,
      windowDurationMins: WEEK_MINS,
      usedPercent: util(value, reset),
      ...(reset ? { resetsAt: reset } : {}),
    });
  }
  return out;
}

const count = (value: number | undefined) => Math.max(0, Math.round(value ?? 0));

/** A timestamp the contract accepts, or nothing. */
function isoOrNone(value: string | undefined): { nextExpiresAt?: string } {
  const at = value ? DateTime.make(value) : Option.none();
  return Option.isSome(at) ? { nextExpiresAt: DateTime.formatIso(at.value) } : {};
}

/**
 * The gateway resolves the real grant, so the credit id Lathe holds names
 * only the kind: "weekly" or "fable".
 */
function resetCredits(account: ModelproxyAccount): ServerProviderResetCredits | undefined {
  const credits = account.resetCredits;
  if (!credits) return undefined;
  const weekly = count(credits.weekly);
  const fable = count(credits.fable);
  return {
    availableCount: weekly,
    usableNowCount: Math.min(weekly, count(credits.usableNow)),
    ...(weekly > 0 ? { nextCreditId: "weekly" } : {}),
    ...(weekly > 0 ? isoOrNone(credits.nextWeekly?.expiresAt) : {}),
    ...(fable > 0
      ? {
          fable: {
            availableCount: fable,
            nextCreditId: "fable",
            ...isoOrNone(credits.nextFable?.expiresAt),
          },
        }
      : {}),
  };
}

function accountState(
  account: ModelproxyAccount,
  nowMs: number,
): UsageLimitSourceProxyAccountState {
  if (account.disabled) return "paused";
  if (account.health?.state === "reauthentication_required") return "reauthentication";
  if (account.health?.state === "entitlement_suspended") return "suspended";
  if (account.coolingUntil && !elapsed(account.coolingUntil, nowMs)) return "cooling";
  // An open circuit routes traffic around the account, which is what
  // cooling amounts to from the outside.
  if (account.circuits?.some((circuit) => circuit.state === "open")) return "cooling";
  return account.current ? "live" : "ready";
}

/**
 * Subscription accounts become source accounts with the gateway's state
 * attached; metered API-key accounts have no windows to show and appear
 * only as fallbacks in the proxy summary.
 */
export function mapModelproxyStatus(
  status: ModelproxyStatus,
  input: { readonly checkedAt: string; readonly nowMs: number },
): { accounts: UsageLimitSourceAccount[]; proxy: Omit<UsageLimitSourceProxyStatus, "auth"> } {
  const accounts: UsageLimitSourceAccount[] = [];
  const fallback: NonNullable<UsageLimitSourceProxyStatus["fallback"]>[number][] = [];
  for (const account of status.accounts) {
    if (account.type === "apikey") {
      fallback.push({
        name: account.name,
        provider: account.provider || "anthropic",
        spendUsd: account.spendUsd,
        ...(account.capUsd !== undefined && account.capUsd > 0 ? { capUsd: account.capUsd } : {}),
        ...(account.spendWindow ? { window: account.spendWindow } : {}),
      });
      continue;
    }
    const driver = driverFor(account.provider);
    if (driver === null) continue;
    const observed = windows(account, input.nowMs);
    const credits = resetCredits(account);
    const limits =
      observed.length > 0
        ? makeUsageLimits({ checkedAt: input.checkedAt, windows: observed })
        : makeUnavailableUsageLimits({
            checkedAt: input.checkedAt,
            reason: "probeFailed",
            message: "The gateway has not observed this account's windows yet.",
          });
    accounts.push({
      id: account.name,
      driver,
      usageLimits: credits ? { ...limits, resetCredits: credits } : limits,
      proxy: {
        state: accountState(account, input.nowMs),
        ...(account.coolingUntil && !elapsed(account.coolingUntil, input.nowMs)
          ? { coolingUntil: account.coolingUntil }
          : {}),
        ...(account.credits ? { credits: true } : {}),
        inflight: Math.max(0, Math.round(account.inflight)),
      },
    });
  }
  const current = accounts.find((account) => account.id === status.current);
  // A fallback's `from` is a model the picker already offers; only model
  // routes name something a client could not otherwise ask for.
  const routes = status.routes
    ?.filter((route) => route.kind === undefined || route.kind === "model")
    .map((route) => ({
      ...(route.kind ? { kind: route.kind } : {}),
      from: route.from,
      to: route.to,
      provider: route.provider,
    }));
  return {
    accounts,
    proxy: {
      ...(current ? { current: current.id } : {}),
      rotationThresholdPercent: clampPercent(status.threshold * 100),
      ...(status.fableThreshold !== undefined
        ? { modelThresholdPercent: clampPercent(status.fableThreshold * 100) }
        : {}),
      runway: {
        kind: status.forecast.fleet.kind,
        ...(status.forecast.fleet.at ? { at: status.forecast.fleet.at } : {}),
      },
      ...(fallback.length > 0 ? { fallback } : {}),
      inflightTotal: Math.max(0, Math.round(status.inflightTotal)),
      queueDepth: Math.max(0, Math.round(status.queueDepth)),
      ...(routes ? { routes } : {}),
    },
  };
}

export const makeModelproxyApi = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;

  const readStatus = Effect.fn("ModelproxyApi.readStatus")(function* (
    baseUrl: string,
    accessToken: string,
  ): Effect.fn.Return<ModelproxyStatus, ModelproxyReadError> {
    const url = yield* Effect.try({
      try: () => new URL("/api/status", baseUrl).toString(),
      catch: () => new ModelproxyReadError({ detail: "The gateway URL is not valid." }),
    });
    const response = yield* client
      .execute(
        HttpClientRequest.get(url).pipe(
          HttpClientRequest.setHeader("Authorization", `Bearer ${accessToken}`),
        ),
      )
      .pipe(
        Effect.timeout("15 seconds"),
        Effect.mapError(
          () => new ModelproxyReadError({ detail: "The gateway did not answer.", transient: true }),
        ),
      );
    if (response.status === 401 || response.status === 403) {
      return yield* new ModelproxyReadError({
        detail: `The gateway rejected the session (HTTP ${response.status}).`,
        unauthorized: true,
      });
    }
    if (response.status < 200 || response.status >= 300) {
      return yield* new ModelproxyReadError({
        detail: `The gateway status request failed (HTTP ${response.status}).`,
        ...(response.status >= 500 ? { transient: true } : {}),
      });
    }
    const body = yield* response.json.pipe(
      Effect.mapError(
        () =>
          new ModelproxyReadError({ detail: "The gateway status was not JSON.", transient: true }),
      ),
    );
    return yield* decodeStatus(body).pipe(
      Effect.mapError(
        () => new ModelproxyReadError({ detail: "The gateway status was not understood." }),
      ),
    );
  });

  /**
   * The gateway's status as it changes, from its server-sent-events stream.
   * The stream ends when the gateway closes it or goes quiet past its
   * keepalive, so the caller reconnects either way.
   */
  const streamStatus = (
    baseUrl: string,
    accessToken: string,
  ): Stream.Stream<ModelproxyStatus, ModelproxyReadError> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const url = yield* Effect.try({
          try: () => new URL("/api/status/stream", baseUrl).toString(),
          catch: () => new ModelproxyReadError({ detail: "The gateway URL is not valid." }),
        });
        const response = yield* client
          .execute(
            HttpClientRequest.get(url).pipe(
              HttpClientRequest.setHeaders({
                Authorization: `Bearer ${accessToken}`,
                Accept: "text/event-stream",
              }),
            ),
          )
          .pipe(
            Effect.timeout("15 seconds"),
            Effect.mapError(
              () =>
                new ModelproxyReadError({ detail: "The gateway did not answer.", transient: true }),
            ),
          );
        if (response.status === 401 || response.status === 403) {
          return yield* new ModelproxyReadError({
            detail: `The gateway rejected the session (HTTP ${response.status}).`,
            unauthorized: true,
          });
        }
        if (response.status === 404) {
          return yield* new ModelproxyReadError({
            detail: "The gateway does not stream its status.",
            unsupported: true,
          });
        }
        if (response.status < 200 || response.status >= 300) {
          return yield* new ModelproxyReadError({
            detail: `The gateway status stream failed (HTTP ${response.status}).`,
            ...(response.status >= 500 ? { transient: true } : {}),
          });
        }
        // Something in front of the gateway (a sign-in page, a catch-all)
        // can answer 200 with a page instead; reading that as a stream would
        // end cleanly and reconnect forever.
        if (!(response.headers["content-type"] ?? "").startsWith("text/event-stream")) {
          return yield* new ModelproxyReadError({
            detail: "The gateway did not answer with a status stream.",
            unsupported: true,
          });
        }
        return response.stream.pipe(
          Stream.mapError(
            () => new ModelproxyReadError({ detail: "The gateway stream broke.", transient: true }),
          ),
          Stream.decodeText(),
          Stream.splitLines,
          // The gateway sends a keepalive line every 15 seconds; three missed
          // means the connection is gone even if the socket has not noticed.
          Stream.timeout(STREAM_IDLE_TIMEOUT),
          Stream.mapAccum(
            () => "",
            (data: string, line: string) => {
              if (line === "") return ["", data === "" ? [] : [data]] as const;
              if (line.startsWith("data:")) {
                const value = line.slice(5).replace(/^ /, "");
                return [data === "" ? value : `${data}\n${value}`, []] as const;
              }
              return [data, []] as const;
            },
          ),
          Stream.mapEffect((data) =>
            decodeStatusJson(data).pipe(
              Effect.map((status): ReadonlyArray<ModelproxyStatus> => [status]),
              // One snapshot this build cannot read is skipped, not fatal:
              // the next change brings another.
              Effect.catch(() =>
                Effect.as(
                  Effect.logDebug("modelproxy status event was not understood"),
                  [] as ReadonlyArray<ModelproxyStatus>,
                ),
              ),
            ),
          ),
          Stream.flattenIterable,
        );
      }),
    );

  /** Spends one of a pooled account's banked resets; answers the gateway's outcome. */
  const redeemResetCredit = Effect.fn("ModelproxyApi.redeemResetCredit")(function* (
    baseUrl: string,
    accessToken: string,
    input: {
      readonly account: string;
      readonly kind: "weekly" | "fable";
      readonly requestId: string;
    },
  ): Effect.fn.Return<string, ModelproxyReadError> {
    const url = yield* Effect.try({
      try: () =>
        new URL(
          `/api/accounts/${encodeURIComponent(input.account)}/reset-credits/redeem`,
          baseUrl,
        ).toString(),
      catch: () => new ModelproxyReadError({ detail: "The gateway URL is not valid." }),
    });
    const exchange = Effect.gen(function* () {
      const response = yield* client
        .execute(
          HttpClientRequest.post(url).pipe(
            HttpClientRequest.setHeader("Authorization", `Bearer ${accessToken}`),
            HttpClientRequest.bodyJsonUnsafe({ kind: input.kind, requestId: input.requestId }),
          ),
        )
        .pipe(
          Effect.mapError(
            () => new ModelproxyReadError({ detail: REDEEM_UNANSWERED, transient: true }),
          ),
        );
      if (response.status === 401 || response.status === 403) {
        return yield* new ModelproxyReadError({
          detail: `The gateway rejected the session (HTTP ${response.status}).`,
          unauthorized: true,
          status: response.status,
        });
      }
      if (response.status < 200 || response.status >= 300) {
        const reason = yield* response.json.pipe(
          Effect.map((body) =>
            typeof body === "object" && body !== null && "error" in body ? String(body.error) : "",
          ),
          Effect.orElseSucceed(() => ""),
        );
        return yield* new ModelproxyReadError({
          detail:
            response.status === 404
              ? "The gateway cannot redeem resets for this account."
              : `The gateway could not redeem the reset (HTTP ${response.status})${reason ? `: ${reason}` : "."}`,
          status: response.status,
          ...(response.status >= 500 ? { transient: true } : {}),
        });
      }
      const text = yield* response.text.pipe(
        Effect.mapError(
          () => new ModelproxyReadError({ detail: REDEEM_UNANSWERED, transient: true }),
        ),
      );
      const body = yield* decodeRedeemReplyJson(text).pipe(
        Effect.mapError(
          () =>
            new ModelproxyReadError({
              detail: `The gateway's answer was not understood. ${REDEEM_MAY_HAVE_APPLIED}`,
            }),
        ),
      );
      return body.outcome;
    });
    // The gateway spends the credit and then re-probes the account, which
    // can take up to a minute. One bound covers the request and its body.
    return yield* exchange.pipe(
      Effect.timeoutOrElse({
        duration: REDEEM_TIMEOUT,
        orElse: () =>
          Effect.fail(new ModelproxyReadError({ detail: REDEEM_UNANSWERED, transient: true })),
      }),
    );
  });

  return { readStatus, streamStatus, redeemResetCredit };
});

export type ModelproxyApi = Effect.Success<typeof makeModelproxyApi>;
