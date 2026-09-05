import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { PositiveInt, TrimmedNonEmptyString } from "@t3tools/contracts";
import { decodeJsonResult, formatSchemaError } from "@t3tools/shared/schemaJson";

export interface NormalizedAzureDevOpsPullRequestRecord {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly baseRefName: string;
  readonly headRefName: string;
  readonly state: "open" | "closed" | "merged";
  readonly isDraft?: boolean;
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
  status: Schema.String,
  isDraft: Schema.optional(Schema.Boolean),
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

function trimOptionalString(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeRefName(refName: string): string {
  return refName.trim().replace(/^refs\/heads\//, "");
}

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

/**
 * The organization root a REST url belongs to, which is where a browser url and any further
 * REST call have to be hung. Exported because the pull requests page derives its own urls from
 * whatever Azure returned rather than from the local remote, whose shape varies.
 */
export function azureDevOpsOrganizationBaseFromRestApiUrl(
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

/**
 * Where a pull request lives in a browser. Azure answers with a web link when asked for one and
 * otherwise leaves it to be assembled, so all three routes are tried in the order they can be
 * trusted. Takes plain fields so both the source control provider and the pull requests page
 * can share it.
 */
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
  return {
    number: raw.pullRequestId,
    title: raw.title,
    url: normalizeAzureDevOpsPullRequestUrl(raw),
    baseRefName: normalizeRefName(raw.targetRefName),
    headRefName: normalizeRefName(raw.sourceRefName),
    state: normalizeAzureDevOpsPullRequestState(raw.status),
    ...(raw.isDraft === true ? { isDraft: true } : {}),
    updatedAt: (raw.closedDate ?? Option.none()).pipe(
      Option.orElse(() => raw.creationDate ?? Option.none()),
    ),
  };
}

const decodeAzureDevOpsPullRequestList = decodeJsonResult(Schema.Array(Schema.Unknown));
const decodeAzureDevOpsPullRequest = decodeJsonResult(AzureDevOpsPullRequestSchema);
const decodeAzureDevOpsPullRequestEntry = Schema.decodeUnknownExit(AzureDevOpsPullRequestSchema);

export const formatAzureDevOpsJsonDecodeError = formatSchemaError;

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
