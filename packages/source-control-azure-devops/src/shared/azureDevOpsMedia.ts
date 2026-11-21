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

/** One spelling per segment, rejecting dot segments, path separators, and control characters. */
function routeValue(segment: string): string | null {
  const decoded = decodeSegment(segment);
  return decoded.length === 0 ||
    decoded === "." ||
    decoded === ".." ||
    /[\p{Cc}/\\]/u.test(decoded)
    ? null
    : encodeURIComponent(decoded);
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
  const [, rawProject, rawRepository, pullRequestId, rawFileName] = match ?? [];
  if (!rawProject || !rawRepository || !pullRequestId || !rawFileName) return null;
  const project = routeValue(rawProject);
  const repository = routeValue(rawRepository);
  const fileName = routeValue(rawFileName);
  if (project === null || repository === null || fileName === null) return null;
  const number = Number(pullRequestId);
  if (!Number.isSafeInteger(number) || number < 1) return null;
  return {
    organization: legacy
      ? `https://${organization}.visualstudio.com`
      : `https://dev.azure.com/${organization}`,
    project,
    repository,
    pullRequestId: number,
    fileName,
  };
}

export function azureDevOpsMediaUrl(url: URL): SourceControlMediaUrl | null {
  const attachment = azureDevOpsPullRequestAttachment(url);
  if (attachment === null) return null;
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
    fileName: decodeSegment(attachment.fileName),
  };
}
