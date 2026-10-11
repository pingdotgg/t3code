/**
 * Azure DevOps's client definition. Browser- and React Native-safe.
 *
 * @module source-control-azure-devops/client/definition
 */
import { SourceControlProviderKind } from "@t3tools/contracts";
import { canonicalRepositoryKey } from "@t3tools/shared/sourceControl";
import {
  defineSourceControlClient,
  isChangeRequestAuthorityOfProject,
  isChangeRequestPath,
} from "@t3tools/source-control-core/client/definition";

const CHECKOUT_COMMAND = /^az\s+repos\s+pr\s+checkout\s+(.+)$/i;
const CHANGE_REQUEST_REFERENCE =
  /^https:\/\/(?:dev\.azure\.com\/[^/\s]+\/[^/\s]+|[^/\s]+\.visualstudio\.com\/[^/\s]+)\/_git\/[^/\s]+\/pullrequest\/(\d+)(?:[/?#].*)?$/i;

/** `az repos pr checkout` names the pull request by `--id`, `-i`, or its first plain argument. */
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
  // A new repository belongs to a project, which the account does not name.
  newRepositoryOwner: () => null,
  defaultCloneTransport: "ssh",
  changeRequestUrl: ({ host, repository, number }) =>
    `https://${canonicalRepositoryKey(`${host}/${repository}`.toLowerCase())}/pullrequest/${number}`,
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
  changeRequestUrlHost: (url) => url.hostname,
  checkoutChangeRequestHost: () => null,
  // The legacy and SSH spellings of one repository all canonicalise to dev.azure.com.
  isChangeRequestInRepository: (identity, link) =>
    isChangeRequestAuthorityOfProject(identity, link) &&
    canonicalRepositoryKey(identity.canonicalKey.toLowerCase()) ===
      canonicalRepositoryKey(`${link.host}/${link.repository}`.toLowerCase()),
  // `az repos` reads use the checkout's organization and project, not host-wide credentials.
  canReadChangeRequestOnHost: () => false,
  isChangeRequestUrl: (url) => isChangeRequestPath(url, "/pullrequest/"),
});
