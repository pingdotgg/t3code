import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";
import * as Headers from "effect/http/Headers";
import { GraphQLClientError, GraphQLMiddleware, GraphQLProtocol } from "effect/graphql";
import { collectUint8StreamText } from "@t3tools/provider-core/server/collectStreamText";
import { IssueTrackerKind } from "@t3tools/contracts";
import { IssueTrackerError } from "@t3tools/issue-tracker-core/server/IssueTracker";
import * as IssueTrackerHost from "@t3tools/issue-tracker-core/server/IssueTrackerHost";
import * as RateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";

const KIND = IssueTrackerKind.make("linear");
const LinearApiConfig = Config.all({
  apiUrl: Config.String("T3CODE_LINEAR_API_URL").pipe(
    Config.withDefault("https://api.linear.app/graphql"),
  ),
});

interface Observation {
  response?: HttpClientResponse.HttpClientResponse;
  text?: string;
  answer?: GraphQLProtocol.ExecutionResult;
  failure?: "read" | "invalid";
}

export class LinearGraphQlTarget extends Context.Service<
  LinearGraphQlTarget,
  {
    readonly key: string;
    readonly observation: Observation;
  }
>()("@t3tools/issue-tracker-linear/server/linearGraphQlClient/LinearGraphQlTarget") {}

export class LinearGraphQlAuth extends GraphQLMiddleware.Service<
  LinearGraphQlAuth,
  {
    requires: LinearGraphQlTarget;
  }
>()("@t3tools/issue-tracker-linear/server/linearGraphQlClient/LinearGraphQlAuth") {}

const fail = (
  operation: string,
  reason: IssueTrackerError["reason"],
  detail: string,
  extra: { readonly retryAt?: number; readonly cause?: unknown } = {},
) =>
  new IssueTrackerError({
    tracker: KIND,
    operation,
    reason,
    detail,
    ...(extra.retryAt === undefined ? {} : { retryAt: extra.retryAt }),
    ...(extra.cause === undefined ? {} : { cause: extra.cause }),
  });

const isRateLimited = (errors: ReadonlyArray<GraphQLClientError.GraphQLError> | undefined) =>
  errors?.some((error) => error.extensions?.code === "RATELIMITED") === true;

const isUnauthenticated = (errors: ReadonlyArray<GraphQLClientError.GraphQLError> | undefined) =>
  errors?.some((error) => error.extensions?.code === "AUTHENTICATION_ERROR") === true;

const errorDetail = (
  errors: ReadonlyArray<GraphQLClientError.GraphQLError> | undefined,
  fallback: string,
) => {
  const code = errors?.[0]?.extensions?.code;
  if (typeof code !== "string" || code.length > 64) return fallback;
  switch (code) {
    case "BAD_USER_INPUT":
    case "GRAPHQL_VALIDATION_FAILED":
      return "Linear rejected the request input.";
    case "FORBIDDEN":
      return "Linear denied access to this resource.";
    case "INTERNAL_SERVER_ERROR":
      return "Linear could not complete the request.";
    default:
      return fallback;
  }
};

const decodeViewerId = Schema.decodeUnknownOption(
  Schema.Struct({ viewer: Schema.Struct({ id: Schema.String }) }),
);

