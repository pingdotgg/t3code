import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import type { ChangeRequest } from "@t3tools/contracts";

const Repository = Schema.Struct({
  full_name: Schema.String,
  owner: Schema.Struct({ login: Schema.String }),
});
const Branch = Schema.Struct({
  ref: Schema.String,
  sha: Schema.String,
  repo: Schema.NullOr(Repository),
});
export const ForgejoPullRequestSchema = Schema.Struct({
  number: Schema.Int,
  title: Schema.String,
  html_url: Schema.String,
  state: Schema.String,
  merged: Schema.Boolean,
  draft: Schema.optional(Schema.Boolean),
  base: Branch,
  head: Branch,
  closed_at: Schema.optional(Schema.NullOr(Schema.String)),
  merged_at: Schema.optional(Schema.NullOr(Schema.String)),
  updated_at: Schema.optional(Schema.OptionFromNullOr(Schema.DateTimeUtcFromString)),
});
export function toForgejoChangeRequest(raw: typeof ForgejoPullRequestSchema.Type): ChangeRequest {
  return {
    provider: "forgejo",
    number: raw.number,
    title: raw.title,
    url: raw.html_url,
    state: raw.merged ? "merged" : raw.state === "closed" ? "closed" : "open",
    isDraft: raw.draft ?? /^(?:\[WIP\]|WIP:)/i.test(raw.title),
    baseRefName: raw.base.ref,
    headRefName: raw.head.ref,
    closedAt: raw.closed_at ?? null,
    mergedAt: raw.merged_at ?? null,
    updatedAt: raw.updated_at ?? Option.none(),
    isCrossRepository:
      raw.head.repo !== null &&
      raw.base.repo !== null &&
      raw.head.repo.full_name !== raw.base.repo.full_name,
    headRepositoryNameWithOwner: raw.head.repo?.full_name ?? null,
    headRepositoryOwnerLogin: raw.head.repo?.owner.login ?? null,
  };
}
