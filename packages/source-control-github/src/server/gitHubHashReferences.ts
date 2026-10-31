import type { ProviderHashReference } from "@t3tools/source-control-core/server/PullRequestProvider";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const SEARCH_REPOSITORY = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

function parseRepositorySelector(value: string): {
  readonly owner: string;
  readonly name: string;
} {
  const parts = value.trim().split("/").filter(Boolean);
  return { name: parts.at(-1) ?? "", owner: parts.at(-2) ?? "" };
}

/** Quote user text so GitHub cannot interpret it as search qualifiers. */
function searchPhrase(query: string): string {
  return `"${query.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

const IssueSearchItem = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  html_url: Schema.String,
  state: Schema.String,
  updated_at: Schema.String,
  pull_request: Schema.optional(Schema.Unknown),
});

const IssueSearchResponse = Schema.Struct({
  items: Schema.Array(IssueSearchItem),
});

const IssueDetail = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  html_url: Schema.String,
  state: Schema.String,
  updated_at: Schema.String,
  pull_request: Schema.optional(Schema.Unknown),
});

const DiscussionListItem = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  html_url: Schema.String,
  updated_at: Schema.String,
  category: Schema.optional(
    Schema.Struct({
      name: Schema.optional(Schema.String),
    }),
  ),
  state_reason: Schema.optional(Schema.NullOr(Schema.String)),
});

const DiscussionListResponse = Schema.Array(DiscussionListItem);

const DiscussionDetail = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  html_url: Schema.String,
  updated_at: Schema.String,
  category: Schema.optional(
    Schema.Struct({
      name: Schema.optional(Schema.String),
    }),
  ),
  state_reason: Schema.optional(Schema.NullOr(Schema.String)),
});

const decodeIssueSearch = Schema.decodeUnknownOption(Schema.fromJsonString(IssueSearchResponse));
const decodeIssueDetail = Schema.decodeUnknownOption(Schema.fromJsonString(IssueDetail));
const decodeDiscussionList = Schema.decodeUnknownOption(
  Schema.fromJsonString(DiscussionListResponse),
);
const decodeDiscussionDetail = Schema.decodeUnknownOption(Schema.fromJsonString(DiscussionDetail));

function toIssueReference(item: {
  readonly number: number;
  readonly title: string;
  readonly html_url: string;
  readonly state: string;
  readonly updated_at: string;
  readonly pull_request?: unknown;
}): ProviderHashReference | null {
  if (item.pull_request !== undefined) return null;
  if (!Number.isSafeInteger(item.number) || item.number <= 0) return null;
  return {
    kind: "issue",
    number: item.number,
    title: item.title,
    url: item.html_url,
    state: item.state === "closed" ? "closed" : "open",
    updatedAt: item.updated_at,
  };
}

function toDiscussionReference(item: {
  readonly number: number;
  readonly title: string;
  readonly html_url: string;
  readonly updated_at: string;
  readonly category?: { readonly name?: string | undefined } | undefined;
  readonly state_reason?: string | null | undefined;
}): ProviderHashReference | null {
  if (!Number.isSafeInteger(item.number) || item.number <= 0) return null;
  const category = item.category?.name;
  return {
    kind: "discussion",
    number: item.number,
    title: item.title,
    url: item.html_url,
    state: item.state_reason == null ? "open" : "closed",
    updatedAt: item.updated_at,
    ...(category ? { category } : {}),
  };
}

/** Cap text-query discussion scans so a huge repo cannot fan out unbounded REST pages. */
export const DISCUSSION_TEXT_SEARCH_MAX_PAGES = 5;
export const DISCUSSION_TEXT_SEARCH_PAGE_SIZE = 100;

export function discussionListPath(input: {
  readonly owner: string;
  readonly name: string;
  readonly perPage: number;
  readonly page?: number | undefined;
}): string {
  const page = input.page ?? 1;
  return `repos/${input.owner}/${input.name}/discussions?per_page=${input.perPage}&page=${page}&sort=updated`;
}

export function hashReferenceSearchPaths(input: {
  readonly repository: string;
  readonly query?: string | undefined;
  readonly limit: number;
}): {
  readonly owner: string;
  readonly name: string;
  readonly number: number | null;
  readonly issueSearchPath: string | null;
  readonly discussionListPath: string;
  readonly discussionListPerPage: number;
  readonly paginateDiscussions: boolean;
  readonly issueDetailPath: string | null;
  readonly discussionDetailPath: string | null;
} | null {
  if (!SEARCH_REPOSITORY.test(input.repository.trim())) return null;
  const { owner, name } = parseRepositorySelector(input.repository);
  if (!owner || !name) return null;
  const query = input.query?.trim() ?? "";
  const number =
    query.length > 0 && /^\d+$/u.test(query) && Number.isSafeInteger(Number(query))
      ? Number(query)
      : null;
  const limit = Math.max(1, Math.min(50, input.limit));
  // Recent (empty) queries stay limit-sized; text queries page at 100 so matches past the first
  // page still surface.
  const paginateDiscussions = number === null && query.length > 0;
  const discussionListPerPage = paginateDiscussions ? DISCUSSION_TEXT_SEARCH_PAGE_SIZE : limit;
  const issueSearch =
    number !== null
      ? null
      : [
          "is:issue",
          `repo:${owner}/${name}`,
          ...(query.length === 0 ? [] : [searchPhrase(query)]),
          "sort:updated-desc",
        ].join(" ");
  return {
    owner,
    name,
    number,
    issueSearchPath:
      issueSearch === null
        ? null
        : `search/issues?q=${encodeURIComponent(issueSearch)}&per_page=${limit}`,
    discussionListPath: discussionListPath({
      owner,
      name,
      perPage: discussionListPerPage,
      page: 1,
    }),
    discussionListPerPage,
    paginateDiscussions,
    issueDetailPath: number === null ? null : `repos/${owner}/${name}/issues/${number}`,
    discussionDetailPath: number === null ? null : `repos/${owner}/${name}/discussions/${number}`,
  };
}

export function decodeIssueSearchBody(body: string): ReadonlyArray<ProviderHashReference> {
  return Option.match(decodeIssueSearch(body), {
    onNone: () => [],
    onSome: (decoded) =>
      decoded.items.flatMap((item) => {
        const reference = toIssueReference(item);
        return reference === null ? [] : [reference];
      }),
  });
}

export function decodeIssueDetailBody(body: string): ProviderHashReference | null {
  return Option.match(decodeIssueDetail(body), {
    onNone: () => null,
    onSome: toIssueReference,
  });
}

export function decodeDiscussionListPage(
  body: string,
  query: string,
): {
  readonly items: ReadonlyArray<ProviderHashReference>;
  readonly rawCount: number;
} {
  return Option.match(decodeDiscussionList(body), {
    onNone: () => ({ items: [], rawCount: 0 }),
    onSome: (items) => {
      const words = query.toLowerCase().split(/\s+/u).filter(Boolean);
      return {
        rawCount: items.length,
        items: items.flatMap((item) => {
          const reference = toDiscussionReference(item);
          if (reference === null) return [];
          if (words.length === 0) return [reference];
          const text = `#${reference.number} ${reference.title}`.toLowerCase();
          return words.every((word) => text.includes(word)) ? [reference] : [];
        }),
      };
    },
  });
}

export function decodeDiscussionListBody(
  body: string,
  query: string,
): ReadonlyArray<ProviderHashReference> {
  return decodeDiscussionListPage(body, query).items;
}

export function decodeDiscussionDetailBody(body: string): ProviderHashReference | null {
  return Option.match(decodeDiscussionDetail(body), {
    onNone: () => null,
    onSome: toDiscussionReference,
  });
}