export const make = Effect.gen(function* () {
  const config = yield* LinearApiConfig.pipe(Effect.orDie);
  const httpClient = yield* HttpClient.HttpClient;
  const host = yield* IssueTrackerHost.IssueTrackerHost;
  const crypto = yield* Crypto.Crypto;
  const rateLimits = yield* RateLimit.SourceControlRateLimit;
  const rateKey = { provider: KIND, host: new URL(config.apiUrl).host };
  const identities = new Map<string, string>();
  const endpoints = new Map<string, Set<string>>();
  const scopeFor = (identity: string, endpoint?: string) =>
    endpoint === undefined ? identity : `${identity}\0endpoint:${endpoint}`;
  const checkLimit = (identity: string, endpoint?: string, allowPaused = false) =>
    rateLimits
      .check(rateKey, { allowPaused })
      .pipe(Effect.provideService(RateLimit.CredentialScope, scopeFor(identity, endpoint)));

  const storedToken = (operation: string) =>
    host.credentials
      .get(KIND)
      .pipe(
        Effect.flatMap(
          Effect.fromOption(() =>
            fail(operation, "unauthenticated", "Linear is not connected on this server."),
          ),
        ),
      );

  const call = <A>(
    operation: string,
    document: string,
    effect: Effect.Effect<A, GraphQLClientError.GraphQLClientError, LinearGraphQlTarget>,
    token?: string,
  ): Effect.Effect<A, IssueTrackerError> =>
    Effect.gen(function* () {
      const key = token ?? (yield* storedToken(operation));
      const fingerprint = yield* crypto
        .digest("SHA-256", new TextEncoder().encode(key))
        .pipe(Effect.map(Hex.encode), Effect.orDie);
      const credentialScope = identities.get(fingerprint) ?? fingerprint;
      const scopes = [undefined, ...(endpoints.get(document) ?? [])];
      const checks = yield* Effect.forEach(scopes, (scope) =>
        checkLimit(credentialScope, scope).pipe(Effect.result),
      );
      const paused = checks.flatMap((result) =>
        result._tag === "Failure" ? [result.failure.retryAt] : [],
      );
      if (paused.length > 0)
        return yield* fail(operation, "rate-limited", "Linear's rate limit was reached.", {
          retryAt: Math.max(...paused),
        });
      const leases = new Map(
        checks.flatMap((result, index) =>
          result._tag === "Success" ? [[scopes[index], result.success] as const] : [],
        ),
      );
      const leaseFor = (scope?: string) => {
        const identity = identities.get(fingerprint) ?? fingerprint;
        const lease = identity === credentialScope ? leases.get(scope) : undefined;
        return lease === undefined
          ? checkLimit(identity, scope, true).pipe(Effect.orDie)
          : Effect.succeed(lease);
      };
      const recordLimit = (scope?: string, retryAt?: number) =>
        Effect.gen(function* () {
          const lease = yield* leaseFor(scope);
          yield* rateLimits
            .recordRateLimit({ ...rateKey, lease, retryAt })
            .pipe(
              Effect.provideService(
                RateLimit.CredentialScope,
                scopeFor(identities.get(fingerprint) ?? fingerprint, scope),
              ),
            );
        });
      const observation: Observation = {};
      const result = yield* effect.pipe(
        Effect.provideService(LinearGraphQlTarget, { key, observation }),
        Effect.result,
      );
      const response = observation.response;
      if (response === undefined)
        return yield* fail(operation, "failed", "Linear could not be reached.");
      const now = yield* Clock.currentTimeMillis;
      const exhausted = ["requests", "complexity", "endpoint-requests"].filter((window) => {
        const remaining = response.headers[`x-ratelimit-${window}-remaining`]?.trim();
        return remaining !== undefined && /^-?\d+$/u.test(remaining) && Number(remaining) <= 0;
      });
      const resetAt = (window: string) => {
        const value = response.headers[`x-ratelimit-${window}-reset`];
        const reset = value === undefined || !/^\d+$/u.test(value.trim()) ? NaN : Number(value);
        return Number.isSafeInteger(reset) && reset > now ? reset : undefined;
      };
      const retryAfter = RateLimit.retryAtFromHeader(response.headers["retry-after"], now);
      const latestReset = (windows: ReadonlyArray<string>) => {
        const resets = windows.flatMap((window) => {
          const reset = resetAt(window);
          return reset === undefined ? [] : [reset];
        });
        if (retryAfter !== undefined) resets.push(retryAfter);
        return resets.length === 0 ? undefined : Math.max(...resets);
      };
      const namedEndpoint = response.headers["x-ratelimit-endpoint-name"]?.trim() || undefined;
      if (namedEndpoint !== undefined) {
        const names = endpoints.get(document) ?? new Set<string>();
        names.add(namedEndpoint);
        endpoints.set(document, names);
      }
      const recordLimits = (unknown = false) =>
        Effect.gen(function* () {
          const globalWindows = exhausted.filter((window) => window !== "endpoint-requests");
          if (globalWindows.length > 0) yield* recordLimit(undefined, latestReset(globalWindows));
          if (exhausted.includes("endpoint-requests"))
            yield* recordLimit(namedEndpoint, latestReset(["endpoint-requests"]));
          if (unknown && exhausted.length === 0) yield* recordLimit(undefined, retryAfter);
        });
      const retryAt = latestReset(exhausted);
      const rateLimited = (cause?: string) =>
        Effect.gen(function* () {
          yield* recordLimits(true);
          return yield* fail(operation, "rate-limited", "Linear's rate limit was reached.", {
            ...(retryAt === undefined ? {} : { retryAt }),
            ...(cause === undefined ? {} : { cause }),
          });
        });
      if (response.status === 429) return yield* rateLimited();
      if (response.status === 401 || response.status === 403) {
        return yield* fail(operation, "unauthenticated", "Linear rejected the API key.");
      }
      if (observation.failure !== undefined)
        return yield* fail(
          operation,
          "failed",
          observation.failure === "read"
            ? "Linear response could not be read."
            : "Linear returned an oversized or invalid response.",
        );
      const envelope = observation.answer;
      if (envelope === undefined) {
        yield* recordLimits();
        return yield* fail(
          operation,
          "failed",
          `Linear returned HTTP ${response.status} with an unexpected body.`,
        );
      }
      if (isRateLimited(envelope.errors)) return yield* rateLimited(observation.text);
      if (isUnauthenticated(envelope.errors)) {
        return yield* fail(operation, "unauthenticated", "Linear rejected the API key.", {
          cause: observation.text,
        });
      }
      if (
        response.status < 200 ||
        response.status >= 300 ||
        (envelope.errors?.length ?? 0) > 0 ||
        envelope.data === undefined ||
        envelope.data === null
      ) {
        yield* recordLimits();
        const missingIssue =
          (operation === "getIssue" || operation === "getIssueReference") &&
          (response.status === 200 || response.status === 400) &&
          envelope.data == null &&
          envelope.errors?.length === 1 &&
          /^Entity not found: Issue(?:$| - )/.test(envelope.errors[0]?.message ?? "");
        return yield* fail(
          operation,
          missingIssue ? "not-found" : "failed",
          missingIssue
            ? "Linear has no issue by that identifier, or this account cannot see it."
            : errorDetail(envelope.errors, `Linear returned HTTP ${response.status}.`),
          { cause: observation.text },
        );
      }
      if (result._tag === "Failure") {
        yield* recordLimits();
        return yield* fail(operation, "failed", "Linear returned an unexpected response.");
      }
      const decoded = result.success;
      const viewer = decodeViewerId(decoded);
      if (Option.isSome(viewer) && identities.get(fingerprint) !== viewer.value.viewer.id) {
        identities.set(fingerprint, viewer.value.viewer.id);
        for (const scope of [
          undefined,
          ...new Set([...endpoints.values()].flatMap((names) => [...names])),
        ]) {
          const previous = yield* checkLimit(credentialScope, scope).pipe(Effect.result);
          if (previous._tag === "Failure") yield* recordLimit(scope, previous.failure.retryAt);
        }
        for (const scope of scopes)
          yield* checkLimit(viewer.value.viewer.id, scope).pipe(
            Effect.mapError((error) =>
              fail(operation, "rate-limited", error.detail, { retryAt: error.retryAt }),
            ),
          );
      }
      yield* recordLimits();
      for (const scope of [undefined, ...(endpoints.get(document) ?? [])]) {
        const lease = yield* leaseFor(scope);
        yield* rateLimits
          .recordSuccess({ ...rateKey, lease })
          .pipe(
            Effect.provideService(
              RateLimit.CredentialScope,
              scopeFor(identities.get(fingerprint) ?? fingerprint, scope),
            ),
          );
      }
      return decoded;
    }).pipe(
      Effect.timeoutOrElse({
        duration: "30 seconds",
        orElse: () => Effect.fail(fail(operation, "failed", "Linear request timed out.")),
      }),
    );

  const layer = Layer.merge(
    Layer.succeed(
      LinearGraphQlAuth,
      LinearGraphQlAuth.of({
        execute: ({ request, next }) =>
          Effect.gen(function* () {
            const { key, observation } = yield* LinearGraphQlTarget;
            return yield* next({
              ...request,
              headers: Headers.set(request.headers, "authorization", key),
            }).pipe(
              Effect.tap((answer) =>
                Effect.sync(() => {
                  observation.answer = answer;
                }),
              ),
            );
          }),
        subscribe: () => Stream.empty,
      }),
    ),
    GraphQLProtocol.layerHttp({ url: config.apiUrl }).pipe(
      Layer.provide(
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.transformResponse(httpClient, (response) =>
            Effect.gen(function* () {
              const observed = yield* response;
              const { observation } = Option.getOrThrow(
                yield* Effect.serviceOption(LinearGraphQlTarget),
              );
              observation.response = observed;
              if (observed.status === 401 || observed.status === 403 || observed.status === 429)
                return yield* HttpClientResponse.filterStatusOk(observed);
              const collected = yield* collectUint8StreamText({
                stream: observed.stream,
                maxBytes: 4 * 1024 * 1024,
              }).pipe(
                Effect.mapError(() => {
                  observation.failure = "read";
                  return new HttpClientError.HttpClientError({
                    reason: new HttpClientError.DecodeError({
                      request: observed.request,
                      response: observed,
                    }),
                  });
                }),
              );
              if (collected.truncated || collected.invalidUtf8) {
                observation.failure = "invalid";
                return yield* new HttpClientError.HttpClientError({
                  reason: new HttpClientError.DecodeError({
                    request: observed.request,
                    response: observed,
                  }),
                });
              }
              observation.text = collected.text;
              return HttpClientResponse.fromWeb(
                observed.request,
                new Response(collected.text === "" ? null : collected.text, {
                  status: observed.status,
                  headers: Headers.set(
                    observed.headers,
                    "content-type",
                    "application/graphql-response+json",
                  ),
                }),
              );
            }).pipe(Effect.provideService(HttpClient.TracerDisabledWhen, () => true)),
          ),
        ),
      ),
    ),
  );
  return { call, layer };
});
