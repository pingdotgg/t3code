/**
 * JiraProvider — raw-HTTP Jira work-source provider (Cloud + Server/Data Center).
 *
 * Uses `HttpClient` with credentials from `WorkSourceConnectionStore.getConnectionAuth`.
 *
 * ### auth
 * authMode "basic" (Cloud) → `Authorization: Basic base64(email:token)`.
 * authMode "bearer" (Server/DC) → `Authorization: Bearer token`.
 * Base URL comes from the connection (Cloud site or self-hosted host).
 *
 * ### API version
 * Uses `/rest/api/2` on BOTH deployments. Cloud supports v2 and returns
 * `description` as a plain string — deliberately avoiding v3 ADF parsing.
 *
 * ### externalId strategy
 * `externalId = issue.key` (e.g. "ENG-123"). Keys are stable within a project;
 * they only change when an issue is MOVED to another project, which also drops
 * it from this source's `project = "KEY"` selector. Accepted v1 limitation.
 *
 * ### pagination
 * Offset-based: `pageToken` encodes `startAt`. `nextPageToken = startAt +
 * issues.length` while `startAt + issues.length < total`. The token is opaque
 * to the syncer, so a later switch to Cloud's token-based `/search/jql` is
 * internal-only.
 *
 * ### since / timezone
 * The ISO→JQL `since` conversion drops the timezone offset (`slice(0, 16)`), so
 * the resulting `updated >= "..."` clause is interpreted in Jira's configured
 * server timezone, not UTC. Acceptable v1 trade-off because the syncer supplies
 * a UTC timestamp; the small skew only risks re-fetching (never skipping) a few
 * boundary issues, which the reconcile pass deduplicates.
 */
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { JiraSelector } from "@t3tools/contracts/workSource";

import {
  JiraProvider as JiraProviderTag,
  WorkSourceAuthError,
  WorkSourceConfigError,
  WorkSourceRateLimitError,
  WorkSourceTransientError,
  type ExternalWorkItem,
  type ImportableViewParts,
  type Viewer,
  type WorkSourcePage,
  type WorkSourceProvider,
} from "../Services/WorkSourceProvider.ts";
import { WorkSourceConnectionStore } from "../Services/WorkSourceConnectionStore.ts";
import { isBlockedHost } from "../blockedHost.ts";

const USER_AGENT = "t3code-work-source/1.0";
const JIRA_MAX_RESULTS_CAP = 100;
const ISSUE_FIELDS = "summary,description,status,assignee,labels,updated";

const trimUrl = (u: string) => u.replace(/\/+$/u, "");

function parseJiraRateLimitRetryMs(headers: Record<string, string>): number {
  const retryAfter = headers["retry-after"];
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (!Number.isNaN(seconds) && seconds > 0) return seconds * 1000;
  }
  return 60_000;
}

interface ConnAuth {
  readonly token: string;
  readonly authMode: string;
  readonly baseUrl: string | null;
  readonly email: string | null;
}

function requireBaseUrl(auth: ConnAuth): Effect.Effect<string, WorkSourceConfigError> {
  const base = auth.baseUrl?.trim();
  if (!base) {
    return Effect.fail(new WorkSourceConfigError({ message: "Jira connection is missing a base URL" }));
  }
  // Defense-in-depth: the stored baseUrl is what actually gets requested, so
  // re-check it against the SSRF blocklist at request time (not just at create
  // time). Parse inside Effect.try per the lint rule; a parse failure also
  // surfaces as a config error.
  return Effect.try({
    try: () => new URL(base).hostname,
    catch: () => new WorkSourceConfigError({ message: "Jira base URL is not a valid URL" }),
  }).pipe(
    Effect.flatMap((hostname) =>
      isBlockedHost(hostname)
        ? Effect.fail(new WorkSourceConfigError({ message: "Jira base URL host is not allowed" }))
        : Effect.succeed(trimUrl(base)),
    ),
  );
}

// Returns an Effect because Basic auth fails (WorkSourceConfigError) when email is absent.
function buildHeaders(auth: ConnAuth): Effect.Effect<Record<string, string>, WorkSourceConfigError> {
  const common = { accept: "application/json", "user-agent": USER_AGENT };
  if (auth.authMode === "basic") {
    if (!auth.email) {
      return Effect.fail(
        new WorkSourceConfigError({ message: "Jira Cloud connection is missing an email for Basic auth" }),
      );
    }
    const b64 = Encoding.encodeBase64(`${auth.email}:${auth.token}`);
    return Effect.succeed({ ...common, authorization: `Basic ${b64}` });
  }
  // "bearer" (Server/DC) and any other mode default to Bearer
  return Effect.succeed({ ...common, authorization: `Bearer ${auth.token}` });
}

