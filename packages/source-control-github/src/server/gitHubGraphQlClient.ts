import { normalizeHost } from "@t3tools/source-control-core/server/pullRequestUtils";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { dual } from "effect/Function";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";
import * as Headers from "effect/http/Headers";
import { GraphQLClientError, GraphQLMiddleware, GraphQLProtocol } from "effect/graphql";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import { collectUint8StreamText } from "@t3tools/provider-core/server/collectStreamText";

import * as GitHubRequestPolicy from "./GitHubRequestPolicy.ts";

const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/** One client serves all hosts; each call must supply its target. */
export class GitHubGraphQlTarget extends Context.Service<
  GitHubGraphQlTarget,
  {
    readonly host: string;
    readonly operation: string;
    /** Overrides `SourceControlRateLimit.Interactive` for this one call. */
    readonly allowReserve?: boolean | undefined;
    /** A longer answer fails as a `GitHubApiResponseError`. Defaults to 8 MB. */
    readonly maxResponseBytes?: number | undefined;
  }
>()("@t3tools/source-control-github/server/gitHubGraphQlClient/GitHubGraphQlTarget") {}

// Group traces by query without exposing query text.
function queryHash(query: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < query.length; index++) {
    hash ^= query.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export const isNotFoundOnly = (error: unknown): boolean =>
  GraphQLClientError.isGraphQLClientError(error) &&
  error.reason._tag === "ResponseError" &&
  error.reason.errors.every((graphQlError) => graphQlError["type"] === "NOT_FOUND");

/** Share REST's credentials/slots/quota/pause; leave non-rate-limit errors to each lookup. */
export class GitHubGraphQlAuth extends GraphQLMiddleware.Service<
  GitHubGraphQlAuth,
  { requires: GitHubGraphQlTarget; error: GitHubRequestPolicy.GitHubApiError }
>()("@t3tools/source-control-github/server/gitHubGraphQlClient/GitHubGraphQlAuth") {
  static readonly layer = Layer.effect(
    GitHubGraphQlAuth,
    Effect.gen(function* () {
      const policy = yield* GitHubRequestPolicy.GitHubRequestPolicy;
      return GitHubGraphQlAuth.of({
        execute: Effect.fn("GitHubGraphQlAuth.execute")(function* ({ request, next }) {
          const target = yield* GitHubGraphQlTarget;
          const host = normalizeHost(target.host);
          yield* Effect.annotateCurrentSpan({
            "github.kind": "graphql",
            "github.graphql.query_hash": queryHash(request.query),
          });
          return yield* policy.request(
            {
              host,
              operation: target.operation,
              resource: "graphql",
              allowReserve: target.allowReserve ?? (yield* SourceControlRateLimit.Interactive),
            },
            (headers) =>
              next({ ...request, headers: Headers.setAll(request.headers, headers) }).pipe(
                Effect.map((answer) => {
                  const status = answer.status;
                  const responseHeaders = answer.headers ?? Headers.empty;
                  const rateLimited = GitHubRequestPolicy.isRateLimited({
                    status: status ?? 200,
                    headers: responseHeaders,
                    ...(answer.errors === undefined ? {} : { graphqlErrors: answer.errors }),
                  });
                  const withheld = (answer.errors ?? []).some(
                    (error) => error["type"] === "NOT_FOUND" || error["type"] === "FORBIDDEN",
                  );
                  return rateLimited
                    ? { _tag: "RateLimited" as const, status, headers: responseHeaders }
                    : {
                        _tag: "Ok" as const,
                        value: answer,
                        withheld,
                        status,
                        headers: responseHeaders,
                      };
                }),
                Effect.catchIf(GraphQLClientError.isGraphQLClientError, (error) =>
                  refused(error, { host, operation: target.operation }),
                ),
              ),
          );
        }),
        subscribe: () => Stream.die(new Error("GitHub GraphQL has no subscriptions.")),
      });
    }),
  );
}

/**
 * What a refusal GitHub sent as an HTTP status means, read the way REST reads one. A
 * failure that never reached GitHub is a request error; one that is not about the transport
 * (an answer that does not decode) is the client's own.
 */
const refused = Effect.fn("gitHubGraphQlClient.refused")(function* (
  error: GraphQLClientError.GraphQLClientError,
  context: { readonly host: string; readonly operation: string },
) {
  const reason = error.reason;
  if (reason._tag !== "TransportError" && reason._tag !== "ResponseError") {
    return yield* error;
  }
  const status = reason.status;
  if (reason._tag === "TransportError" && status === undefined) {
    return yield* new GitHubRequestPolicy.GitHubApiRequestError({ ...context, cause: error });
  }
  const headers = reason.headers ?? Headers.empty;
  // A secondary limit is a 403 that only its body names, which the transport read.
  const body =
    reason._tag === "TransportError" &&
    HttpClientError.isHttpClientError(reason.cause) &&
    reason.cause.response !== undefined
      ? yield* reason.cause.response.text.pipe(Effect.orElseSucceed(() => ""))
      : "";
  const tag = GitHubRequestPolicy.isRateLimited({
    status: status ?? 200,
    headers,
    body,
    ...(reason._tag === "ResponseError" ? { graphqlErrors: reason.errors } : {}),
  })
    ? "RateLimited"
    : status === 401
      ? "Unauthorized"
      : status === 404
        ? "NotFound"
        : "Failed";
  return { _tag: tag, status: status ?? 200, headers } as const;
});

/**
 * Reads each answer whole, up to the call's byte cap, before the protocol parses it. A body cut
 * at the cap hides any `errors` past the cut and cannot be decoded, so it fails, which the
 * middleware reports as a `GitHubApiResponseError` with the answer's status.
 */
const capResponse = Effect.fn("gitHubGraphQlClient.capResponse")(function* (
  effect: Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError>,
) {
  const response = yield* effect;
  const target = yield* Effect.serviceOption(GitHubGraphQlTarget);
  const maxBytes = Option.match(target, {
    onNone: () => DEFAULT_MAX_RESPONSE_BYTES,
    onSome: (target) => target.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
  });
  const collected = yield* collectUint8StreamText({ stream: response.stream, maxBytes }).pipe(
    Effect.catchIf(
      (error) => error.reason._tag === "EmptyBodyError",
      () => Effect.succeed({ text: "", truncated: false }),
    ),
  );
  if (collected.truncated) {
    return yield* new HttpClientError.HttpClientError({
      reason: new HttpClientError.DecodeError({
        request: response.request,
        response,
        description: `The answer is longer than ${maxBytes} bytes.`,
      }),
    });
  }
  return HttpClientResponse.fromWeb(
    response.request,
    new Response(collected.text === "" ? null : collected.text, {
      status: response.status,
      headers: response.headers,
    }),
  );
});

// Endpoint URLs isolate hosts. Disable client tracing to protect SHAs and branches in url.full.
const layerProtocol = GraphQLProtocol.layerHttp({
  url: ({ context }) =>
    GitHubRequestPolicy.gitHubApiUrls(Context.getUnsafe(context, GitHubGraphQlTarget).host).graphql,
}).pipe(
  Layer.provide(
    Layer.effect(
      HttpClient.HttpClient,
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        return HttpClient.transformResponse(client, (effect) =>
          capResponse(effect).pipe(
            Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
          ),
        );
      }),
    ),
  ),
);

