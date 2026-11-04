import * as DateTime from "effect/DateTime";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Exit from "effect/Exit";
import * as Semaphore from "effect/Semaphore";
import { HttpClient, HttpClientResponse } from "effect/http";
import type * as HttpClientError from "effect/http/HttpClientError";

const encodeKey = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const sampleTimes = new WeakMap<HttpClientResponse.HttpClientResponse, string>();

export function usageResponseCheckedAt(
  response: HttpClientResponse.HttpClientResponse,
  fallback: string,
) {
  return sampleTimes.get(response) ?? fallback;
}

export const UsageAccountIdentity = Context.Reference<string | undefined>(
  "t3/provider/UsageAccountIdentity",
  { defaultValue: () => undefined },
);

const TTL_MS = 5 * 60_000;

function isUsageUrl(url: string) {
  const parsed = URL.parse(url);
  if (!parsed) return false;
  return (
    (parsed.hostname === "api.anthropic.com" && parsed.pathname === "/api/oauth/usage") ||
    (parsed.hostname === "opencode.ai" && parsed.pathname === "/zen/go/v1/usage") ||
    (parsed.hostname === "cli-chat-proxy.grok.com" && parsed.pathname === "/v1/billing") ||
    parsed.pathname === "/aiserver.v1.DashboardService/GetCurrentPeriodUsage" ||
    (["daily-cloudcode-pa.googleapis.com", "cloudcode-pa.googleapis.com"].includes(
      parsed.hostname,
    ) &&
      ["/v1internal:fetchAvailableModels", "/v1internal:retrieveUserQuotaSummary"].includes(
        parsed.pathname,
      ))
  );
}

export function usageRetryDelay(header: string | undefined, now: number) {
  if (header === undefined) return TTL_MS;
  const seconds = /^\d+(?:\.\d+)?$/.test(header.trim()) ? Number(header) : NaN;
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - now;
  return Number.isFinite(delay) && delay >= 0 ? Math.max(1000, delay) : TTL_MS;
}

export const makeUsageHttpClient = Effect.fn("makeUsageHttpClient")(function (
  client: HttpClient.HttpClient,
) {
  return Effect.sync(() => {
    type Snapshot = {
      readonly checkedAt: string;
      readonly status: number;
      readonly headers: Readonly<Record<string, string>>;
      readonly body: ArrayBuffer;
    };
    const cached = new Map<
      string,
      {
        readonly accountKey: string;
        readonly result: Exit.Exit<Snapshot, HttpClientError.HttpClientError>;
        readonly expiresAt: number;
      }
    >();
    const accounts = new Map<
      string,
      { readonly lock: Semaphore.Semaphore; retryAt: number; generation: number }
    >();
    const cachedClient = HttpClient.transform(client, (read, request) => {
      if (!isUsageUrl(request.url)) return read;
      return Effect.gen(function* () {
        const identity = yield* UsageAccountIdentity;
        const accountKey = encodeKey([
          new URL(request.url).origin,
          identity === undefined ? (request.headers.authorization ?? "") : ["account", identity],
        ]);
        let account = accounts.get(accountKey);
        if (!account) {
          account = { lock: Semaphore.makeUnsafe(1), retryAt: 0, generation: 0 };
          accounts.set(accountKey, account);
        }
        const state = account;
        const key = encodeKey([
          accountKey,
          request.headers.authorization ?? "",
          request.method,
          request.url,
          request.urlParams,
          request.body,
        ]);
        return yield* state.lock.withPermits(1)(
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            const previous = cached.get(key);
            if (previous && now < previous.expiresAt) {
              const saved = yield* previous.result;
              const response = HttpClientResponse.fromWeb(
                request,
                new Response(saved.body.slice(0), saved),
              );
              sampleTimes.set(response, saved.checkedAt);
              return response;
            }
            if (now < state.retryAt) {
              return HttpClientResponse.fromWeb(
                request,
                new Response(null, {
                  status: 429,
                  headers: { "retry-after": String(Math.ceil((state.retryAt - now) / 1000)) },
                }),
              );
            }
            const generation = state.generation;
            const result = yield* read.pipe(
              Effect.flatMap((response) =>
                Effect.gen(function* () {
                  if (
                    response.status === 429 ||
                    (response.status >= 500 && response.headers["retry-after"] !== undefined)
                  ) {
                    state.retryAt =
                      (yield* Clock.currentTimeMillis) +
                      usageRetryDelay(
                        response.headers["retry-after"],
                        yield* Clock.currentTimeMillis,
                      );
                  }
                  return {
                    checkedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
                    status: response.status,
                    headers: response.headers,
                    body: yield* response.arrayBuffer,
                  };
                }),
              ),
              Effect.exit,
            );
            const finishedAt = yield* Clock.currentTimeMillis;
            if (
              generation === state.generation ||
              Exit.isFailure(result) ||
              result.value.status >= 400
            )
              cached.set(key, {
                accountKey,
                result,
                expiresAt: Math.max(finishedAt + TTL_MS, state.retryAt),
              });
            const saved = yield* result;
            const response = HttpClientResponse.fromWeb(
              request,
              new Response(saved.body.slice(0), saved),
            );
            sampleTimes.set(response, saved.checkedAt);
            return response;
          }),
        );
      });
    });
    return Object.assign(cachedClient, {
      invalidateSuccessfulReads: (origin: string, authorization: string) =>
        Effect.sync(() => {
          const accountKey = encodeKey([origin, authorization]);
          const account = accounts.get(accountKey);
          if (account) account.generation++;
          for (const [key, saved] of cached) {
            if (
              saved.accountKey === accountKey &&
              Exit.isSuccess(saved.result) &&
              saved.result.value.status < 400
            )
              cached.delete(key);
          }
        }),
      isCoolingDown: (origin: string, authorization: string) =>
        Effect.map(
          Clock.currentTimeMillis,
          (now) => now < (accounts.get(encodeKey([origin, authorization]))?.retryAt ?? 0),
        ),
    });
  });
});
