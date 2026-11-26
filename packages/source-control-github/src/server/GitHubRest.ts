import { normalizeHost } from "@t3tools/source-control-core/server/pullRequestUtils";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  type HttpClientResponse,
  type HttpClientError,
} from "effect/http";

import { collectUint8StreamText } from "@t3tools/provider-core/server/collectStreamText";
import * as GitHubAppSignIn from "./GitHubAppSignIn.ts";
import * as GitHubCredentials from "./GitHubCredentials.ts";
import * as GitHubQuota from "./GitHubQuota.ts";
import * as GitHubRequestPolicy from "./GitHubRequestPolicy.ts";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";

const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
// fetch would otherwise follow the redirect itself, hiding it from the credential checks below.
const MANUAL_REDIRECT: RequestInit = { redirect: "manual" };
const { gitHubApiUrls } = GitHubRequestPolicy;
type GitHubApiError = GitHubRequestPolicy.GitHubApiError;

export interface GitHubRestResponse {
  readonly totalLines?: number;
  readonly status: number;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: string;
  readonly truncated: boolean;
  /** Invalid UTF-8 indicates a binary raw file. */
  readonly invalidUtf8: boolean;
}

interface RestBody {
  readonly text: string;
  readonly truncated: boolean;
  readonly invalidUtf8: boolean;
  readonly totalLines?: number;
}

function readResponseBody(
  input: {
    readonly readBody?: GitHubRestInput["readBody"] | undefined;
    readonly maxResponseBytes?: number | undefined;
  },
  response: HttpClientResponse.HttpClientResponse,
): Effect.Effect<RestBody, HttpClientError.HttpClientError> {
  return input.readBody !== undefined && response.status >= 200 && response.status < 300
    ? input.readBody(response)
    : collectUint8StreamText({
        stream: response.stream,
        maxBytes: input.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      });
}

export interface GitHubRestInput {
  readonly host: string;
  readonly operation: string;
  readonly method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Relative to the API root, including query string. */
  readonly path: string;
  readonly body?: unknown;
  /** Defaults to `application/vnd.github+json`. */
  readonly accept?: string;
  /** Revalidate cached answers; 304 returns successfully without spending quota. */
  readonly ifNoneMatch?: string;
  readonly maxResponseBytes?: number;
  /** Use the status and headers for a success, but still read error bodies. */
  readonly discardSuccessBody?: boolean;
  /** Defaults to 30 seconds; a whole pull request's patch may need longer. */
  readonly timeout?: Duration.Input;
  /** Overrides `SourceControlRateLimit.Interactive` for this one request. */
  readonly allowReserve?: boolean;
  readonly followRedirect?: "unauthenticated";
  readonly readBody?: (
    response: HttpClientResponse.HttpClientResponse,
  ) => Effect.Effect<RestBody, HttpClientError.HttpClientError>;
}

export class GitHubRest extends Context.Service<
  GitHubRest,
  {
    readonly rest: (input: GitHubRestInput) => Effect.Effect<GitHubRestResponse, GitHubApiError>;
    readonly credential: GitHubRequestPolicy.GitHubRequestPolicy["Service"]["credential"];
    readonly appCredential: GitHubRequestPolicy.GitHubRequestPolicy["Service"]["appCredential"];
  }
>()("@t3tools/source-control-github/server/GitHubRest") {}

const decodeRestErrors = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      message: Schema.optional(Schema.String),
      errors: Schema.optional(
        Schema.Array(
          Schema.Union([
            Schema.String,
            Schema.Struct({
              message: Schema.optional(Schema.String),
              field: Schema.optional(Schema.String),
              code: Schema.optional(Schema.String),
            }),
          ]),
        ),
      ),
    }),
  ),
);

function restErrorMessages(body: string): ReadonlyArray<string> | undefined {
  return Option.match(decodeRestErrors(body), {
    onNone: () => undefined,
    onSome: (decoded) => {
      const details = (decoded.errors ?? []).flatMap((error) =>
        typeof error === "string"
          ? [error]
          : error.message !== undefined
            ? [error.message]
            : error.field !== undefined && error.code !== undefined
              ? [`${error.field} ${error.code}`]
              : [],
      );
      const messages = [...(decoded.message === undefined ? [] : [decoded.message]), ...details];
      return messages.length > 0 ? messages : undefined;
    },
  });
}

