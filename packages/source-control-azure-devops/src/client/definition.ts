import { SourceControlProviderKind } from "@t3tools/contracts";
import { canonicalRepositoryKey } from "@t3tools/shared/sourceControl";
import {
  changeRequestUrlBelow,
  defineSourceControlClient,
  isChangeRequestAuthorityOfProject,
  parseChangeRequestPath,
  remoteWebOrigin,
} from "@t3tools/source-control-core/client/definition";

// Azure DevOps Server runs on any hostname; its `_git` route identifies it.
const CHANGE_REQUEST_PATH = /^\/((?:[^/]+\/)*_git\/[^/]+)\/pullrequest\/(\d+)(?:\/|$)/u;
const CHECKOUT_COMMAND = /^az\s+repos\s+pr\s+checkout\s+(.+)$/i;
const CHANGE_REQUEST_REFERENCE =
  /^https:\/\/(?:dev\.azure\.com\/[^/\s]+\/[^/\s]+|[^/\s]+\.visualstudio\.com\/[^/\s]+)\/_git\/[^/\s]+\/pullrequest\/(\d+)(?:[/?#].*)?$/i;

function checkoutCommandId(args: string): string | null {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  for (const [index, part] of parts.entries()) {
    if (part === "--id" || part === "-i") return parts[index + 1] ?? null;
    if (part.startsWith("--id=")) return part.slice("--id=".length) || null;
  }
  return parts.find((part) => !part.startsWith("-")) ?? null;
}

export const definition = defineSourceControlClient({
  kind: SourceControlProviderKind.make("azure-devops"),
  label: "Azure DevOps",
  pickerLabel: "Azure DevOps",
  icon: "azure-devops",
  changeRequest: { shortLabel: "PR", singular: "pull request" },
  repositoryPathHint: "project/repository",
  // `az repos` reads need the checkout's organization and project, so a bare hostname names no
  // repository this client can act on.
  publicHost: null,
  publishDescription: "dev.azure.com",
  publishHost: () => "dev.azure.com",
  newRepositoryOwner: () => null,
  defaultCloneTransport: "ssh",
  changeRequestUrl: ({ host, repository, number, remoteUrl, webUrl }) => {
    if (webUrl) return changeRequestUrlBelow(webUrl, `pullrequest/${number}`);
    const [canonicalHost = host, ...path] = canonicalRepositoryKey(
      `${host}/${repository}`.toLowerCase(),
    ).split("/");
    return `${remoteWebOrigin(canonicalHost, remoteUrl)}/${path.join("/")}/pullrequest/${number}`;
  },
  // Servers on different ports are different servers, so a port stays in the link.
  parseChangeRequestUrl: (url) => {
    const link = parseChangeRequestPath(url, CHANGE_REQUEST_PATH);
    return link === null || url.port === "" ? link : { ...link, authority: url.host.toLowerCase() };
  },
  changeRequestUrlFromReferenceAutolink: () => null,
  changeRequestActions: new Set([
    "merge",
    "ready",
    "draft",
    "close",
    "reopen",
    "enable-auto-merge",
    "disable-auto-merge",
  ] as const),
  checkoutCommand: ({ number }) => `az repos pr checkout --id ${number}`,
  authorProfileUrl: () => null,
  referenceAutolinkRepositoryUrl: () => null,
  reviewSummaryRequired: () => false,
  checkoutCommandArgument: (input) => {
    const args = CHECKOUT_COMMAND.exec(input)?.[1];
    return args ? checkoutCommandId(args) : null;
  },
  isChangeRequestReference: (url) => CHANGE_REQUEST_REFERENCE.test(url),
  checkoutChangeRequestHost: () => null,
  isChangeRequestInRepository: (identity, link) =>
    isChangeRequestAuthorityOfProject(identity, link) &&
    canonicalRepositoryKey(identity.canonicalKey.toLowerCase()) ===
      canonicalRepositoryKey(`${link.host}/${link.repository}`.toLowerCase()),
  canReadChangeRequestOnHost: () => false,
});
