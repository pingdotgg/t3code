import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { PositiveInt, TrimmedNonEmptyString } from "@t3tools/contracts";

import type { ChangeRequest } from "@t3tools/contracts";

export type NormalizedBitbucketPullRequestRecord = Omit<ChangeRequest, "provider">;

export function normalizeBitbucketChangeRequestId(reference: string): string {
  return (
    /\/pull-requests\/(\d+)(?:\/|$)/u.exec(reference)?.[1] ?? reference.trim().replace(/^#/, "")
  );
}

export interface BitbucketServerRepositoryLocator {
  readonly projectKey: string;
  readonly repoSlug: string;
}

export function bitbucketServerRepositoryName(locator: BitbucketServerRepositoryLocator): string {
  return `${locator.projectKey}/${locator.repoSlug}`;
}

export const BitbucketServerRepositoryRefSchema = Schema.Struct({
  slug: TrimmedNonEmptyString,
  project: Schema.Struct({
    key: TrimmedNonEmptyString,
  }),
});

const BitbucketServerPullRequestRefSchema = Schema.Struct({
  displayId: TrimmedNonEmptyString,
  latestCommit: Schema.optional(TrimmedNonEmptyString),
  repository: Schema.optional(Schema.NullOr(BitbucketServerRepositoryRefSchema)),
});

export const BitbucketServerPullRequestSchema = Schema.Struct({
  id: PositiveInt,
  title: TrimmedNonEmptyString,
  state: Schema.optional(Schema.NullOr(Schema.String)),
  draft: Schema.optional(Schema.Boolean),
  updatedDate: Schema.optional(Schema.OptionFromNullOr(Schema.DateTimeUtcFromMillis)),
  fromRef: BitbucketServerPullRequestRefSchema,
  toRef: BitbucketServerPullRequestRefSchema,
  links: Schema.Struct({
    self: Schema.NonEmptyArray(
      Schema.Struct({
        href: TrimmedNonEmptyString,
      }),
    ),
  }),
});

export const BitbucketServerPullRequestPageSchema = Schema.Struct({
  values: Schema.Array(BitbucketServerPullRequestSchema),
  isLastPage: Schema.Boolean,
  nextPageStart: Schema.optional(Schema.Int),
});

function normalizeBitbucketServerPullRequestState(state: string | null | undefined) {
  switch (state?.trim().toUpperCase()) {
    case "MERGED":
      return "merged" as const;
    case "DECLINED":
      return "closed" as const;
    case "OPEN":
    default:
      return "open" as const;
  }
}

export function normalizeBitbucketServerPullRequestRecord(
  raw: Schema.Schema.Type<typeof BitbucketServerPullRequestSchema>,
): NormalizedBitbucketPullRequestRecord {
  const headRepositoryNameWithOwner = raw.fromRef.repository
    ? bitbucketServerRepositoryName({
        projectKey: raw.fromRef.repository.project.key,
        repoSlug: raw.fromRef.repository.slug,
      })
    : null;
  const baseRepositoryNameWithOwner = raw.toRef.repository
    ? bitbucketServerRepositoryName({
        projectKey: raw.toRef.repository.project.key,
        repoSlug: raw.toRef.repository.slug,
      })
    : null;
  const isCrossRepository =
    headRepositoryNameWithOwner !== null &&
    baseRepositoryNameWithOwner !== null &&
    headRepositoryNameWithOwner.toLowerCase() !== baseRepositoryNameWithOwner.toLowerCase();

  return {
    number: raw.id,
    title: raw.title,
    url: raw.links.self[0].href,
    baseRefName: raw.toRef.displayId,
    headRefName: raw.fromRef.displayId,
    ...(raw.fromRef.latestCommit ? { headSha: raw.fromRef.latestCommit } : {}),
    state: normalizeBitbucketServerPullRequestState(raw.state),
    ...(raw.draft === true ? { isDraft: true } : {}),
    updatedAt: raw.updatedDate ?? Option.none(),
    ...(isCrossRepository ? { isCrossRepository: true } : {}),
    ...(headRepositoryNameWithOwner ? { headRepositoryNameWithOwner } : {}),
    ...(raw.fromRef.repository
      ? { headRepositoryOwnerLogin: raw.fromRef.repository.project.key }
      : {}),
  };
}
