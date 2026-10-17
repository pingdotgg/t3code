import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Hex from "effect/encoding/Hex";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";
import {
  IssueTrackerKind,
  type IssuePageInput,
  type IssueTrackerScopePage,
} from "@t3tools/contracts";
import { IssueTrackerError } from "@t3tools/issue-tracker-core/server/IssueTracker";
import { IssueTrackerHost } from "@t3tools/issue-tracker-core/server/IssueTrackerHost";
import { collectUint8StreamText } from "@t3tools/provider-core/server/collectStreamText";
import { retryAtFromHeader } from "@t3tools/source-control-core/server/SourceControlRateLimit";

import { JiraUser } from "./jiraJson.ts";
import {
  dataCenterAssignee,
  dataCenterRequest,
  dataCenterResponse,
  normalizeJiraInstanceHost,
} from "./jiraDataCenter.ts";

export { jiraIssueUrl, normalizeJiraInstanceHost } from "./jiraDataCenter.ts";

export const KIND = IssueTrackerKind.make("jira");
const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16_384));
const Credential = Schema.Union([
  Schema.Struct({
    deployment: Schema.optional(Schema.Literal("cloud")),
    site: Text,
    email: Text,
    token: Text,
  }),
  Schema.Struct({ deployment: Schema.Literal("data-center"), site: Text, token: Text }),
]);
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
  const token = credential.token.trim();
  if (credential.deployment === "data-center") {
    if (!token) throw new Error("Enter a Jira Data Center personal access token.");
    return {
      deployment: credential.deployment,
      host: normalizeJiraInstanceHost(credential.site.trim()),
      token,
    };
  }
  const email = credential.email.trim();
  if (!email || !token) throw new Error("Enter a Jira account email and a site API token.");
  return {
    deployment: "cloud" as const,
    host: normalizeJiraHost(credential.site.trim()),
    email,
    token,
  };
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
export const isHttpStatus = (error: IssueTrackerError, status: number) =>
  typeof error.cause === "object" &&
  error.cause !== null &&
  "status" in error.cause &&
  error.cause.status === status;

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
    readonly deploymentFor: (
      host: string,
    ) => Effect.Effect<"cloud" | "data-center", IssueTrackerError>;
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
        readonly scopesCursor: string | null;
      },
      IssueTrackerError
    >;
    readonly getScope: (
      credential: string,
      scope: string,
    ) => Effect.Effect<{ readonly key: string; readonly name: string } | null, IssueTrackerError>;
    readonly listScopes: (
      credential: string,
      input: IssuePageInput,
    ) => Effect.Effect<IssueTrackerScopePage, IssueTrackerError>;
  }
>()("@t3tools/issue-tracker-jira/server/JiraApi") {}

