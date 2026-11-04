import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { PositiveInt } from "@t3tools/contracts";
import { decodeJsonResult } from "@t3tools/shared/schemaJson";

function trimOptionalString(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
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
    const encodedProjectName = encodeURIComponent(projectName);
    const encodedRepositoryName = encodeURIComponent(repositoryName);
    return `${organizationBase}/${encodedProjectName}/_git/${encodedRepositoryName}/pullrequest/${input.pullRequestId}`;
  }

  return trimOptionalString(input.restApiUrl) ?? "";
}

// `az` prints every model attribute the response left unset, as null.
const decodeCreatedPullRequest = decodeJsonResult(
  Schema.Struct({
    pullRequestId: PositiveInt,
    url: Schema.optional(Schema.NullOr(Schema.String)),
    repository: Schema.optional(
      Schema.NullOr(
        Schema.Struct({
          name: Schema.optional(Schema.NullOr(Schema.String)),
          webUrl: Schema.optional(Schema.NullOr(Schema.String)),
          project: Schema.optional(
            Schema.NullOr(Schema.Struct({ name: Schema.optional(Schema.NullOr(Schema.String)) })),
          ),
        }),
      ),
    ),
    _links: Schema.optional(
      Schema.NullOr(
        Schema.Struct({
          web: Schema.optional(
            Schema.NullOr(Schema.Struct({ href: Schema.optional(Schema.NullOr(Schema.String)) })),
          ),
        }),
      ),
    ),
  }),
);

/**
 * The web URLs of the pull requests `az repos pr create` printed. Its default JSON output is
 * indented, so each object runs from a `{` line to the next `}` line, and JSON strings hold no
 * raw newline; other commands' output may surround it.
 */
export function azureDevOpsCreatedPullRequestUrls(output: string): ReadonlyArray<string> {
  const urls: Array<string> = [];
  const lines = output.split("\n");
  let start = -1;
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trimEnd();
    if (trimmed === "{") start = index;
    if (trimmed !== "}" || start === -1) continue;
    const decoded = decodeCreatedPullRequest(lines.slice(start, index + 1).join("\n"));
    start = -1;
    if (Result.isFailure(decoded)) continue;
    const raw = decoded.success;
    urls.push(
      azureDevOpsPullRequestWebUrl({
        pullRequestId: raw.pullRequestId,
        webLink: raw._links?.web?.href,
        repositoryWebUrl: raw.repository?.webUrl,
        restApiUrl: raw.url,
        projectName: raw.repository?.project?.name,
        repositoryName: raw.repository?.name,
      }),
    );
  }
  return urls;
}
