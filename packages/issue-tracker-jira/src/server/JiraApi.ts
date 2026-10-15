import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Hex from "effect/encoding/Hex";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";
import { IssueTrackerKind } from "@t3tools/contracts";
import { IssueTrackerError } from "@t3tools/issue-tracker-core/server/IssueTracker";
import { IssueTrackerHost } from "@t3tools/issue-tracker-core/server/IssueTrackerHost";
import { collectUint8StreamText } from "@t3tools/provider-core/server/collectStreamText";
import { retryAtFromHeader } from "@t3tools/source-control-core/server/SourceControlRateLimit";

import { JiraUser } from "./jiraJson.ts";

export const KIND = IssueTrackerKind.make("jira");
const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16_384));
const Credential = Schema.Struct({ site: Text, email: Text, token: Text });
const decodeCredential = Schema.decodeSync(Schema.fromJsonString(Credential));
const Projects = Schema.Struct({
  startAt: Schema.Int,
  total: Schema.Int,
  values: Schema.Array(Schema.Struct({ id: Text, key: Text, name: Text })).check(
    Schema.isMaxLength(100),
  ),
});

export function normalizeJiraHost(value: string): string {
  const url = new URL(value.includes("://") ? value : "https://" + value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    !/^[a-z0-9-]+\.atlassian\.net$/i.test(url.hostname)
  ) {
    throw new Error("Use a Jira Cloud site such as example.atlassian.net.");
  }
  return url.hostname.toLowerCase();
}

function parseJiraCredential(value: string) {
  const credential = decodeCredential(value);
  const email = credential.email.trim();
  const token = credential.token.trim();
  if (!email || !token) throw new Error("Enter a Jira account email and a site API token.");
  return { host: normalizeJiraHost(credential.site.trim()), email, token };
}

export const failed = (
  operation: string,
  detail: string,
  reason: IssueTrackerError["reason"] = "failed",
) => new IssueTrackerError({ tracker: KIND, operation, reason, detail });

export const attempt = <A>(operation: string, run: () => A) =>
  Effect.try({
    try: run,
    catch: () => failed(operation, "Jira returned invalid or unsupported data."),
  });

interface Request<S extends Schema.Top> {
  readonly host: string;
  readonly operation: string;
  readonly method: "GET" | "POST" | "PUT";
  readonly path: string;
  readonly schema: S;
  readonly body?: unknown;
  readonly credential?: string;
}

export class JiraApi extends Context.Service<
  JiraApi,
  {
    readonly request: <S extends Schema.Top & { readonly DecodingServices: never }>(
      input: Request<S>,
    ) => Effect.Effect<S["Type"], IssueTrackerError>;
    readonly probeCredential: (credential: string) => Effect.Effect<
      {
        readonly account: string;
        readonly accountId: string;
        readonly host: string;
        readonly scopes: ReadonlyArray<{ readonly key: string; readonly name: string }>;
        readonly scopesTruncated?: boolean;
      },
      IssueTrackerError
    >;
    readonly getScope: (
      credential: string,
      scope: string,
    ) => Effect.Effect<{ readonly key: string; readonly name: string } | null, IssueTrackerError>;
  }
>()("@t3tools/issue-tracker-jira/server/JiraApi") {}

