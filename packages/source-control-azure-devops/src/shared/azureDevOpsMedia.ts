import type { SourceControlMediaUrl } from "@t3tools/source-control-core/shared/definition";

/** A file attached to a pull request, as `az devops invoke` addresses it. */
export interface AzureDevOpsPullRequestAttachment {
  /** The organization URL, in the host family `az` keys its credentials by. */
  readonly organization: string;
  /** Route values, percent-encoded: `az` sends `%XX` as written and leaves `#` and `?` bare. */
  readonly project: string;
  readonly repository: string;
  readonly pullRequestId: number;
  readonly fileName: string;
}

const ORGANIZATION_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const ATTACHMENT_PATH_PATTERN =
  /^\/([^/]+)\/_apis\/git\/repositories\/([^/]+)\/pullrequests\/(\d+)\/attachments\/([^/]+)$/iu;

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

// Azure decodes route values before routing, so an escaped separator, a dot segment or a control
// character would let one value step into a neighbouring route.
const UNSAFE_ROUTE_CHARACTER = /[\p{Cc}\\/]/u;

/** One spelling per segment, so every link to a file shares its fetch URL. Null when unsafe. */
function routeValue(segment: string): string | null {
  const decoded = decodeSegment(segment);
  if (decoded === "." || decoded === ".." || UNSAFE_ROUTE_CHARACTER.test(decoded)) return null;
  return encodeURIComponent(decoded);
}

/**
 * Azure DevOps Services pull request attachments, the URLs Azure puts in a description or comment
 * for an uploaded image: `/{organization}/{project}/_apis/git/repositories/{repository}/
 * pullRequests/{id}/attachments/{fileName}` on dev.azure.com, and the same below the
 * organization's own host on visualstudio.com.
 */
export function azureDevOpsPullRequestAttachment(
  url: URL,
): AzureDevOpsPullRequestAttachment | null {
  if (url.protocol !== "https:" || url.port !== "" || url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  let organization: string | undefined;
  let path = url.pathname;
  let legacy = false;
  if (host === "dev.azure.com") {
    const slash = path.indexOf("/", 1);
    if (slash === -1) return null;
    organization = decodeSegment(path.slice(1, slash)).toLowerCase();
    path = path.slice(slash);
  } else if (host.endsWith(".visualstudio.com")) {
    organization = host.slice(0, -".visualstudio.com".length);
    path = path.replace(/^\/defaultcollection(?=\/)/iu, "");
    legacy = true;
  }
  if (organization === undefined || !ORGANIZATION_PATTERN.test(organization)) return null;
  const match = ATTACHMENT_PATH_PATTERN.exec(path);
  const [, project, repository, pullRequestId, fileName] = match ?? [];
  if (!project || !repository || !pullRequestId || !fileName) return null;
  const number = Number(pullRequestId);
  if (!Number.isSafeInteger(number) || number < 1) return null;
  const projectValue = routeValue(project);
  const repositoryValue = routeValue(repository);
  const fileNameValue = routeValue(fileName);
  if (projectValue === null || repositoryValue === null || fileNameValue === null) return null;
  return {
    organization: legacy
      ? `https://${organization}.visualstudio.com`
      : `https://dev.azure.com/${organization}`,
    project: projectValue,
    repository: repositoryValue,
    pullRequestId: number,
    fileName: fileNameValue,
  };
}

export function azureDevOpsMediaUrl(url: URL): SourceControlMediaUrl | null {
  const attachment = azureDevOpsPullRequestAttachment(url);
  if (attachment === null) return null;
  const name = decodeSegment(attachment.fileName).replace(/[\p{Cc}\\/]/gu, "");
  return {
    fetchUrl: [
      attachment.organization,
      attachment.project,
      "_apis/git/repositories",
      attachment.repository,
      "pullRequests",
      attachment.pullRequestId,
      "attachments",
      attachment.fileName,
    ].join("/"),
    fileName: name.length > 0 ? name : "azure-devops-media",
  };
}
