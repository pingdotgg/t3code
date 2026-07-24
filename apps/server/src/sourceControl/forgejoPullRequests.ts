import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { PositiveInt, TrimmedNonEmptyString } from "@t3tools/contracts";

export interface NormalizedForgejoPullRequestRecord {
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
}

export const ForgejoRepoRefSchema = Schema.Struct({
  full_name: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  clone_url: Schema.optional(Schema.NullOr(Schema.String)),
  ssh_url: Schema.optional(Schema.NullOr(Schema.String)),
  default_branch: Schema.optional(Schema.NullOr(Schema.String)),
  owner: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        login: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
      }),
    ),
  ),
});

export const ForgejoPullBranchSchema = Schema.Struct({
  ref: TrimmedNonEmptyString,
  repo: Schema.optional(Schema.NullOr(ForgejoRepoRefSchema)),
});

export const ForgejoPullRequestSchema = Schema.Struct({
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  state: Schema.optional(Schema.NullOr(Schema.String)),
  merged: Schema.optional(Schema.NullOr(Schema.Boolean)),
  html_url: TrimmedNonEmptyString,
  updated_at: Schema.optional(Schema.OptionFromNullOr(Schema.DateTimeUtcFromString)),
  base: ForgejoPullBranchSchema,
  head: ForgejoPullBranchSchema,
});

export const ForgejoPullRequestListSchema = Schema.Array(ForgejoPullRequestSchema);

function trimOptional(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeState(
  state: string | null | undefined,
  merged: boolean | null | undefined,
): "open" | "closed" | "merged" {
  if (merged === true) return "merged";
  return state?.trim().toLowerCase() === "closed" ? "closed" : "open";
}

export function normalizeForgejoPullRequestRecord(
  raw: Schema.Schema.Type<typeof ForgejoPullRequestSchema>,
): NormalizedForgejoPullRequestRecord {
  const headFullName = trimOptional(raw.head.repo?.full_name);
  const baseFullName = trimOptional(raw.base.repo?.full_name);
  const headOwner =
    trimOptional(raw.head.repo?.owner?.login) ??
    (headFullName?.includes("/") ? (headFullName.split("/")[0] ?? null) : null);
  const isCrossRepository =
    headFullName !== null && baseFullName !== null && headFullName !== baseFullName;

  return {
    number: raw.number,
    title: raw.title,
    url: raw.html_url,
    baseRefName: raw.base.ref,
    headRefName: raw.head.ref,
    state: normalizeState(raw.state, raw.merged ?? null),
    updatedAt: raw.updated_at ?? Option.none(),
    ...(isCrossRepository ? { isCrossRepository: true } : {}),
    ...(isCrossRepository && headFullName ? { headRepositoryNameWithOwner: headFullName } : {}),
    ...(isCrossRepository && headOwner ? { headRepositoryOwnerLogin: headOwner } : {}),
  };
}