export const make = Effect.gen(function* () {
  const http = yield* HttpClient.HttpClient;
  const host = yield* IssueTrackerHost;
  const crypto = yield* Crypto.Crypto;
  const limits = yield* SourceControlRateLimit.SourceControlRateLimit;

  const request = <S extends Schema.Top & { readonly DecodingServices: never }>(
    input: Request<S>,
  ) => {
    const decodeEmpty = Schema.decodeEffect(input.schema);
    const decodeJson = Schema.decodeEffect(Schema.fromJsonString(input.schema));
    return Effect.gen(function* () {
      const stored =
        input.credential === undefined
          ? yield* host.credentials
              .get(KIND)
              .pipe(
                Effect.flatMap(
                  Effect.fromOption(() =>
                    failed(
                      input.operation,
                      "Jira is not connected on this server.",
                      "unauthenticated",
                    ),
                  ),
                ),
              )
          : input.credential;
      const credential = yield* Effect.try({
        try: () => parseJiraCredential(stored),
        catch: () =>
          failed(
            input.operation,
            "Enter a Jira Cloud site, account email and a standard site API token.",
            "unauthenticated",
          ),
      });
      const requestedHost = yield* Effect.try({
        try: () => normalizeJiraHost(input.host),
        catch: () => failed(input.operation, "This is not a Jira Cloud tenant host."),
      });
      if (requestedHost !== credential.host)
        return yield* failed(
          input.operation,
          "This Jira credential belongs to another site.",
          "unauthenticated",
        );
      const fingerprint = yield* crypto
        .digest("SHA-256", new TextEncoder().encode(credential.token))
        .pipe(
          Effect.map(Hex.encode),
          Effect.mapError(() =>
            failed(input.operation, "The Jira credential scope could not be read."),
          ),
        );
      return yield* Effect.gen(function* () {
        const key = { provider: KIND, host: credential.host };
        const lease = yield* limits.check(key).pipe(
          Effect.mapError(
            (paused) =>
              new IssueTrackerError({
                tracker: KIND,
                operation: input.operation,
                reason: "rate-limited",
                detail: paused.detail,
                retryAt: paused.retryAt,
              }),
          ),
        );
        const base = HttpClientRequest.make(input.method)(
          "https://" + credential.host + "/rest/api/3" + input.path,
        ).pipe(
          HttpClientRequest.acceptJson,
          HttpClientRequest.basicAuth(credential.email, credential.token),
        );
        const response = yield* http
          .execute(
            input.body === undefined
              ? base
              : base.pipe(HttpClientRequest.bodyJsonUnsafe(input.body)),
          )
          .pipe(Effect.mapError(() => failed(input.operation, "Jira could not be reached.")));
        const now = yield* Clock.currentTimeMillis;
        const retryAt =
          retryAtFromHeader(response.headers["retry-after"], now) ??
          retryAtFromHeader(response.headers["x-ratelimit-reset"], now);
        const nativeError =
          response.status < 200 || response.status >= 300
            ? new IssueTrackerError({
                tracker: KIND,
                operation: input.operation,
                reason:
                  response.status === 429
                    ? "rate-limited"
                    : response.status === 401
                      ? "unauthenticated"
                      : response.status === 404
                        ? "not-found"
                        : "failed",
                detail:
                  "Jira returned HTTP " +
                  response.status +
                  (response.status === 400
                    ? ". Check required fields and the selected workflow in Jira."
                    : "."),
                ...(response.status === 429 && retryAt !== undefined ? { retryAt } : {}),
              })
            : undefined;
        if (response.status === 429) yield* limits.recordRateLimit({ ...key, lease, retryAt });
        if (response.status === 204) {
          const result = yield* decodeEmpty(undefined).pipe(
            Effect.mapError(() =>
              failed(input.operation, "Jira returned an unexpected empty response."),
            ),
          );
          yield* limits.recordSuccess({ ...key, lease });
          return result;
        }
        const collected = yield* collectUint8StreamText({
          stream: response.stream,
          maxBytes: 2 * 1024 * 1024,
        }).pipe(
          Effect.mapError(
            () => nativeError ?? failed(input.operation, "The Jira response could not be read."),
          ),
        );
        if (nativeError) return yield* nativeError;
        if (collected.truncated || collected.invalidUtf8)
          return yield* failed(input.operation, "Jira returned an oversized or invalid response.");
        const result = yield* decodeJson(collected.text).pipe(
          Effect.mapError(() => failed(input.operation, "Jira returned unexpected data.")),
        );
        yield* limits.recordSuccess({ ...key, lease });
        return result;
      }).pipe(Effect.provideService(SourceControlRateLimit.CredentialScope, fingerprint));
    }).pipe(
      Effect.timeoutOrElse({
        duration: "30 seconds",
        orElse: () => Effect.fail(failed(input.operation, "Jira request timed out.")),
      }),
    );
  };

  const probeCredential = (packed: string) =>
    Effect.gen(function* () {
      const credential = yield* Effect.try({
        try: () => parseJiraCredential(packed),
        catch: () =>
          failed(
            "probeCredential",
            "Enter a Jira Cloud site, account email and a standard site API token.",
            "unauthenticated",
          ),
      });
      const viewer = yield* request({
        host: credential.host,
        credential: packed,
        operation: "probeCredential",
        method: "GET",
        path: "/myself",
        schema: JiraUser,
      });
      const projects = yield* request({
        host: credential.host,
        credential: packed,
        operation: "probeCredential",
        method: "GET",
        path: "/project/search?startAt=0&maxResults=100",
        schema: Projects,
      });
      if (projects.startAt !== 0 || projects.total < projects.values.length)
        return yield* failed("probeCredential", "Jira returned an inconsistent project page.");
      return {
        account: viewer.displayName ?? viewer.accountId,
        accountId: viewer.accountId,
        host: credential.host,
        scopes: projects.values.map((project) => ({ key: project.key, name: project.name })),
        ...(projects.total > projects.values.length ? { scopesTruncated: true } : {}),
      };
    });
  const getScope = (packed: string, scope: string) =>
    Effect.gen(function* () {
      const credential = yield* Effect.try({
        try: () => parseJiraCredential(packed),
        catch: () =>
          failed(
            "getScope",
            "Enter a Jira Cloud site, account email and a standard site API token.",
            "unauthenticated",
          ),
      });
      const project = yield* request({
        host: credential.host,
        credential: packed,
        operation: "getScope",
        method: "GET",
        path: "/project/" + encodeURIComponent(scope),
        schema: Schema.Struct({ key: Text, name: Text }),
      });
      return { key: project.key, name: project.name };
    }).pipe(
      Effect.catchIf(
        (error) => error.reason === "not-found",
        () => Effect.succeed(null),
      ),
    );
  return JiraApi.of({ request, probeCredential, getScope });
});
