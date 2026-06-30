/**
 * AsanaProvider — raw-HTTP Asana Tasks work-source provider.
 *
 * Uses `HttpClient` from `effect/unstable/http` with a PAT fetched from
 * `WorkSourceConnectionStore.getToken`.  Mirrors the structure of
 * `GithubIssuesProvider` closely.
 *
 * ### externalId strategy
 * `externalId = gid` — Asana's globally unique task GID is stable and lets
 * `getItem` issue a simple `GET /tasks/:gid` lookup.  Unlike GitHub, we have
 * the full identifier in the `getItem` signature, so orphan-confirmation is
 * properly implemented (not deferred).
 *
 * ### nextPageToken strategy
 * Asana's response wraps results in `{ data: [...], next_page: { offset, path, uri } | null }`.
 * `nextPageToken = body.next_page?.offset` (a string token); absent/null → undefined.
 *
 * ### includeCompleted
 * Asana includes completed tasks by default.  To EXCLUDE completed tasks, we
 * pass `completed_since=now` (an ISO string in the past forces Asana to return
 * only tasks modified since that date that are NOT yet completed).  Actually,
 * the documented approach is: `completed_since=now` makes Asana return only
 * incomplete tasks.  When `selector.includeCompleted === true` (the default),
 * we omit the parameter.  When `selector.includeCompleted === false`, we add
 * `completed_since=now`.
 *
 * ### sectionGid / tagGid (v1 limitation)
 * The `AsanaSelector` schema accepts `sectionGid` and `tagGid` for future
 * filtering.  In v1 we always list the whole project via `project=projectGid`
 * and do NOT apply section or tag filtering.  These fields are reserved for
 * future use and are documented here as deferred.  To implement:
 *   - `sectionGid`: use `GET /sections/:gid/tasks` instead of `/tasks?project=`
 *   - `tagGid`:  use `GET /tasks?tag=:gid` (no `project=` in that case)
 * Both require restructuring the `listPage` URL; post-fetch filtering is not
 * sufficient because Asana does not return `memberships` by default.
 *
 * ### getItem
 * `GET /tasks/:gid?opt_fields=...` — proper orphan-confirmation (unlike GitHub
 * v1 which returns null).  404 → null (task deleted on Asana side).
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { AsanaSelector } from "@t3tools/contracts/workSource";

import {
  AsanaProvider as AsanaProviderTag,
  WorkSourceAuthError,
  WorkSourceConfigError,
  WorkSourceRateLimitError,
  WorkSourceTransientError,
  type ExternalWorkItem,
  type ImportableViewParts,
  type WorkSourcePage,
  type WorkSourceProvider,
} from "../Services/WorkSourceProvider.ts";
import { WorkSourceConnectionStore } from "../Services/WorkSourceConnectionStore.ts";

const ASANA_API_BASE = "https://app.asana.com/api/1.0";

const ASANA_TASK_OPT_FIELDS =
  "name,notes,completed,completed_at,assignee.name,tags.name,permalink_url,modified_at,gid";

// ---------------------------------------------------------------------------
// Rate-limit helper
// ---------------------------------------------------------------------------

function parseAsanaRateLimitRetryMs(headers: Record<string, string>): number {
  // Asana always sends Retry-After on 429 (seconds)
  const retryAfter = headers["retry-after"];
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (!Number.isNaN(seconds) && seconds > 0) return seconds * 1000;
  }
  return 60_000; // fallback: 1 minute
}

// ---------------------------------------------------------------------------
// Raw Asana JSON shapes (loose — only fields we use)
// ---------------------------------------------------------------------------

interface RawAsanaAssignee {
  readonly name: string;
}

interface RawAsanaTag {
  readonly name: string;
}

interface RawAsanaTask {
  readonly gid: string;
  readonly name: string;
  readonly notes: string | null;
  readonly completed: boolean;
  readonly completed_at: string | null;
  readonly assignee: RawAsanaAssignee | null;
  readonly tags: ReadonlyArray<RawAsanaTag> | null;
  readonly permalink_url: string;
  readonly modified_at: string;
}

interface RawAsanaPage {
  readonly data: ReadonlyArray<RawAsanaTask>;
  readonly next_page: {
    readonly offset: string;
    readonly path: string;
    readonly uri: string;
  } | null;
}

function mapTask(raw: RawAsanaTask): ExternalWorkItem {
  const assignees = raw.assignee ? [raw.assignee.name] : undefined;
  const labels = raw.tags && raw.tags.length > 0 ? raw.tags.map((t) => t.name) : undefined;
  return {
    provider: "asana",
    externalId: raw.gid,
    url: raw.permalink_url,
    lifecycle: raw.completed ? "closed" : "open",
    version: { updatedAt: raw.modified_at },
    fields: {
      title: raw.name,
      // exactOptionalPropertyTypes: only spread when value is defined/truthy
      ...(raw.notes != null && raw.notes !== "" && { description: raw.notes }),
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
      accept: "application/json",
    };
  }

  const provider: WorkSourceProvider = {
    provider: "asana",
    selectorSchema: AsanaSelector,

    listPage: (input) =>
      Effect.gen(function* () {
        // Decode selector
        const selector = yield* Schema.decodeUnknownEffect(AsanaSelector)(input.selector).pipe(
          Effect.mapError(
            (e) => new WorkSourceConfigError({ message: `Invalid Asana selector: ${e.message}` }),
          ),
        );

        // v1 ops signal: section/tag filtering is not applied (we list the
        // whole project). Warn so an operator notices if a user scoped a source
        // to a section/tag expecting it to limit the synced tickets.
        if (selector.sectionGid || selector.tagGid) {
          yield* Effect.logWarning(
            "asana source: sectionGid/tagGid filtering is not applied in v1; syncing the entire project",
            { projectGid: selector.projectGid },
          );
        }

        const pat = yield* connectionStore.getToken(input.connectionRef, "asana");

        const { projectGid, includeCompleted } = selector;

        // Build URL params
        const urlParams: Array<readonly [string, string]> = [
          ["project", projectGid],
          ["opt_fields", ASANA_TASK_OPT_FIELDS],
          ["limit", String(input.pageSize)],
        ];
        if (input.since) urlParams.push(["modified_since", input.since]);
        if (input.pageToken) urlParams.push(["offset", input.pageToken]);
        // When includeCompleted is false, pass completed_since=now to get only
        // incomplete tasks.  When true (the default), omit the param.
        if (includeCompleted === false) {
          urlParams.push(["completed_since", "now"]);
        }
        // v1: sectionGid and tagGid are not yet applied — see file header.

        const request = HttpClientRequest.get(`${ASANA_API_BASE}/tasks`, { urlParams }).pipe(
          HttpClientRequest.setHeaders(buildHeaders(pat)),
        );

        const response = yield* client.execute(request).pipe(
          Effect.mapError(
            (cause) =>
              new WorkSourceTransientError({
                message: `Asana HTTP network error: ${String(cause)}`,
              }),
          ),
        );

        const { status, headers } = response;

        // 401 (bad/expired PAT) and 403 (PAT authenticates but lacks access to
        // the target project / insufficient scope) are both stable permission
        // failures — surface them as auth, NOT transient. Asana does not use
        // x-ratelimit headers (it signals rate limits via 429 + Retry-After), so
        // a 403 here is never a rate limit; classifying it transient would back
        // the source off and retry forever instead of flagging the permission
        // problem. (Mirrors GithubIssuesProvider's 403→auth handling.)
        if (status === 401 || status === 403) {
          return yield* new WorkSourceAuthError({ connectionRef: input.connectionRef });
        }
        if (status === 429) {
          return yield* new WorkSourceRateLimitError({
            retryAfterMs: parseAsanaRateLimitRetryMs(headers),
          });
        }
        if (status < 200 || status >= 300) {
          const body = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
          return yield* new WorkSourceTransientError({
            message: `Asana API returned HTTP ${status}: ${body.trim() || "(no body)"}`,
          });
        }

        const rawBody = (yield* response.json.pipe(
          Effect.mapError(
            (cause) =>
              new WorkSourceTransientError({
                message: `Failed to parse Asana JSON response: ${String(cause)}`,
              }),
          ),
        )) as unknown;

        // Guard the shape before iterating: a malformed/unexpected success body
        // (missing or non-array `data`) → transient failure (source backs off)
        // rather than a thrown defect that only the syncer's log-only catch sees.
        if (
          rawBody === null ||
          typeof rawBody !== "object" ||
          !Array.isArray((rawBody as { readonly data?: unknown }).data)
        ) {
          return yield* new WorkSourceTransientError({
            message: "Asana /tasks response did not contain a data array",
          });
        }

        const page0 = rawBody as RawAsanaPage;
        const items: Array<ExternalWorkItem> = [];
        for (const raw of page0.data) {
          items.push(mapTask(raw));
        }

        const nextPageToken = page0.next_page?.offset ?? undefined;

        const page: WorkSourcePage = {
          items,
          ...(nextPageToken !== undefined && { nextPageToken }),
        };
        return page;
      }),

    getItem: (input) =>
      Effect.gen(function* () {
        const pat = yield* connectionStore.getToken(input.connectionRef, "asana");

        const urlParams: Array<readonly [string, string]> = [["opt_fields", ASANA_TASK_OPT_FIELDS]];

        const request = HttpClientRequest.get(
          `${ASANA_API_BASE}/tasks/${encodeURIComponent(input.externalId)}`,
          { urlParams },
        ).pipe(HttpClientRequest.setHeaders(buildHeaders(pat)));

        const response = yield* client.execute(request).pipe(
          Effect.mapError(
            (cause) =>
              new WorkSourceTransientError({
                message: `Asana HTTP network error (getItem): ${String(cause)}`,
              }),
          ),
        );

        const { status } = response;

        if (status === 404) {
          return null;
        }
        // 401/403 → stable permission failure (see listPage). Not transient.
        if (status === 401 || status === 403) {
          return yield* new WorkSourceAuthError({ connectionRef: input.connectionRef });
        }
        if (status === 429) {
          return yield* new WorkSourceRateLimitError({
            retryAfterMs: parseAsanaRateLimitRetryMs(response.headers),
          });
        }
        if (status < 200 || status >= 300) {
          const body = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
          return yield* new WorkSourceTransientError({
            message: `Asana API returned HTTP ${status} (getItem): ${body.trim() || "(no body)"}`,
          });
        }

        const rawBody = (yield* response.json.pipe(
          Effect.mapError(
            (cause) =>
              new WorkSourceTransientError({
                message: `Failed to parse Asana getItem JSON response: ${String(cause)}`,
              }),
          ),
        )) as unknown;

        // Guard the shape: the single-task endpoint returns `{ data: {...} }`.
        if (
          rawBody === null ||
          typeof rawBody !== "object" ||
          typeof (rawBody as { readonly data?: unknown }).data !== "object" ||
          (rawBody as { readonly data?: unknown }).data === null
        ) {
          return yield* new WorkSourceTransientError({
            message: "Asana /tasks/:gid response did not contain a data object",
          });
        }

        return mapTask((rawBody as { readonly data: RawAsanaTask }).data);
      }),

    toImportableView: ({ selector, item: _item }): ImportableViewParts => {
      const s = selector as { projectGid?: string };
      return { displayRef: "", container: s.projectGid ?? "Asana" };
    },

    viewer: ({ connectionRef }) =>
      Effect.gen(function* () {
        const pat = yield* connectionStore.getToken(connectionRef, "asana");
        const request = HttpClientRequest.get(`${ASANA_API_BASE}/users/me`).pipe(
          HttpClientRequest.setHeaders(buildHeaders(pat)),
        );
        const response = yield* client.execute(request).pipe(
          Effect.mapError(
            (cause) =>
              new WorkSourceTransientError({
                message: `Asana viewer network error: ${String(cause)}`,
              }),
          ),
        );
        if (response.status !== 200) return null; // best-effort: never fail the read RPC
        const body = yield* response.json.pipe(Effect.orElseSucceed(() => ({}) as unknown));
        const data = (body as { data?: { gid?: unknown; name?: unknown } }).data;
        const gid = typeof data?.gid === "string" ? data.gid : null;
        if (gid === null) return null;
        const name = typeof data?.name === "string" ? data.name : "";
        return { id: gid, aliases: name ? [name] : [] };
      }),
  };

  return provider;
});

export const AsanaProviderLive: Layer.Layer<
  AsanaProviderTag,
  never,
  HttpClient.HttpClient | WorkSourceConnectionStore
> = Layer.effect(AsanaProviderTag, make);
