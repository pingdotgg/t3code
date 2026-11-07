import {
  trimOptionalString,
  normalizeRefName,
} from "@t3tools/source-control-core/server/pullRequestUtils";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { PositiveInt, TrimmedNonEmptyString } from "@t3tools/contracts";
import { decodeJsonResult } from "@t3tools/shared/schemaJson";

import { azureDevOpsPullRequestWebUrl } from "../shared/pullRequestUrls.ts";

export interface NormalizedAzureDevOpsPullRequestRecord {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly baseRefName: string;
  readonly headRefName: string;
  readonly headSha?: string;
  readonly state: "open" | "closed" | "merged";
  readonly isDraft?: boolean;
  readonly isCrossRepository: boolean;
  readonly closedAt?: string | null;
  readonly mergedAt?: string | null;
  readonly updatedAt: Option.Option<DateTime.Utc>;
}

const AzureDevOpsPullRequestSchema = Schema.Struct({
  pullRequestId: PositiveInt,
  title: TrimmedNonEmptyString,
  url: Schema.optional(Schema.String),
  repository: Schema.optional(
    Schema.Struct({
      name: Schema.optional(Schema.String),
      webUrl: Schema.optional(Schema.String),
      project: Schema.optional(
        Schema.Struct({
          name: Schema.optional(Schema.String),
        }),
      ),
    }),
  ),
  sourceRefName: TrimmedNonEmptyString,
  targetRefName: TrimmedNonEmptyString,
  /** The source branch's tip as of Azure's last merge evaluation: the pull request's head. */
  lastMergeSourceCommit: Schema.optional(
    Schema.NullOr(Schema.Struct({ commitId: Schema.optional(Schema.NullOr(Schema.String)) })),
  ),
  status: Schema.String,
  isDraft: Schema.optional(Schema.Boolean),
  /** `az` prints `null` for a pull request from the same repo. */
  forkSource: Schema.optional(Schema.Unknown),
  creationDate: Schema.optional(Schema.OptionFromNullOr(Schema.DateTimeUtcFromString)),
  closedDate: Schema.optional(Schema.OptionFromNullOr(Schema.DateTimeUtcFromString)),
  _links: Schema.optional(
    Schema.Struct({
      web: Schema.optional(
        Schema.Struct({
          href: Schema.String,
        }),
      ),
    }),
  ),
});

function normalizeAzureDevOpsPullRequestState(status: string): "open" | "closed" | "merged" {
  switch (status.trim().toLowerCase()) {
    case "completed":
      return "merged";
    case "abandoned":
      return "closed";
    default:
      return "open";
  }
}

function normalizeAzureDevOpsPullRequestUrl(
  raw: Schema.Schema.Type<typeof AzureDevOpsPullRequestSchema>,
): string {
  return azureDevOpsPullRequestWebUrl({
    pullRequestId: raw.pullRequestId,
    webLink: raw._links?.web?.href,
    repositoryWebUrl: raw.repository?.webUrl,
    restApiUrl: raw.url,
    projectName: raw.repository?.project?.name,
    repositoryName: raw.repository?.name,
  });
}

function normalizeAzureDevOpsPullRequestRecord(
  raw: Schema.Schema.Type<typeof AzureDevOpsPullRequestSchema>,
): NormalizedAzureDevOpsPullRequestRecord {
  const state = normalizeAzureDevOpsPullRequestState(raw.status);
  const headSha = trimOptionalString(raw.lastMergeSourceCommit?.commitId);
  const terminalAt = Option.match(raw.closedDate ?? Option.none(), {
    onNone: () => null,
    onSome: DateTime.formatIso,
  });
  return {
    number: raw.pullRequestId,
    title: raw.title,
    url: normalizeAzureDevOpsPullRequestUrl(raw),
    baseRefName: normalizeRefName(raw.targetRefName),
    headRefName: normalizeRefName(raw.sourceRefName),
    ...(headSha ? { headSha } : {}),
    state,
    ...(raw.isDraft === true ? { isDraft: true } : {}),
    isCrossRepository: raw.forkSource != null,
    closedAt: state === "closed" ? terminalAt : null,
    mergedAt: state === "merged" ? terminalAt : null,
    updatedAt: (raw.closedDate ?? Option.none()).pipe(
      Option.orElse(() => raw.creationDate ?? Option.none()),
    ),
  };
}

const decodeAzureDevOpsPullRequestList = decodeJsonResult(Schema.Array(Schema.Unknown));
const decodeAzureDevOpsPullRequest = decodeJsonResult(AzureDevOpsPullRequestSchema);
const decodeAzureDevOpsPullRequestEntry = Schema.decodeUnknownExit(AzureDevOpsPullRequestSchema);

export function decodeAzureDevOpsPullRequestListJson(
  raw: string,
): Result.Result<
  ReadonlyArray<NormalizedAzureDevOpsPullRequestRecord>,
  Cause.Cause<Schema.SchemaError>
> {
  const result = decodeAzureDevOpsPullRequestList(raw);
  if (Result.isSuccess(result)) {
    const pullRequests: NormalizedAzureDevOpsPullRequestRecord[] = [];
    for (const entry of result.success) {
      const decodedEntry = decodeAzureDevOpsPullRequestEntry(entry);
      if (Exit.isFailure(decodedEntry)) {
        continue;
      }
      pullRequests.push(normalizeAzureDevOpsPullRequestRecord(decodedEntry.value));
    }
    return Result.succeed(pullRequests);
  }
  return Result.fail(result.failure);
}

export function decodeAzureDevOpsPullRequestJson(
  raw: string,
): Result.Result<NormalizedAzureDevOpsPullRequestRecord, Cause.Cause<Schema.SchemaError>> {
  const result = decodeAzureDevOpsPullRequest(raw);
  if (Result.isSuccess(result)) {
    return Result.succeed(normalizeAzureDevOpsPullRequestRecord(result.success));
  }
  return Result.fail(result.failure);
}