function buildJql(selector: { projectKey: string; jql?: string | undefined }, since?: string): string {
  const clauses: Array<string> = [`project = "${selector.projectKey.replace(/"/gu, '\\"')}"`];
  if (selector.jql && selector.jql.trim().length > 0) clauses.push(`(${selector.jql.trim()})`);
  if (since) {
    // ISO "2024-01-01T00:00:00Z" → JQL datetime "2024-01-01 00:00"
    const jiraDate = since.slice(0, 16).replace("T", " ");
    clauses.push(`updated >= "${jiraDate}"`);
  }
  return `${clauses.join(" AND ")} ORDER BY updated ASC`;
}

interface RawJiraFields {
  readonly summary: string;
  readonly description?: string | null;
  readonly status?: { readonly statusCategory?: { readonly key?: string } | null } | null;
  readonly assignee?: { readonly displayName?: string | null; readonly name?: string | null } | null;
  readonly labels?: ReadonlyArray<string> | null;
  readonly updated?: string | null;
}
interface RawJiraIssue {
  readonly key: string;
  readonly fields: RawJiraFields;
}
interface RawJiraSearch {
  readonly issues?: ReadonlyArray<RawJiraIssue> | null;
  readonly startAt?: number;
  readonly total?: number;
}

function mapIssue(raw: RawJiraIssue, baseUrl: string): ExternalWorkItem {
  const statusKey = raw.fields.status?.statusCategory?.key;
  const assigneeName = raw.fields.assignee?.displayName ?? raw.fields.assignee?.name;
  const labels =
    raw.fields.labels && raw.fields.labels.length > 0 ? raw.fields.labels.slice() : undefined;
  return {
    provider: "jira",
    externalId: raw.key,
    url: `${baseUrl}/browse/${raw.key}`,
    lifecycle: statusKey === "done" ? "closed" : "open",
    version: raw.fields.updated ? { updatedAt: raw.fields.updated } : {},
    fields: {
      title: raw.fields.summary,
      ...(raw.fields.description != null && raw.fields.description !== "" && {
        description: raw.fields.description,
      }),
      ...(assigneeName != null && { assignees: [assigneeName] }),
      ...(labels !== undefined && { labels }),
    },
  };
}

// Hoisted: the compiled decoder is built once, not rebuilt on every listPage call.
const decodeJiraSelector = Schema.decodeUnknownEffect(JiraSelector);