export const make = Effect.gen(function* () {
  const http = yield* HttpClient.HttpClient;
  const host = yield* IssueTrackerHost;
  const crypto = yield* Crypto.Crypto;
  const limits = yield* SourceControlRateLimit.SourceControlRateLimit;

  const request = <S extends Schema.Top & { readonly DecodingServices: never }>(
    input: Request<S>,
  ): Effect.Effect<S["Type"], IssueTrackerError> => {
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
        try: () =>
          credential.deployment === "cloud"
            ? normalizeJiraHost(input.host)
            : normalizeJiraInstanceHost(input.host),
        catch: () => failed(input.operation, "This is not a Jira Cloud tenant host."),
      });
      if (requestedHost !== credential.host)
        return yield* failed(
          input.operation,
          "This Jira credential belongs to another site.",
          "unauthenticated",
        );
      if (
        credential.deployment === "data-center" &&
        input.operation === "setParent" &&
        input.method !== "GET" &&
        !(input.method === "POST" && /^\/agile\/1\.0\/epic\/[^/]+\/issue$/u.test(input.path))
      )
        return yield* failed(
          input.operation,
          "Use Jira Software's epic operation to change this Data Center parent.",
        );
      let native =
        credential.deployment === "data-center"
          ? yield* attempt(input.operation, () => dataCenterRequest(input))
          : undefined;
      const selected =
        native !== undefined && input.method !== "GET"
          ? yield* attempt(input.operation, () => dataCenterAssignee(input.path, input.body))
          : null;
      if (selected !== null) {
        const user = yield* request({
          host: input.host,
          credential: stored,
          operation: input.operation,
          method: "GET",
          path: "/user?key=" + encodeURIComponent(selected),
          schema: Schema.Struct({ accountId: Text, name: Text }),
        });
        if (user.accountId !== selected)
          return yield* failed(input.operation, "Jira returned another user for this account key.");
        native = yield* attempt(input.operation, () =>
          dataCenterRequest({ ...input, assigneeName: user.name }),
        );
      }
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
        const unsigned = HttpClientRequest.make(input.method)(
          "https://" +
            credential.host +
            (native?.apiBase ?? "/rest/api/3") +
            (native?.path ?? input.path),
        ).pipe(HttpClientRequest.acceptJson);
        const base =
          credential.deployment === "cloud"
            ? unsigned.pipe(HttpClientRequest.basicAuth(credential.email, credential.token))
            : unsigned.pipe(HttpClientRequest.bearerToken(credential.token));
        const body = native === undefined ? input.body : native.body;
        const response = yield* http
          .execute(body === undefined ? base : base.pipe(HttpClientRequest.bodyJsonUnsafe(body)))
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
                cause: { status: response.status },
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
        const result = yield* (
          credential.deployment === "cloud"
            ? decodeJson(collected.text)
            : attempt(input.operation, () =>
                dataCenterResponse(input.path, input.body, JSON.parse(collected.text)),
              ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(input.schema)))
        ).pipe(Effect.mapError(() => failed(input.operation, "Jira returned unexpected data.")));
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

  const deploymentFor = (requestedHost: string) =>
    Effect.gen(function* () {
      const packed = yield* host.credentials
        .get(KIND)
        .pipe(
          Effect.flatMap(
            Effect.fromOption(() =>
              failed("deploymentFor", "Jira is not connected on this server.", "unauthenticated"),
            ),
          ),
        );
      const credential = yield* Effect.try({
        try: () => parseJiraCredential(packed),
        catch: () => failed("deploymentFor", "The Jira credential is invalid.", "unauthenticated"),
      });
      const normalized = yield* Effect.try({
        try: () =>
          credential.deployment === "cloud"
            ? normalizeJiraHost(requestedHost)
            : normalizeJiraInstanceHost(requestedHost),
        catch: () =>
          failed(
            "deploymentFor",
            "This Jira credential belongs to another site.",
            "unauthenticated",
          ),
      });
      if (normalized !== credential.host)
        return yield* failed(
          "deploymentFor",
          "This Jira credential belongs to another site.",
          "unauthenticated",
        );
      return credential.deployment;
    });

  const listScopes = (packed: string, input: IssuePageInput, operation = "listScopes") =>
    Effect.gen(function* () {
      const limit = input.limit ?? 100;
      const cursor = input.cursor ?? "0";
      const startAt = Number(cursor);
      if (
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 100 ||
        !/^(0|[1-9][0-9]*)$/.test(cursor) ||
        cursor.length > 4096 ||
        !Number.isSafeInteger(startAt)
      )
        return yield* failed(operation, "Invalid Jira scope page.");
      const credential = yield* Effect.try({
        try: () => parseJiraCredential(packed),
        catch: () =>
          failed(
            operation,
            "Enter a Jira Cloud site, account email and a standard site API token.",
            "unauthenticated",
          ),
      });
      const projects = yield* request({
        host: credential.host,
        credential: packed,
        operation,
        method: "GET",
        path: "/project/search?startAt=" + startAt + "&maxResults=" + limit,
        schema: Projects,
      });
      const next = projects.startAt + projects.values.length;
      if (
        projects.startAt !== startAt ||
        projects.total < next ||
        projects.values.length > limit ||
        !Number.isSafeInteger(next) ||
        (projects.values.length === 0 && next < projects.total)
      )
        return yield* failed(operation, "Jira returned an inconsistent project page.");
      return {
        items: projects.values.map((project) => ({ key: project.key, name: project.name })),
        nextCursor: next < projects.total ? String(next) : null,
      };
    });

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
      const projects = yield* listScopes(packed, {}, "probeCredential");
      return {
        account: viewer.displayName ?? viewer.accountId,
        accountId: viewer.accountId,
        host: credential.host,
        scopes: projects.items,
        scopesCursor: projects.nextCursor,
        ...(projects.nextCursor === null ? {} : { scopesTruncated: true }),
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
  return JiraApi.of({ request, probeCredential, getScope, listScopes, deploymentFor });
});
