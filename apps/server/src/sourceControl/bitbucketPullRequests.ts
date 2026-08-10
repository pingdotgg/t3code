import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { PositiveInt, TrimmedNonEmptyString } from "@t3tools/contracts";

export interface NormalizedBitbucketPullRequestRecord {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly baseRefName: string;
  readonly headRefName: string;
  readonly state: "open" | "closed" | "merged";
  readonly updatedAt: Option.Option<DateTime.Utc>;
  readonly isCrossRepository?: boolean;
  readonly headRepositoryNameWithOwner?: string | null;
  readonly headRepositoryOwnerLogin?: string | null;
  readonly author?: string | null;
  readonly assignees?: ReadonlyArray<string>;
}

const BitbucketAccountSchema = Schema.Struct({
  nickname: Schema.optional(Schema.NullOr(Schema.String)),
  display_name: Schema.optional(Schema.NullOr(Schema.String)),
  account_id: Schema.optional(Schema.NullOr(Schema.String)),
});

export const BitbucketRepositoryRefSchema = Schema.Struct({
  full_name: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  workspace: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        slug: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
      }),
    ),
  ),
});

export const BitbucketPullRequestBranchSchema = Schema.Struct({
  repository: Schema.optional(Schema.NullOr(BitbucketRepositoryRefSchema)),
  branch: Schema.Struct({
    name: TrimmedNonEmptyString,
  }),
});

export const BitbucketPullRequestSchema = Schema.Struct({
  id: PositiveInt,
  title: TrimmedNonEmptyString,
  state: Schema.optional(Schema.NullOr(Schema.String)),
  updated_on: Schema.optional(Schema.OptionFromNullOr(Schema.DateTimeUtcFromString)),
  links: Schema.Struct({
    html: Schema.Struct({
      href: TrimmedNonEmptyString,
    }),
  }),
  source: BitbucketPullRequestBranchSchema,
  destination: BitbucketPullRequestBranchSchema,
  author: Schema.optional(Schema.NullOr(BitbucketAccountSchema)),
  // Bitbucket has no assignee concept on pull requests; reviewers are the
  // closest equivalent and are what the PR panel groups on.
  reviewers: Schema.optional(Schema.NullOr(Schema.Array(BitbucketAccountSchema))),
});

export const BitbucketPullRequestListSchema = Schema.Struct({
  values: Schema.Array(BitbucketPullRequestSchema),
  next: Schema.optional(TrimmedNonEmptyString),
});

function trimOptionalString(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function repositoryOwner(repository: Schema.Schema.Type<typeof BitbucketRepositoryRefSchema>) {
  return (
    trimOptionalString(repository.workspace?.slug) ??
    (repository.full_name?.includes("/") ? (repository.full_name.split("/")[0] ?? null) : null)
  );
}

function normalizeBitbucketPullRequestState(state: string | null | undefined) {
  switch (state?.trim().toUpperCase()) {
    case "MERGED":
      return "merged" as const;
    case "DECLINED":
    case "SUPERSEDED":
      return "closed" as const;
    case "OPEN":
    default:
      return "open" as const;
  }
}

function accountHandle(
  account: Schema.Schema.Type<typeof BitbucketAccountSchema> | null | undefined,
): string | null {
  return trimOptionalString(account?.nickname) ?? trimOptionalString(account?.display_name);
}

export function normalizeBitbucketPullRequestRecord(
  raw: Schema.Schema.Type<typeof BitbucketPullRequestSchema>,
): NormalizedBitbucketPullRequestRecord {
  const headRepositoryNameWithOwner = trimOptionalString(raw.source.repository?.full_name);
  const baseRepositoryNameWithOwner = trimOptionalString(raw.destination.repository?.full_name);
  const headRepositoryOwnerLogin = raw.source.repository
    ? repositoryOwner(raw.source.repository)
    : null;
  const isCrossRepository =
    headRepositoryNameWithOwner !== null &&
    baseRepositoryNameWithOwner !== null &&
    headRepositoryNameWithOwner !== baseRepositoryNameWithOwner;
  const author = accountHandle(raw.author);
  const assignees = [
    ...new Set(
      (raw.reviewers ?? [])
        .map(accountHandle)
        .filter((handle): handle is string => handle !== null),
    ),
  ];

  return {
    number: raw.id,
    title: raw.title,
    url: raw.links.html.href,
    baseRefName: raw.destination.branch.name,
    headRefName: raw.source.branch.name,
    state: normalizeBitbucketPullRequestState(raw.state),
    updatedAt: raw.updated_on ?? Option.none(),
    ...(isCrossRepository ? { isCrossRepository: true } : {}),
    ...(headRepositoryNameWithOwner ? { headRepositoryNameWithOwner } : {}),
    ...(headRepositoryOwnerLogin ? { headRepositoryOwnerLogin } : {}),
    ...(author ? { author } : {}),
    ...(assignees.length > 0 ? { assignees } : {}),
  };
}