const make = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  const connectionStore = yield* WorkSourceConnectionStore;

  const provider: WorkSourceProvider = {
    provider: "jira",
    selectorSchema: JiraSelector,

    listPage: (input) =>
      Effect.gen(function* () {
        const selector = yield* decodeJiraSelector(input.selector).pipe(
          Effect.mapError(
            (e) => new WorkSourceConfigError({ message: `Invalid Jira selector: ${e.message}` }),
          ),
        );
        const auth = yield* connectionStore.getConnectionAuth(input.connectionRef, "jira");
        const baseUrl = yield* requireBaseUrl(auth);
        const headers = yield* buildHeaders(auth);

        const startAt = Number(input.pageToken ?? "0");
        const maxResults = Math.min(input.pageSize, JIRA_MAX_RESULTS_CAP);
        const jql = buildJql(selector, input.since);

        const urlParams: Array<readonly [string, string]> = [
          ["jql", jql],
          ["startAt", String(Number.isNaN(startAt) ? 0 : startAt)],
          ["maxResults", String(maxResults)],
          ["fields", ISSUE_FIELDS],
        ];

        const request = HttpClientRequest.get(`${baseUrl}/rest/api/2/search`, { urlParams }).pipe(
          HttpClientRequest.setHeaders(headers),
        );

        const response = yield* client.execute(request).pipe(
          Effect.mapError(
            (cause) => new WorkSourceTransientError({ message: `Jira HTTP network error: ${String(cause)}` }),
          ),
        );

        const { status, headers: respHeaders } = response;
        if (status === 429) {
          return yield* new WorkSourceRateLimitError({ retryAfterMs: parseJiraRateLimitRetryMs(respHeaders) });
        }
        if (status === 401 || status === 403) {
          return yield* new WorkSourceAuthError({ connectionRef: input.connectionRef });
        }
        if (status < 200 || status >= 300) {
          const body = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
          return yield* new WorkSourceTransientError({
            message: `Jira API returned HTTP ${status}: ${body.trim() || "(no body)"}`,
          });
        }

        const raw = yield* response.json.pipe(
          Effect.mapError(
            (cause) => new WorkSourceTransientError({ message: `Failed to parse Jira JSON: ${String(cause)}` }),
          ),
        );

        if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
          return yield* new WorkSourceTransientError({ message: "Jira /search response was not an object" });
        }
        const search = raw as RawJiraSearch;
        const rawIssues = Array.isArray(search.issues) ? search.issues : [];
        const items = rawIssues.map((i) => mapIssue(i, baseUrl));

        const effectiveStartAt = Number.isNaN(startAt) ? 0 : startAt;
        const total = typeof search.total === "number" ? search.total : effectiveStartAt + items.length;
        const nextStart = effectiveStartAt + items.length;
        const hasMore = items.length > 0 && nextStart < total;

        const page: WorkSourcePage = {
          items,
          ...(hasMore && { nextPageToken: String(nextStart) }),
        };
        return page;
      }),

    getItem: (input) =>
      Effect.gen(function* () {
        const auth = yield* connectionStore.getConnectionAuth(input.connectionRef, "jira");
        const baseUrl = yield* requireBaseUrl(auth);
        const headers = yield* buildHeaders(auth);

        const request = HttpClientRequest.get(
          `${baseUrl}/rest/api/2/issue/${encodeURIComponent(input.externalId)}`,
          { urlParams: [["fields", ISSUE_FIELDS]] },
        ).pipe(HttpClientRequest.setHeaders(headers));

        const response = yield* client.execute(request).pipe(
          Effect.mapError(
            (cause) =>
              new WorkSourceTransientError({ message: `Jira HTTP network error (getItem): ${String(cause)}` }),
          ),
        );

        const { status, headers: respHeaders } = response;
        if (status === 404) return null;
        if (status === 429) {
          return yield* new WorkSourceRateLimitError({ retryAfterMs: parseJiraRateLimitRetryMs(respHeaders) });
        }
        if (status === 401 || status === 403) {
          return yield* new WorkSourceAuthError({ connectionRef: input.connectionRef });
        }
        if (status < 200 || status >= 300) {
          const body = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
          return yield* new WorkSourceTransientError({
            message: `Jira API returned HTTP ${status} (getItem): ${body.trim() || "(no body)"}`,
          });
        }

        const raw = yield* response.json.pipe(
          Effect.mapError(
            (cause) =>
              new WorkSourceTransientError({ message: `Failed to parse Jira getItem JSON: ${String(cause)}` }),
          ),
        );
        if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
          return yield* new WorkSourceTransientError({ message: "Jira /issue response was not an object" });
        }
        const candidate = raw as unknown as RawJiraIssue;
        if (
          typeof candidate.key !== "string" ||
          typeof candidate.fields !== "object" ||
          candidate.fields === null
        ) {
          return yield* new WorkSourceTransientError({
            message: "Jira /issue response missing key or fields",
          });
        }
        return mapIssue(candidate, baseUrl);
      }),

    toImportableView: ({ selector, item }): ImportableViewParts => {
      const s = selector as { projectKey?: string };
      return { displayRef: item.externalId, container: s.projectKey ?? "?" };
    },

    viewer: ({ connectionRef }) =>
      Effect.gen(function* () {
        const auth = yield* connectionStore.getConnectionAuth(connectionRef, "jira");
        const baseUrl = yield* requireBaseUrl(auth);
        const headers = yield* buildHeaders(auth);
        const request = HttpClientRequest.get(`${baseUrl}/rest/api/2/myself`).pipe(
          HttpClientRequest.setHeaders(headers),
        );
        const response = yield* client.execute(request).pipe(
          Effect.mapError(
            (cause) => new WorkSourceTransientError({ message: `Jira viewer network error: ${String(cause)}` }),
          ),
        );
        if (response.status !== 200) return null;
        const body = yield* response.json.pipe(Effect.orElseSucceed(() => ({}) as unknown));
        const b = body as {
          accountId?: unknown;
          name?: unknown;
          key?: unknown;
          displayName?: unknown;
          emailAddress?: unknown;
        };
        const asStr = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : undefined);
        const id = asStr(b.accountId) ?? asStr(b.name) ?? asStr(b.key);
        if (id === undefined) return null;
        const aliases = [b.accountId, b.displayName, b.name, b.key, b.emailAddress].filter(
          (v): v is string => typeof v === "string" && v.length > 0,
        );
        const viewer: Viewer = { id, aliases };
        return viewer;
      }),
  };

  return provider;
});

export const JiraProviderLive: Layer.Layer<
  JiraProviderTag,
  never,
  HttpClient.HttpClient | WorkSourceConnectionStore
> = Layer.effect(JiraProviderTag, make);
