import type { ProviderHashReference } from "@t3tools/source-control-core/server/PullRequestProvider";
import { decodeJsonResult } from "@t3tools/shared/schemaJson";
import * as Exit from "effect/Exit";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

const RawIssueSchema = Schema.Struct({
  iid: Schema.Int,
  title: Schema.String,
  web_url: Schema.String,
  state: Schema.optional(Schema.NullOr(Schema.String)),
  updated_at: Schema.String,
});

const decodeIssue = decodeJsonResult(RawIssueSchema);
const decodeUnknownList = decodeJsonResult(Schema.Array(Schema.Unknown));
const decodeIssueEntry = Schema.decodeUnknownExit(RawIssueSchema);

function projectPath(repository: string): string {
  return encodeURIComponent(repository.trim());
}

function query(params: ReadonlyArray<readonly [string, string]>): string {
  return params.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join("&");
}

function toIssueReference(raw: {
  readonly iid: number;
  readonly title: string;
  readonly web_url: string;
  readonly state?: string | null | undefined;
  readonly updated_at: string;
}): ProviderHashReference | null {
  if (!Number.isSafeInteger(raw.iid) || raw.iid <= 0) return null;
  return {
    kind: "issue",
    number: raw.iid,
    title: raw.title,
    url: raw.web_url,
    state: raw.state === "closed" ? "closed" : "open",
    updatedAt: raw.updated_at,
  };
}

export function hashReferenceSearchPaths(input: {
  readonly repository: string;
  readonly query?: string | undefined;
  readonly limit: number;
}): {
  readonly number: number | null;
  readonly issueListPath: string | null;
  readonly issueDetailPath: string | null;
} | null {
  const repository = input.repository.trim();
  if (repository.length === 0) return null;
  const queryText = input.query?.trim() ?? "";
  const number =
    queryText.length > 0 && /^\d+$/u.test(queryText) && Number.isSafeInteger(Number(queryText))
      ? Number(queryText)
      : null;
  const limit = Math.max(1, Math.min(100, input.limit));
  const encoded = projectPath(repository);
  return {
    number,
    issueListPath:
      number !== null
        ? null
        : `projects/${encoded}/issues?${query([
            ["state", "all"],
            ["order_by", "updated_at"],
            ["sort", "desc"],
            ["per_page", String(limit)],
            ...(queryText.length === 0 ? [] : [["search", queryText] as const]),
          ])}`,
    issueDetailPath: number === null ? null : `projects/${encoded}/issues/${number}`,
  };
}

export function decodeIssueListBody(body: string): ReadonlyArray<ProviderHashReference> {
  const decoded = decodeUnknownList(body);
  if (!Result.isSuccess(decoded)) return [];
  return decoded.success.flatMap((entry) => {
    const item = decodeIssueEntry(entry);
    if (!Exit.isSuccess(item)) return [];
    const reference = toIssueReference(item.value);
    return reference === null ? [] : [reference];
  });
}

export function decodeIssueDetailBody(body: string): ProviderHashReference | null {
  const decoded = decodeIssue(body);
  if (!Result.isSuccess(decoded)) return null;
  return toIssueReference(decoded.success);
}
