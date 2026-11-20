/**
 * Jira sessions from the TWG login (Atlassian's Teamwork Graph CLI) on the server's machine. TWG
 * keeps its credential store and refresh token; this reads its session export, holds the access
 * token in memory only, and sends an OAuth session through Atlassian's API gateway. The gateway
 * serves no private API, so such a session's linked pull requests are read with TWG itself.
 */
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import type { IssueTrackerError } from "@t3tools/source-control-core/server/IssueTracker";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";

import * as JiraApi from "./JiraApi.ts";

/** How long an export is reused before TWG is asked again, so its own refresh is picked up. */
const SESSION_TTL = 5 * 60_000;
/** How long a failure is shared, so a signed-out TWG is not run once per request. */
const FAILURE_TTL = 10_000;
const GATEWAY = "https://api.atlassian.com";
const CLOUD_ID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/iu;
const EXPORTED = new Set([
  "TWG_OAUTH_ACCESS_TOKEN",
  "TWG_TOKEN",
  "TWG_USER",
  "TWG_SITE",
  "TWG_PROFILE",
]);

/** Teamwork Graph's edge from a work item to a pull request linked to it, not only mentioning it. */
const LINKED_PULL_REQUEST = "jira_work_item_links_external_pull_request";

const Resources = Schema.Array(Schema.Struct({ id: Schema.String, url: Schema.String }));
const Text = Schema.optional(Schema.NullOr(Schema.String));
const ContextRelationships = Schema.optional(
  Schema.Array(
    Schema.Struct({
      relationshipName: Schema.String,
      targets: Schema.Array(
        Schema.Struct({
          title: Text,
          name: Text,
          url: Text,
          status: Text,
          displayId: Text,
          pullRequestId: Text,
        }),
      ),
    }),
  ),
);
/** What `twg context jira workitem -o json` prints: graph edges, read as data. */
const decodeContext = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      data: Schema.Struct({
        relationships: ContextRelationships,
        relationshipSummary: ContextRelationships,
      }),
    }),
  ),
);
const decodeClaims = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ sub: Schema.optional(Schema.String), exp: Schema.optional(Schema.Number) }),
  ),
);

/**
 * `twg env --export` prints shell assignments, which are read here and never run. Credentials and
 * sites need no escapes, so a value that would need unescaping or expanding is refused.
 */
function readExport(stdout: string): Record<string, string> | null {
  const values: Record<string, string> = {};
  for (const line of stdout.split(/\r?\n/u)) {
    const assignment = /^(?:export\s+|\$env:)([A-Z_]+)\s*=\s*(.*?)\s*;?$/u.exec(line);
    const key = assignment?.[1];
    if (key === undefined || !EXPORTED.has(key)) continue;
    const literal = assignment![2]!;
    const quoted = /^\$?'([^'\\\r\n]*)'$/u.exec(literal) ?? /^"([^"\\$`\r\n]*)"$/u.exec(literal);
    const value = quoted?.[1] ?? (/^[A-Za-z0-9_./:@+=~-]+$/u.test(literal) ? literal : null);
    if (value === null || Object.hasOwn(values, key)) return null;
    values[key] = value;
  }
  return values;
}

/** The account and expiry an OAuth access token carries, read without verifying it. */
function tokenClaims(token: string) {
  const payload = token.split(".")[1];
  const json = payload === undefined ? undefined : Base64Url.decodeString(payload);
  return Option.getOrUndefined(
    decodeClaims(json === undefined ? undefined : Result.getOrUndefined(json)),
  );
}

interface CacheEntry {
  readonly origin: string;
  readonly result: Result.Result<JiraApi.JiraSession, IssueTrackerError>;
  readonly until: number;
  /** A session Jira refused, so the next load refreshes TWG's login first. */
  readonly refused: JiraApi.JiraSession | null;
}

