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
  /** The row's own times only; open pull requests are dated by their threads on top. */
  readonly updatedAt: Option.Option<DateTime.Utc>;
  readonly location: { readonly project: string; readonly repository: string } | null;
  readonly revision: string;
}

/**
 * The latest instant among Azure's timestamps, which mix offsets and precisions, in one ISO form
 * so later times also sort later as strings. Unreadable values are skipped.
 */
export function latestAzureDevOpsTime(values: Iterable<string | null | undefined>): string | null {
  let latest: DateTime.Utc | null = null;
  for (const value of values) {
    const at = DateTime.make(value?.trim() ?? "");
    if (Option.isSome(at) && (latest === null || DateTime.isGreaterThan(at.value, latest))) {
      latest = at.value;
    }
  }
  return latest === null ? null : DateTime.formatIso(latest);
}

/**
 * What a pull request row shows of pushes, votes and state. Both parsers build it the same way,
 * so a cached thread read stays valid across readers until the row itself moves.
 */
export function azureDevOpsActivityRevision(input: {
  readonly state: "open" | "closed" | "merged";
  readonly isDraft: boolean | null | undefined;
  readonly sourceCommit: string | null | undefined;
  readonly votes: ReadonlyArray<number | null | undefined>;
}): string {
  return [
    input.state,
    input.isDraft === true ? "draft" : "ready",
    trimOptionalString(input.sourceCommit) ?? "",
    input.votes.map((vote) => vote ?? 0).join(","),
  ].join(" ");
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
  reviewers: Schema.optional(
    Schema.NullOr(
      Schema.Array(Schema.Struct({ vote: Schema.optional(Schema.NullOr(Schema.Number)) })),
    ),
  ),
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

function encodeAzureDevOpsPathSegment(segment: string): string {
  return encodeURIComponent(segment);
}

function azureDevOpsOrganizationBaseFromRestApiUrl(
  value: string | null | undefined,
): string | null {
  const rawUrl = trimOptionalString(value);
  if (!rawUrl) {
    return null;
  }

  try {
    const url = new URL(rawUrl);
    const hostname = url.hostname.toLowerCase();
    const pathSegments = url.pathname.split("/").filter((segment) => segment.length > 0);
    const isAzureRestUrl = pathSegments.some((segment) => segment.toLowerCase() === "_apis");
    if (!isAzureRestUrl) {
      return null;
    }

    if (hostname === "dev.azure.com") {
      const organization = pathSegments[0];
      return organization ? `${url.origin}/${organization}` : null;
    }

    if (hostname.endsWith(".visualstudio.com")) {
      return url.origin;
    }

    return null;
  } catch {
    return null;
  }
}

export function azureDevOpsPullRequestWebUrl(input: {
  readonly pullRequestId: number;
  readonly webLink?: string | null | undefined;
  readonly repositoryWebUrl?: string | null | undefined;
  readonly restApiUrl?: string | null | undefined;
  readonly projectName?: string | null | undefined;
  readonly repositoryName?: string | null | undefined;
}): string {
  const webLink = trimOptionalString(input.webLink);
  if (webLink) {
    return webLink;
  }

  const repositoryWebUrl = trimOptionalString(input.repositoryWebUrl);
  if (repositoryWebUrl) {
    return `${repositoryWebUrl.replace(/\/+$/, "")}/pullrequest/${input.pullRequestId}`;
  }

  const organizationBase = azureDevOpsOrganizationBaseFromRestApiUrl(input.restApiUrl);
  const projectName = trimOptionalString(input.projectName);
  const repositoryName = trimOptionalString(input.repositoryName);
  if (organizationBase && projectName && repositoryName) {
    const encodedProjectName = encodeAzureDevOpsPathSegment(projectName);
    const encodedRepositoryName = encodeAzureDevOpsPathSegment(repositoryName);
    return `${organizationBase}/${encodedProjectName}/_git/${encodedRepositoryName}/pullrequest/${input.pullRequestId}`;
  }

  return trimOptionalString(input.restApiUrl) ?? "";
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
  const projectName = trimOptionalString(raw.repository?.project?.name);
  const repositoryName = trimOptionalString(raw.repository?.name);
  const rowTimes = [raw.creationDate, raw.closedDate].flatMap((at) =>
    at === undefined ? [] : Option.toArray(at),
  );
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
    updatedAt: Option.fromNullishOr(
      rowTimes.reduce<DateTime.Utc | null>(
        (latest, at) => (latest === null ? at : DateTime.max(latest, at)),
        null,
      ),
    ),
    location:
      projectName && repositoryName ? { project: projectName, repository: repositoryName } : null,
    revision: azureDevOpsActivityRevision({
      state,
      isDraft: raw.isDraft,
      sourceCommit: raw.lastMergeSourceCommit?.commitId,
      votes: (raw.reviewers ?? []).map((reviewer) => reviewer.vote),
    }),
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
