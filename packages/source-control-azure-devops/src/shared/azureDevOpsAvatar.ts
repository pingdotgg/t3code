import type { SourceControlMediaUrl } from "@t3tools/source-control-core/shared/definition";

export interface AzureDevOpsAvatarIdentity {
  /** The organization `az devops --org` takes, which also picks the credential `az` signs in with. */
  readonly organizationUrl: string;
  readonly identityId: string;
}

const IDENTITY_IMAGE_PATH = "/_api/_common/identityimage";
const ORGANIZATION_SEGMENT_PATTERN = /^[a-z0-9][a-z0-9-]*$/iu;
const VISUAL_STUDIO_HOST_PATTERN = /^([a-z0-9][a-z0-9-]*)\.visualstudio\.com$/iu;
const IDENTITY_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function identityFromUrl(url: URL): AzureDevOpsAvatarIdentity | null {
  if (url.protocol !== "https:") return null;
  const identityId = url.searchParams.get("id")?.toLowerCase() ?? "";
  if (!IDENTITY_ID_PATTERN.test(identityId)) return null;
  const host = url.hostname.toLowerCase();
  const path = url.pathname.toLowerCase();
  if (host === "dev.azure.com") {
    const separator = path.indexOf("/", 1);
    const organization = separator === -1 ? "" : url.pathname.slice(1, separator);
    if (!ORGANIZATION_SEGMENT_PATTERN.test(organization)) return null;
    if (path.slice(separator) !== IDENTITY_IMAGE_PATH) return null;
    return { organizationUrl: `https://dev.azure.com/${organization}`, identityId };
  }
  const legacyHost = VISUAL_STUDIO_HOST_PATTERN.exec(host);
  if (legacyHost === null || path !== IDENTITY_IMAGE_PATH) return null;
  return { organizationUrl: `https://${legacyHost[1]}.visualstudio.com`, identityId };
}

/**
 * Reads the identity image URL Azure DevOps puts on pull request authors and reviewers. Only the
 * shapes `az` can authenticate against are accepted, so nothing else reaches the server's fetch.
 */
export function azureDevOpsAvatarIdentity(source: string): AzureDevOpsAvatarIdentity | null {
  return URL.canParse(source) ? identityFromUrl(new URL(source)) : null;
}

/** Identity images load only for a signed-in browser session, so the server fetches them. */
export function azureDevOpsAvatarMediaUrl(url: URL): SourceControlMediaUrl | null {
  const identity = identityFromUrl(url);
  return identity === null
    ? null
    : {
        fetchUrl: `${identity.organizationUrl}/_api/_common/identityImage?id=${identity.identityId}`,
        fileName: "avatar",
        kind: "image",
      };
}
