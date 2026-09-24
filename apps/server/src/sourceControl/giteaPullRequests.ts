import * as Cause from "effect/Cause";
import type * as DateTime from "effect/DateTime";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { PositiveInt, TrimmedNonEmptyString } from "@t3tools/contracts";
import { decodeJsonResult, formatSchemaError } from "@t3tools/shared/schemaJson";

export interface NormalizedGiteaPullRequestRecord {
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

const GiteaRepositoryReferenceSchema = Schema.Struct({
  full_name: Schema.optional(Schema.NullOr(Schema.String)),
  owner: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        login: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
});

/** A PR branch endpoint. `repo` is null when the fork it came from has been deleted. */
const GiteaBranchInfoSchema = Schema.Struct({
  ref: Schema.optional(Schema.NullOr(Schema.String)),
  label: Schema.optional(Schema.NullOr(Schema.String)),
  repo: Schema.optional(Schema.NullOr(GiteaRepositoryReferenceSchema)),
});

const GiteaPullRequestSchema = Schema.Struct({
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  html_url: TrimmedNonEmptyString,
  state: Schema.optional(Schema.NullOr(Schema.String)),
  merged: Schema.optional(Schema.NullOr(Schema.Boolean)),
  updated_at: Schema.optional(Schema.OptionFromNullOr(Schema.DateTimeUtcFromString)),
  base: GiteaBranchInfoSchema,
  head: GiteaBranchInfoSchema,
});

export type GiteaPullRequestJson = Schema.Schema.Type<typeof GiteaPullRequestSchema>;

function trimOptionalString(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Gitea models a merged PR as `state: "closed"` with `merged: true`, so merged has to be read off
 * the flag rather than the state string.
 */
function normalizeGiteaPullRequestState(
  state: string | null | undefined,
  merged: boolean | null | undefined,
): "open" | "closed" | "merged" {
  if (merged === true) return "merged";
  return state?.trim().toLowerCase() === "closed" ? "closed" : "open";
}

/**
 * `ref` is the plain branch name. `label` is `owner:branch` for a fork and a bare branch name
 * otherwise, so it is only a fallback when `ref` is missing.
 */
function branchRefName(
  branch: Schema.Schema.Type<typeof GiteaBranchInfoSchema> | null | undefined,
): string {
  const ref = trimOptionalString(branch?.ref);
  if (ref) return ref;

  const label = trimOptionalString(branch?.label);
  if (!label) return "";
  const separator = label.indexOf(":");
  return separator === -1 ? label : label.slice(separator + 1);
}

function repositoryFullName(
  branch: Schema.Schema.Type<typeof GiteaBranchInfoSchema> | null | undefined,
): string | null {
  return trimOptionalString(branch?.repo?.full_name);
}

function normalizeGiteaPullRequestRecord(
  raw: GiteaPullRequestJson,
): NormalizedGiteaPullRequestRecord {
  const headRepository = repositoryFullName(raw.head);
  const baseRepository = repositoryFullName(raw.base);
  const isCrossRepository =
    headRepository !== null && baseRepository !== null
      ? headRepository.toLowerCase() !== baseRepository.toLowerCase()
      : undefined;
  const headOwnerLogin =
    trimOptionalString(raw.head.repo?.owner?.login) ??
    trimOptionalString(headRepository?.split("/")[0]);

  return {
    number: raw.number,
    title: raw.title,
    url: raw.html_url,
    baseRefName: branchRefName(raw.base),
    headRefName: branchRefName(raw.head),
    state: normalizeGiteaPullRequestState(raw.state, raw.merged),
    updatedAt: raw.updated_at ?? Option.none(),
    ...(typeof isCrossRepository === "boolean" ? { isCrossRepository } : {}),
    ...(headRepository ? { headRepositoryNameWithOwner: headRepository } : {}),
    ...(headOwnerLogin ? { headRepositoryOwnerLogin: headOwnerLogin } : {}),
  };
}

const decodeGiteaPullRequestList = decodeJsonResult(Schema.Array(Schema.Unknown));
const decodeGiteaPullRequestBody = decodeJsonResult(GiteaPullRequestSchema);
const decodeGiteaPullRequestEntry = Schema.decodeUnknownExit(GiteaPullRequestSchema);

export const formatGiteaJsonDecodeError = formatSchemaError;

/** Entries that fail to decode are skipped so one malformed PR cannot blank the whole list. */
export function decodeGiteaPullRequestListJson(
  raw: string,
): Result.Result<ReadonlyArray<NormalizedGiteaPullRequestRecord>, Cause.Cause<Schema.SchemaError>> {
  const result = decodeGiteaPullRequestList(raw);
  if (Result.isSuccess(result)) {
    const pullRequests: NormalizedGiteaPullRequestRecord[] = [];
    for (const entry of result.success) {
      const decodedEntry = decodeGiteaPullRequestEntry(entry);
      if (Exit.isFailure(decodedEntry)) {
        continue;
      }
      pullRequests.push(normalizeGiteaPullRequestRecord(decodedEntry.value));
    }
    return Result.succeed(pullRequests);
  }
  return Result.fail(result.failure);
}

export function decodeGiteaPullRequestJson(
  raw: string,
): Result.Result<NormalizedGiteaPullRequestRecord, Cause.Cause<Schema.SchemaError>> {
  const result = decodeGiteaPullRequestBody(raw);
  if (Result.isSuccess(result)) {
    return Result.succeed(normalizeGiteaPullRequestRecord(result.success));
  }
  return Result.fail(result.failure);
}