export const make = Effect.gen(function* () {
  const host = yield* SourceControlHost.SourceControlHost;
  const http = yield* HttpClient.HttpClient;
  const gate = yield* Semaphore.make(1);
  let cache: CacheEntry | undefined;

  const refuse = (detail: string) => JiraApi.fail("authenticate", "unauthenticated", detail);

  const run = Effect.fn("TwgJiraAuth.run")(function* (args: ReadonlyArray<string>) {
    const result = yield* host.process
      .run({
        operation: "TwgJiraAuth.run",
        command: "twg",
        args,
        cwd: ".",
        env: { TWG_AGENT_DEFAULTS: "1" },
        allowNonZeroExit: true,
        timeoutMs: 30_000,
        maxOutputBytes: 64 * 1024,
        outputMode: "error",
      })
      .pipe(
        Effect.mapError((cause) =>
          JiraApi.fail(
            "authenticate",
            cause._tag === "VcsProcessSpawnError" ? "missing-tool" : "failed",
            "TWG could not supply a session. Check that it is installed on this environment.",
            { cause },
          ),
        ),
      );
    // Never attach the output: it carries the access token.
    if (result.exitCode !== 0 || result.stdoutInvalidUtf8 === true) {
      return yield* refuse("TWG could not supply a session. Check its login on this environment.");
    }
    return result.stdout;
  });

  /** The pull requests Teamwork Graph links to an issue, as TWG reads them for this login. */
  const linkedPullRequests = Effect.fn("TwgJiraAuth.linkedPullRequests")(function* (
    session: JiraApi.JiraSession,
    issueId: string,
  ) {
    const failed = (cause?: unknown) =>
      JiraApi.fail(
        "linkedPullRequests",
        "failed",
        "TWG could not read the issue's linked pull requests.",
        cause === undefined ? {} : { cause },
      );
    if (!/^\d+$/u.test(issueId)) return yield* failed();
    const result = yield* host.process
      .run({
        operation: "TwgJiraAuth.linkedPullRequests",
        command: "twg",
        args: [
          "context",
          "jira",
          "workitem",
          issueId,
          "--site",
          new URL(session.origin).hostname,
          ...(session.profile ? ["--profile", session.profile] : []),
          "--relationships",
          LINKED_PULL_REQUEST,
          "--detail",
          "full",
          // TWG reads back seven days unless asked; a link belongs to the issue however old.
          "--since",
          "3650d",
          "--output",
          "json",
          "--output-summary",
          "none",
        ],
        cwd: ".",
        env: { TWG_AGENT_DEFAULTS: "1" },
        allowNonZeroExit: true,
        timeoutMs: 30_000,
        maxOutputBytes: 4 * 1024 * 1024,
        outputMode: "error",
      })
      .pipe(Effect.mapError(failed));
    const context = result.exitCode === 0 ? decodeContext(result.stdout) : Option.none();
    if (Option.isNone(context)) return yield* failed();
    const { relationships, relationshipSummary } = context.value.data;
    return (relationships ?? relationshipSummary ?? [])
      .flatMap((edge) => (edge.relationshipName === LINKED_PULL_REQUEST ? edge.targets : []))
      .map((target) => ({
        id: target.displayId ?? target.pullRequestId ?? null,
        name: target.title ?? target.name ?? null,
        url: target.url ?? null,
        status: target.status ?? null,
      }));
  });

  const load = Effect.fn("TwgJiraAuth.load")(function* (
    origin: string,
    refused: JiraApi.JiraSession | null,
  ) {
    const site = new URL(origin).hostname;
    const profile = refused?.profile ? ["--profile", refused.profile] : [];
    // TWG refreshes only when it thinks the token is due; Jira just said it is.
    if (refused?.oauth) {
      yield* run([
        "auth",
        "refresh",
        ...(profile.length > 0 ? profile : ["--site", site]),
        "--force",
      ]);
    }
    const exported = readExport(yield* run(["env", "--site", site, ...profile, "--export"]));
    const selected = exported?.["TWG_SITE"];
    // TWG names no profile when it exports its default login.
    const exportedProfile = exported?.["TWG_PROFILE"] || null;
    if (!exported || !selected || JiraApi.siteOrigin(selected) !== origin) {
      return yield* refuse("TWG did not provide a session for this Jira site.");
    }
    const now = yield* Clock.currentTimeMillis;
    const oauth = exported["TWG_OAUTH_ACCESS_TOKEN"];
    if (!oauth) {
      // A TWG login with an API token signs Basic requests to the site, as Settings' token does.
      const token = exported["TWG_TOKEN"];
      const user = exported["TWG_USER"];
      if (!token || !user) return yield* refuse("TWG did not provide usable Jira credentials.");
      return {
        origin,
        apiOrigin: origin,
        profile: exportedProfile,
        oauth: false,
        identity: user.toLowerCase(),
        authorization: Redacted.make(`Basic ${Base64.encode(`${user}:${token}`)}`),
        expiresAt: now + SESSION_TTL,
      } satisfies JiraApi.JiraSession;
    }
    if (!/^[A-Za-z0-9._~+/-]+=*$/u.test(oauth)) {
      return yield* refuse("TWG provided an invalid OAuth session.");
    }
    const claims = tokenClaims(oauth);
    const identity = claims?.sub ?? exported["TWG_USER"];
    const expiresAt = claims?.exp === undefined ? now + 60_000 : claims.exp * 1_000;
    if (!identity || !Number.isFinite(expiresAt) || expiresAt <= now + 5_000) {
      return yield* refuse("TWG's session has expired. Run twg login on this environment.");
    }
    // The gateway addresses a site by its cloud id; the token's grants list the ids it reaches.
    const response = yield* http
      .execute(
        HttpClientRequest.get(`${GATEWAY}/oauth/token/accessible-resources`).pipe(
          HttpClientRequest.bearerToken(Redacted.make(oauth)),
          HttpClientRequest.acceptJson,
        ),
      )
      .pipe(
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
        Effect.timeout("30 seconds"),
        Effect.mapError((cause) =>
          JiraApi.fail("authenticate", "failed", "Atlassian could not be reached.", { cause }),
        ),
      );
    if (response.status === 429) {
      const delay = Number(response.headers["retry-after"]);
      return yield* JiraApi.fail(
        "authenticate",
        "rate-limited",
        "Jira's rate limit was reached.",
        Number.isFinite(delay) && delay >= 0 ? { retryAt: now + delay * 1_000 } : {},
      );
    }
    if (response.status !== 200) {
      return yield* refuse("TWG's session cannot reach Jira. Check its login and permissions.");
    }
    const resources = yield* HttpClientResponse.schemaBodyJson(Resources)(response).pipe(
      Effect.mapError(() => refuse("Atlassian returned unreadable site access.")),
    );
    const matches = resources.filter((resource) => JiraApi.siteOrigin(resource.url) === origin);
    const cloud = matches.length === 1 ? matches[0]!.id : undefined;
    if (cloud === undefined || !CLOUD_ID.test(cloud)) {
      return yield* refuse("TWG's session does not reach this Jira site.");
    }
    return {
      origin,
      apiOrigin: `${GATEWAY}/ex/jira/${cloud}`,
      profile: exportedProfile,
      oauth: true,
      identity,
      authorization: Redacted.make(`Bearer ${oauth}`),
      expiresAt,
    } satisfies JiraApi.JiraSession;
  });

  /** One load at a time; concurrent operations share its result. */
  const acquire = Effect.fn("TwgJiraAuth.acquire")(function* (
    origin: string,
    rejected: JiraApi.JiraSession | undefined,
    fresh: boolean,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const entry = cache?.origin === origin ? cache : undefined;
    if (
      entry !== undefined &&
      entry.until > now &&
      // A connection check asks TWG again, unless Atlassian asked to wait.
      (!fresh ||
        (Result.isFailure(entry.result) && entry.result.failure.reason === "rate-limited")) &&
      // Another operation may already have replaced the refused session.
      !(
        rejected !== undefined &&
        Result.isSuccess(entry.result) &&
        entry.result.success === rejected
      )
    ) {
      return yield* Effect.fromResult(entry.result);
    }
    const refused = rejected ?? entry?.refused ?? null;
    const result = yield* load(origin, refused).pipe(Effect.result);
    const loadedAt = yield* Clock.currentTimeMillis;
    cache = {
      origin,
      result,
      refused: Result.isFailure(result) ? refused : null,
      until: Result.isSuccess(result)
        ? Math.min(loadedAt + SESSION_TTL, result.success.expiresAt - 5_000)
        : Math.max(loadedAt + FAILURE_TTL, result.failure.retryAt ?? 0),
    };
    return yield* Effect.fromResult(result);
  }, gate.withPermits(1));

  return {
    /**
     * Sessions for one operation on `origin`: it keeps the first it resolves, and a refresh must
     * keep its account. `fresh` asks TWG again rather than reusing another operation's session.
     */
    forSite: (origin: string, fresh: boolean): JiraApi.JiraSessions["Service"] => {
      let pinned: JiraApi.JiraSession | undefined;
      const operationGate = Semaphore.makeUnsafe(1);
      return JiraApi.JiraSessions.of({
        resolve: Effect.fn("TwgJiraAuth.resolve")(function* (rejected) {
          if (pinned !== undefined && rejected === undefined) return pinned;
          const session = yield* acquire(origin, rejected, fresh && pinned === undefined);
          if (
            pinned !== undefined &&
            (pinned.identity !== session.identity ||
              pinned.profile !== session.profile ||
              pinned.apiOrigin !== session.apiOrigin)
          ) {
            return yield* refuse("The TWG account changed during this operation. Try again.");
          }
          pinned = session;
          return session;
        }, operationGate.withPermits(1)),
        reject: Effect.fn("TwgJiraAuth.reject")(function* (session) {
          if (cache && Result.isSuccess(cache.result) && cache.result.success === session) {
            cache = { ...cache, until: 0, refused: session };
          }
        }, gate.withPermits(1)),
        linkedPullRequests,
      });
    },
  };
});
