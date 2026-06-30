/**
 * GithubIssuesProvider — raw-HTTP GitHub Issues work-source provider.
 *
 * Uses `HttpClient` from `effect/unstable/http` (NOT the `gh` CLI) with a PAT
 * fetched from `WorkSourceConnectionStore.getToken`.
 *
 * ### externalId strategy
 * `externalId = String(number)` — the issue number is stable per repo and lets
 * `getItem` issue a simple `GET /repos/{owner}/{repo}/issues/:number` lookup.
 *
 * ### nextPageToken strategy
 * Parse the `Link` response header for `rel="next"` and extract the `page`
 * query-parameter value.  Fall back to the page-count heuristic
 * (`items.length === pageSize ? String(Number(pageToken ?? 1) + 1) : undefined`)
 * only if the header is absent (GitHub always emits it when another page
 * exists).
 *
 * ### getItem
 * `getItem` decodes the source `selector` for owner/repo, then issues
 * `GET /repos/{owner}/{repo}/issues/{externalId}` (externalId = issue number).
 * 404 → null (genuinely deleted upstream → the syncer may terminal-route).
 * 200 → the mapped item (it STILL EXISTS — it merely fell out of a label/
 * assignee/state filter, so it must NOT be confirmed-deleted). Auth/rate-limit/
 * transient map to their typed errors so the syncer treats them as
 * "cannot confirm" (no deletion) and backs the source off.
 */
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { GithubSelector } from "@t3tools/contracts/workSource";