export const layer = Layer.merge(GitHubGraphQlAuth.layer, layerProtocol);

/** Isolate credentials/rate-limit scopes; transport URLs already separate hosts. */
export const batchKey = (context: Context.Context<GitHubGraphQlTarget>) =>
  JSON.stringify([
    Context.getOrElse(context, GitHubRequestPolicy.PinnedGitHubCredential, () => null)
      ?.credentialFingerprint ?? null,
    Context.getOrElse(context, SourceControlRateLimit.CredentialScope, () => ""),
  ]);

const fromClientError = (
  target: { readonly host: string; readonly operation: string },
  error: GraphQLClientError.GraphQLClientError,
):
  | GitHubRequestPolicy.GitHubApiNotFoundError
  | GitHubRequestPolicy.GitHubApiResponseError
  | GraphQLClientError.GraphQLClientError => {
  const reason = error.reason;
  if (reason._tag !== "ResponseError") return error;
  const context = {
    host: normalizeHost(target.host),
    operation: target.operation,
  };
  return isNotFoundOnly(error)
    ? new GitHubRequestPolicy.GitHubApiNotFoundError(context)
    : new GitHubRequestPolicy.GitHubApiResponseError({
        ...context,
        status: reason.status ?? 200,
        githubErrors: reason.errors.map((graphQlError) => graphQlError.message),
      });
};

/** Map response errors to policy errors; callers map decode errors to read errors. */
export const call: {
  (
    target: GitHubGraphQlTarget["Service"],
  ): <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<
    A,
    E | GitHubRequestPolicy.GitHubApiNotFoundError | GitHubRequestPolicy.GitHubApiResponseError,
    Exclude<R, GitHubGraphQlTarget>
  >;
  <A, E, R>(
    effect: Effect.Effect<A, E, R>,
    target: GitHubGraphQlTarget["Service"],
  ): Effect.Effect<
    A,
    E | GitHubRequestPolicy.GitHubApiNotFoundError | GitHubRequestPolicy.GitHubApiResponseError,
    Exclude<R, GitHubGraphQlTarget>
  >;
} = dual(2, <A, E, R>(effect: Effect.Effect<A, E, R>, target: GitHubGraphQlTarget["Service"]) =>
  effect.pipe(
    Effect.mapError((error) =>
      GraphQLClientError.isGraphQLClientError(error)
        ? (fromClientError(target, error) as
            | E
            | GitHubRequestPolicy.GitHubApiNotFoundError
            | GitHubRequestPolicy.GitHubApiResponseError)
        : error,
    ),
    Effect.provideService(GitHubGraphQlTarget, target),
  ),
);
