const MODERN_ATTACHMENT_PATH =
  /^\/([^/]+)\/([^/]+)\/_apis\/git\/repositories\/([^/]+)\/pullRequests\/(\d+)\/attachments\/([^/]+)$/iu;
const LEGACY_ATTACHMENT_PATH =
  /^\/(?:DefaultCollection\/)?([^/]+)\/_apis\/git\/repositories\/([^/]+)\/pullRequests\/(\d+)\/attachments\/([^/]+)$/iu;

export interface AzureDevOpsAttachment {
  readonly organizationUrl: string;
  readonly project: string;
  readonly repositoryId: string;
  readonly pullRequestId: string;
  readonly fileName: string;
  readonly fetchUrl: string;
}

/** Only pull request attachments may be fetched with the environment's Azure DevOps credential. */
export function azureDevOpsAttachment(url: URL): AzureDevOpsAttachment | null {
  if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
  const host = url.hostname.toLowerCase();
  const modern = host === "dev.azure.com";
  const legacy = /^([\w-]+)\.visualstudio\.com$/u.exec(host);
  if (!modern && !legacy) return null;
  const match = (modern ? MODERN_ATTACHMENT_PATH : LEGACY_ATTACHMENT_PATH).exec(url.pathname);
  if (!match) return null;
  let parts: string[];
  try {
    parts = match.slice(1).map(decodeURIComponent);
  } catch {
    return null;
  }
  if (parts.some((part) => /[\p{Cc}\\/]/u.test(part) || part === "." || part === "..")) {
    return null;
  }
  const [organization, project, repositoryId, pullRequestId, fileName] = modern
    ? parts
    : [legacy![1]!, ...parts];
  if (!organization || !project || !repositoryId || !pullRequestId || !fileName) return null;
  if (!/^[\w-]+$/u.test(organization)) return null;
  const organizationUrl = modern
    ? `https://dev.azure.com/${organization}`
    : `${url.origin}${/^\/DefaultCollection\//iu.test(url.pathname) ? "/DefaultCollection" : ""}`;
  const fetchUrl = `${organizationUrl}/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repositoryId)}/pullRequests/${pullRequestId}/attachments/${encodeURIComponent(fileName)}`;
  return { organizationUrl, project, repositoryId, pullRequestId, fileName, fetchUrl };
}
