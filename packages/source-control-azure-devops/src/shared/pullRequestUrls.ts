import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { PositiveInt } from "@t3tools/contracts";
import { decodeJsonResult } from "@t3tools/shared/schemaJson";

function trimOptionalString(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
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

const OptionalString = Schema.optional(Schema.NullOr(Schema.String));

// `az` prints every attribute the response left unset as null.
const decodePrintedPullRequest = decodeJsonResult(
  Schema.Struct({
    pullRequestId: PositiveInt,
    url: OptionalString,
    repository: Schema.optional(
      Schema.NullOr(
        Schema.Struct({
          name: OptionalString,
          webUrl: OptionalString,
          project: Schema.optional(Schema.NullOr(Schema.Struct({ name: OptionalString }))),
        }),
      ),
    ),
  }),
);

/**
 * The web URLs of the pull requests `az repos pr` printed one at a time in its default indented
 * JSON, where only a whole object's braces sit unindented on lines of their own. Other output may
 * surround them; a listed pull request sits indented inside an array and is not read.
 */
export function azureDevOpsPrintedPullRequestUrls(output: string): ReadonlyArray<string> {
  const urls: Array<string> = [];
  const lines = output.split("\n").map((line) => line.trimEnd());
  let start = -1;
  for (const [index, line] of lines.entries()) {
    if (line === "{") start = index;
    if (line !== "}" || start === -1) continue;
    const decoded = decodePrintedPullRequest(lines.slice(start, index + 1).join("\n"));
    start = -1;
    if (Result.isFailure(decoded)) continue;
    const { pullRequestId, repository, url } = decoded.success;
    urls.push(
      azureDevOpsPullRequestWebUrl({
        pullRequestId,
        repositoryWebUrl: repository?.webUrl,
        restApiUrl: url,
        projectName: repository?.project?.name,
        repositoryName: repository?.name,
      }),
    );
  }
  return urls;
}