/** Accept 304 only for cache revalidation. */
function classify(input: {
  readonly answer: GitHubRestResponse;
  readonly acceptNotModified: boolean;
  readonly acceptRedirect?: boolean;
}): GitHubRequestPolicy.GitHubAnswer<GitHubRestResponse> {
  const { status, headers, body } = input.answer;
  const meta = { status, headers };
  if (GitHubRequestPolicy.isRateLimited({ status, headers, body })) {
    return {
      _tag: "RateLimited",
      secondary: GitHubRequestPolicy.isSecondaryRateLimited({ headers, body }),
      ...meta,
    };
  }
  if (status === 401) return { _tag: "Unauthorized", ...meta };
  if (status === 404) return { _tag: "NotFound", ...meta };
  if (
    (status >= 200 && status < 300) ||
    (status === 304 && input.acceptNotModified) ||
    (status === 302 && input.acceptRedirect)
  ) {
    return { _tag: "Ok", value: input.answer, ...meta };
  }
  return { _tag: "Failed", messages: restErrorMessages(body), ...meta };
}

/** @public */
export const make = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;
  const scopedClient = HttpClient.withScope(httpClient);
  const policy = yield* GitHubRequestPolicy.GitHubRequestPolicy;

  const send = Effect.fn("GitHubRest.send")(function* (input: {
    readonly host: string;
    readonly operation: string;
    readonly request: HttpClientRequest.HttpClientRequest;
    readonly maxResponseBytes: number;
    readonly timeout?: Duration.Input | undefined;
    readonly allowReserve: boolean;
    readonly acceptNotModified: boolean;
    readonly followRedirect?: "unauthenticated" | undefined;
    readonly readBody?: GitHubRestInput["readBody"] | undefined;
    readonly discardSuccessBody: boolean;
  }) {
    const host = normalizeHost(input.host);
    // Query strings can expose SHAs or branches in traces.
    yield* Effect.annotateCurrentSpan({
      "github.kind": "rest",
      "http.request.method": input.request.method,
      "url.path": new URL(input.request.url).pathname,
    });
    return yield* policy.request(
      {
        host,
        operation: input.operation,
        // All current paths spend `core`; search would need a different resource.
        resource: "core",
        allowReserve: input.allowReserve,
        timeout: input.timeout,
      },
      (headers) =>
        Effect.gen(function* () {
          const execute = (input.discardSuccessBody ? scopedClient : httpClient)
            .execute(input.request.pipe(HttpClientRequest.setHeaders(headers)))
            .pipe(
              // Client spans expose SHAs and branches through url.full/url.query.
              Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
            );
          const response: HttpClientResponse.HttpClientResponse = yield* input.followRedirect ===
          undefined
            ? execute
            : Effect.provideService(execute, FetchHttpClient.RequestInit, MANUAL_REDIRECT);
          const { status, headers: responseHeaders } = response;
          const collected: RestBody =
            input.discardSuccessBody && status >= 200 && status < 300
              ? { text: "", truncated: false, invalidUtf8: false }
              : yield* readResponseBody(input, response).pipe(
                  Effect.catchIf(
                    (error) => error.reason._tag === "EmptyBodyError",
                    () =>
                      Effect.succeed<RestBody>({ text: "", truncated: false, invalidUtf8: false }),
                  ),
                );
          const answer = {
            status,
            headers: responseHeaders,
            body: collected.text,
            truncated: collected.truncated,
            invalidUtf8: collected.invalidUtf8,
            ...(collected.totalLines === undefined ? {} : { totalLines: collected.totalLines }),
          };
          return classify({
            answer,
            acceptNotModified: input.acceptNotModified,
            acceptRedirect: input.followRedirect !== undefined,
          });
        }).pipe(
          Effect.scoped,
          Effect.mapError(
            (cause) =>
              new GitHubRequestPolicy.GitHubApiRequestError({
                host,
                operation: input.operation,
                cause,
              }),
          ),
        ),
    );
  });

  const rest: GitHubRest["Service"]["rest"] = (input) => {
    const url = `${gitHubApiUrls(input.host).rest}/${input.path.replace(/^\/+/, "")}`;
    const base = HttpClientRequest.make(input.method ?? "GET")(url).pipe(
      HttpClientRequest.setHeader("accept", input.accept ?? "application/vnd.github+json"),
    );
    const withEtag =
      input.ifNoneMatch === undefined
        ? base
        : base.pipe(HttpClientRequest.setHeader("if-none-match", input.ifNoneMatch));
    const request =
      input.body === undefined
        ? withEtag
        : withEtag.pipe(HttpClientRequest.bodyJsonUnsafe(input.body));
    return SourceControlRateLimit.Interactive.pipe(
      Effect.flatMap((interactive) =>
        send({
          host: input.host,
          operation: input.operation,
          request,
          maxResponseBytes: input.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
          timeout: input.timeout,
          allowReserve: input.allowReserve ?? interactive,
          acceptNotModified: input.ifNoneMatch !== undefined,
          followRedirect: input.followRedirect,
          readBody: input.readBody,
          discardSuccessBody: input.discardSuccessBody === true,
        }),
      ),
      Effect.flatMap(
        Effect.fn("GitHubRest.redirect")(
          function* (answer: GitHubRestResponse) {
            if (answer.status !== 302 || input.followRedirect !== "unauthenticated") return answer;
            const location = answer.headers.location;
            const target = location === undefined ? null : URL.parse(location);
            if (target?.protocol !== "https:" || target.username || target.password) {
              return yield* new GitHubRequestPolicy.GitHubApiResponseError({
                host: input.host,
                operation: input.operation,
                status: 302,
              });
            }
            // A signed blob URL is a separate authority and must never receive GitHub credentials.
            const response = yield* httpClient.execute(HttpClientRequest.get(target.href)).pipe(
              Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
              Effect.mapError(
                (cause) =>
                  new GitHubRequestPolicy.GitHubApiRequestError({
                    host: input.host,
                    operation: input.operation,
                    cause,
                  }),
              ),
            );
            if (response.status < 200 || response.status >= 300) {
              return yield* new GitHubRequestPolicy.GitHubApiResponseError({
                host: input.host,
                operation: input.operation,
                status: response.status,
              });
            }
            const collected = yield* readResponseBody(input, response).pipe(
              Effect.mapError(
                (cause) =>
                  new GitHubRequestPolicy.GitHubApiRequestError({
                    host: input.host,
                    operation: input.operation,
                    cause,
                  }),
              ),
            );
            return {
              status: response.status,
              headers: response.headers,
              body: collected.text,
              truncated: collected.truncated,
              invalidUtf8: collected.invalidUtf8,
              ...(collected.totalLines === undefined ? {} : { totalLines: collected.totalLines }),
            };
          },
          Effect.timeoutOrElse({
            duration: input.timeout ?? "30 seconds",
            orElse: () =>
              Effect.fail(
                new GitHubRequestPolicy.GitHubApiRequestError({
                  host: input.host,
                  operation: input.operation,
                  cause: new Error("Log download timed out"),
                }),
              ),
          }),
        ),
      ),
    );
  };

  return GitHubRest.of({
    rest,
    credential: policy.credential,
    appCredential: policy.appCredential,
  });
});

export const layer = Layer.effect(GitHubRest, make).pipe(
  Layer.provideMerge(GitHubRequestPolicy.layer),
);

/**
 * REST and the request policy, with the credential and quota reserve the policy reads through.
 * Built once, so every GitHub reader shares one view of each quota per host. The rate-limit pause
 * comes from the server, which every host's change request reads share.
 */
export const layerWithDependencies = layer.pipe(
  Layer.provideMerge(GitHubCredentials.layer),
  Layer.provideMerge(GitHubAppSignIn.layer),
  Layer.provideMerge(GitHubQuota.layer),
);
