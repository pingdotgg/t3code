import type { SourceControlMediaUrl } from "@t3tools/source-control-core/shared/definition";

const GUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
// The project segment is optional: an attachment belongs to the organization.
const ATTACHMENT_PATH = new RegExp(`^/[^/]+/(?:[^/]+/)?_apis/wit/attachments/(${GUID})$`, "iu");
const LEGACY_ATTACHMENT_PATH = new RegExp(
  `^/(?:DefaultCollection/)?(?:[^/]+/)?_apis/wit/attachments/(${GUID})$`,
  "iu",
);
const ORGANIZATION = /^[\w-]+$/u;

export interface AzureDevOpsWorkItemAttachment extends SourceControlMediaUrl {
  readonly organizationUrl: string;
  readonly id: string;
}

function fileName(url: URL): string {
  const name = (url.searchParams.get("fileName") ?? "").replace(/[\p{Cc}\\/]/gu, "");
  return name.length > 0 ? name : "azure-devops-attachment";
}

/** A work item attachment on Azure DevOps Services, which serves it only with a credential. */
export function azureDevOpsWorkItemAttachment(url: URL): AzureDevOpsWorkItemAttachment | null {
  if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
  const host = url.hostname.toLowerCase();
  let organizationUrl: string;
  let id: string | undefined;
  if (host === "dev.azure.com") {
    const organization = url.pathname.split("/", 2)[1] ?? "";
    id = ATTACHMENT_PATH.exec(url.pathname)?.[1];
    if (!ORGANIZATION.test(organization)) return null;
    organizationUrl = `https://dev.azure.com/${organization}`;
  } else {
    const organization = /^([\w-]+)\.visualstudio\.com$/u.exec(host)?.[1];
    if (organization === undefined) return null;
    id = LEGACY_ATTACHMENT_PATH.exec(url.pathname)?.[1];
    organizationUrl = `https://${organization}.visualstudio.com`;
  }
  if (id === undefined) return null;
  id = id.toLowerCase();
  const name = fileName(url);
  return {
    organizationUrl,
    id,
    fetchUrl: `${organizationUrl}/_apis/wit/attachments/${id}?fileName=${encodeURIComponent(name)}`,
    fileName: name,
  };
}
