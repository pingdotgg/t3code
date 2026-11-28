import type { SourceControlMediaUrl } from "@t3tools/source-control-core/shared/definition";

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const ORGANIZATION = /^[a-z0-9][a-z0-9-]*$/iu;
const LEGACY_HOST_SUFFIX = ".visualstudio.com";

/** An Azure DevOps Services identity's picture, which Azure serves only to a signed-in request. */
export interface AzureDevOpsAvatar {
  readonly organization: string;
  readonly id: string;
}

/**
 * Reads both spellings Azure hands out: the web route `_api/_common/identityImage?id=` that REST
 * identities carry, and the `GraphProfile/MemberAvatars` REST route `az` can fetch.
 */
export function parseAzureDevOpsAvatar(url: URL): AzureDevOpsAvatar | null {
  if (url.protocol !== "https:" || url.port !== "" || url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  const segments = url.pathname.split("/").slice(1);
  const organization =
    host === "dev.azure.com"
      ? segments.shift()
      : host.endsWith(LEGACY_HOST_SUFFIX)
        ? host.slice(0, -LEGACY_HOST_SUFFIX.length)
        : undefined;
  if (organization === undefined || !ORGANIZATION.test(organization)) return null;
  const route = segments.map((segment) => segment.toLowerCase());
  const id =
    route.length === 3 && route.join("/") === "_api/_common/identityimage"
      ? url.searchParams.get("id")
      : route.length === 4 && route.slice(0, 3).join("/") === "_apis/graphprofile/memberavatars"
        ? route[3]
        : null;
  return id && GUID.test(id)
    ? { organization: organization.toLowerCase(), id: id.toLowerCase() }
    : null;
}

const azureDevOpsAvatarFetchUrl = (avatar: AzureDevOpsAvatar) =>
  `https://dev.azure.com/${avatar.organization}/_apis/GraphProfile/MemberAvatars/${avatar.id}`;

export function azureDevOpsMediaUrl(url: URL): SourceControlMediaUrl | null {
  const avatar = parseAzureDevOpsAvatar(url);
  return avatar === null
    ? null
    : { fetchUrl: azureDevOpsAvatarFetchUrl(avatar), fileName: `${avatar.id}.png`, kind: "image" };
}

/** An identity's `imageUrl`, in the spelling the server can fetch for clients. */
export function azureDevOpsAvatarUrl(imageUrl: string | null): string | null {
  const url = imageUrl === null ? null : URL.parse(imageUrl);
  const avatar = url === null ? null : parseAzureDevOpsAvatar(url);
  return avatar === null ? imageUrl : azureDevOpsAvatarFetchUrl(avatar);
}