import {
  GithubIssuesProvider as GithubIssuesProviderTag,
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

const GITHUB_API_BASE = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const USER_AGENT = "t3code-work-source/1.0";

// ---------------------------------------------------------------------------
// Link-header parser
// ---------------------------------------------------------------------------

/**
 * Parse GitHub's `Link` header and return the `page` value for `rel="next"`,
 * or `undefined` if no next page.
 *
 * Example header value:
 *   <https://api.github.com/repos/o/r/issues?page=2>; rel="next",
 *   <https://api.github.com/repos/o/r/issues?page=5>; rel="last"
 */
function parseNextPageFromLinkHeader(linkHeader: string | undefined): string | undefined {
  if (!linkHeader) return undefined;
  // Split on commas that separate link entries
  for (const part of linkHeader.split(",")) {
    const nextMatch = part.match(/rel="next"/u);
    if (!nextMatch) continue;
    const urlMatch = part.match(/<([^>]+)>/u);
    if (!urlMatch?.[1]) continue;
    try {
      const pageParam = new URL(urlMatch[1]).searchParams.get("page");
      return pageParam ?? undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Rate-limit helper
// ---------------------------------------------------------------------------

function parseRateLimitRetryMs(headers: Record<string, string>, nowMs: number): number {
  // retry-after is in seconds
  const retryAfter = headers["retry-after"];
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (!Number.isNaN(seconds)) return seconds * 1000;
  }
  // x-ratelimit-reset is an epoch timestamp in seconds
  const resetEpoch = headers["x-ratelimit-reset"];
  if (resetEpoch) {
    const resetMs = Number(resetEpoch) * 1000;
    const delta = resetMs - nowMs;
    return delta > 0 ? delta : 5000;
  }
  return 60_000; // fallback: 1 minute
}

// ---------------------------------------------------------------------------
// Raw GitHub JSON shapes (loose — we only need the fields we use)
// ---------------------------------------------------------------------------

interface RawGithubIssue {
  readonly number: number;
  readonly state: string;
  readonly title: string;
  readonly body: string | null;
  readonly html_url: string;
  readonly updated_at: string;
  readonly pull_request?: unknown;
  readonly assignees?: ReadonlyArray<{ readonly login: string }>;
  readonly labels?: ReadonlyArray<{ readonly name: string }>;
}

function mapIssue(raw: RawGithubIssue): ExternalWorkItem {
  const assignees = raw.assignees?.map((a) => a.login);
  const labels = raw.labels?.map((l) => l.name);
  return {
    provider: "github",
    externalId: String(raw.number),
    url: raw.html_url,
    lifecycle: raw.state === "open" ? "open" : "closed",
    version: { updatedAt: raw.updated_at },
    fields: {
      title: raw.title,
      // exactOptionalPropertyTypes: only spread when value is defined
      ...(raw.body != null && { description: raw.body }),
      ...(assignees !== undefined && { assignees }),
      ...(labels !== undefined && { labels }),
    },
  };
}

// ---------------------------------------------------------------------------
// Provider implementation
// ---------------------------------------------------------------------------

const make = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  const connectionStore = yield* WorkSourceConnectionStore;

  function buildHeaders(pat: string): Record<string, string> {
    return {
      authorization: `Bearer ${pat}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": GITHUB_API_VERSION,
      "user-agent": USER_AGENT,
    };
  }

  const provider: WorkSourceProvider = {
    provider: "github",
    selectorSchema: GithubSelector,

    listPage: (input) =>
      Effect.gen(function* () {
        // Decode selector
        const selector = yield* Schema.decodeUnknownEffect(GithubSelector)(input.selector).pipe(
          Effect.mapError(
            (e) => new WorkSourceConfigError({ message: `Invalid GitHub selector: ${e.message}` }),
          ),
        );

        const pat = yield* connectionStore.getToken(input.connectionRef, "github");
        const now = yield* DateTime.now;
        const nowMs = DateTime.toEpochMillis(now);

        const { owner, repo, labels, assignee, state } = selector;

        // Build URL params
        const urlParams: Array<readonly [string, string]> = [
          ["state", state],
          ["per_page", String(input.pageSize)],
          ["page", String(input.pageToken ?? "1")],
        ];
        if (input.since) urlParams.push(["since", input.since]);
        if (labels && labels.length > 0) urlParams.push(["labels", labels.join(",")]);
        if (assignee) urlParams.push(["assignee", assignee]);

        const request = HttpClientRequest.get(
          `${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`,
          { urlParams },
        ).pipe(HttpClientRequest.setHeaders(buildHeaders(pat)));

        const response = yield* client.execute(request).pipe(
          Effect.mapError(
            (cause) =>
              new WorkSourceTransientError({
                message: `GitHub HTTP network error: ${String(cause)}`,
              }),
          ),
        );

        const { status, headers } = response;

        // Status error mapping.
        // Detect rate-limit FIRST so a secondary/abuse 403 (carries retry-after
        // but keeps x-ratelimit-remaining > 0) is not swallowed by the auth
        // fallback below. A 403 is a rate limit when GitHub signals one: primary
        // limit exhausted (x-ratelimit-remaining === "0") OR a secondary limit
        // (retry-after present).
        if (
          status === 429 ||
          (status === 403 &&
            (headers["x-ratelimit-remaining"] === "0" || headers["retry-after"] !== undefined))
        ) {
          return yield* new WorkSourceRateLimitError({
            retryAfterMs: parseRateLimitRetryMs(headers, nowMs),
          });
        }
        if (status === 401 || (status === 403 && !headers["x-ratelimit-remaining"])) {
          // 401 always auth; 403 without rate-limit headers → auth/permission
          return yield* new WorkSourceAuthError({ connectionRef: input.connectionRef });
        }
        if (status < 200 || status >= 300) {
          const body = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
          return yield* new WorkSourceTransientError({
            message: `GitHub API returned HTTP ${status}: ${body.trim() || "(no body)"}`,
          });
        }

        const rawItems = yield* response.json.pipe(
          Effect.mapError(
            (cause) =>
              new WorkSourceTransientError({
                message: `Failed to parse GitHub JSON response: ${String(cause)}`,
              }),
          ),
        );

        if (!Array.isArray(rawItems)) {
          return yield* new WorkSourceTransientError({
            message: "GitHub /issues response was not an array",
          });
        }

        const items: Array<ExternalWorkItem> = [];
        for (const raw of rawItems as RawGithubIssue[]) {
          // Skip pull requests (GitHub includes PRs in /issues endpoint)
          if (raw.pull_request !== undefined) continue;
          items.push(mapIssue(raw));
        }

        const linkHeader = headers["link"];
        const nextPageToken = parseNextPageFromLinkHeader(linkHeader);

        // exactOptionalPropertyTypes: only include nextPageToken when present
        const page: WorkSourcePage = {
          items,
          ...(nextPageToken !== undefined && { nextPageToken }),
        };
        return page;
      }),

    getItem: (input) =>
      Effect.gen(function* () {
        const selector = yield* Schema.decodeUnknownEffect(GithubSelector)(input.selector).pipe(
          Effect.mapError(
            (e) => new WorkSourceConfigError({ message: `Invalid GitHub selector: ${e.message}` }),
          ),
        );

        const pat = yield* connectionStore.getToken(input.connectionRef, "github");
        const now = yield* DateTime.now;
        const nowMs = DateTime.toEpochMillis(now);

        const { owner, repo } = selector;

        const request = HttpClientRequest.get(
          `${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${encodeURIComponent(input.externalId)}`,
        ).pipe(HttpClientRequest.setHeaders(buildHeaders(pat)));

        const response = yield* client.execute(request).pipe(
          Effect.mapError(
            (cause) =>
              new WorkSourceTransientError({
                message: `GitHub HTTP network error (getItem): ${String(cause)}`,
              }),
          ),
        );

        const { status, headers } = response;

        // 404 → genuinely deleted upstream.
        if (status === 404) {
          return null;
        }
        // Detect rate-limit FIRST so a secondary/abuse 403 (retry-after present,
        // x-ratelimit-remaining > 0) is not misread as auth — see listPage.
        if (
          status === 429 ||
          (status === 403 &&
            (headers["x-ratelimit-remaining"] === "0" || headers["retry-after"] !== undefined))
        ) {
          return yield* new WorkSourceRateLimitError({
            retryAfterMs: parseRateLimitRetryMs(headers, nowMs),
          });
        }
        if (status === 401 || (status === 403 && !headers["x-ratelimit-remaining"])) {
          return yield* new WorkSourceAuthError({ connectionRef: input.connectionRef });
        }
        if (status < 200 || status >= 300) {
          const body = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
          return yield* new WorkSourceTransientError({
            message: `GitHub API returned HTTP ${status} (getItem): ${body.trim() || "(no body)"}`,
          });
        }

        const rawItem = yield* response.json.pipe(
          Effect.mapError(
            (cause) =>
              new WorkSourceTransientError({
                message: `Failed to parse GitHub getItem JSON response: ${String(cause)}`,
              }),
          ),
        );

        // Guard the shape: the single-issue endpoint returns an object, not an
        // array. A non-conforming body → transient (back off, never confirm).
        if (rawItem === null || typeof rawItem !== "object" || Array.isArray(rawItem)) {
          return yield* new WorkSourceTransientError({
            message: "GitHub /issues/:number response was not an object",
          });
        }

        // The item still exists upstream (it merely fell out of the filter):
        // return it so the syncer leaves confirmedDeleted=false.
        return mapIssue(rawItem as unknown as RawGithubIssue);
      }),

    toImportableView: ({ selector, item }): ImportableViewParts => {
      const s = selector as { owner?: string; repo?: string };
      return { displayRef: `#${item.externalId}`, container: `${s.owner ?? "?"}/${s.repo ?? "?"}` };
    },

    viewer: ({ connectionRef }) =>
      Effect.gen(function* () {
        const pat = yield* connectionStore.getToken(connectionRef, "github");
        const request = HttpClientRequest.get(`${GITHUB_API_BASE}/user`).pipe(
          HttpClientRequest.setHeaders(buildHeaders(pat)),
        );
        const response = yield* client.execute(request).pipe(
          Effect.mapError(
            (cause) =>
              new WorkSourceTransientError({
                message: `GitHub viewer network error: ${String(cause)}`,
              }),
          ),
        );
        if (response.status !== 200) return null; // best-effort: never fail the read RPC
        const body = yield* response.json.pipe(Effect.orElseSucceed(() => ({}) as unknown));
        const login = (body as { login?: unknown }).login;
        return typeof login === "string" && login.length > 0
          ? { id: login, aliases: [login] }
          : null;
      }),
  };

  return provider;
});

export const GithubIssuesProviderLive: Layer.Layer<
  GithubIssuesProviderTag,
  never,
  HttpClient.HttpClient | WorkSourceConnectionStore
> = Layer.effect(GithubIssuesProviderTag, make);
