import { SourceControlProviderKind } from "@t3tools/contracts";
import {
  changeRequestUrlBelow,
  defineSourceControl,
  isChangeRequestAuthorityOfProject,
  parseChangeRequestPath,
  remoteWebOrigin,
} from "@t3tools/source-control-core/shared/definition";
import { icon } from "./icon.ts";

// Azure DevOps Server runs on any hostname; its `_git` route identifies it.
const CHANGE_REQUEST_PATH = /^\/((?:[^/]+\/)*_git\/[^/]+)\/pullrequest\/(\d+)(?:\/|$)/u;
const CHECKOUT_COMMAND = /^az\s+repos\s+pr\s+checkout\s+(.+)$/i;
const CHANGE_REQUEST_REFERENCE =
  /^https:\/\/(?:dev\.azure\.com\/[^/\s]+\/[^/\s]+|[^/\s]+\.visualstudio\.com\/[^/\s]+)\/_git\/[^/\s]+\/pullrequest\/(\d+)(?:[/?#].*)?$/i;

/**
 * Azure alone addresses one repository under two names that share no part: `ssh.dev.azure.com` and
 * `v3/{org}/{project}/{repo}` over SSH, against `dev.azure.com` and `{org}/{project}/_git/{repo}`
 * everywhere a person sees it. A project cloned over SSH would otherwise be a different repository
 * to every comparison made against a pull request URL, which arrives in the web spelling.
 */
function repositoryKeyFromRemote(key: string): string | null {
  const match =
    /^(ssh\.dev\.azure\.com|vs-ssh\.visualstudio\.com)\/v3\/([^/]+)\/([^/]+)\/([^/]+)$/u.exec(key);
  if (match === null) return null;
  const [, host, organization, project, repository] = match;
  return host === "ssh.dev.azure.com"
    ? `dev.azure.com/${organization}/${project}/_git/${repository}`
    : `${organization}.visualstudio.com/${project}/_git/${repository}`;
}

/** Every spelling of an Azure DevOps Services repository, on `dev.azure.com`. */
function canonicalRepositoryKey(key: string): string | null {
  const canonical = key
    .replace(
      /^(?:ssh\.dev\.azure\.com|vs-ssh\.visualstudio\.com)\/v3\/([^/]+)\/([^/]+)\/([^/]+)$/u,
      "dev.azure.com/$1/$2/_git/$3",
    )
    .replace(
      /^([^.]+)\.visualstudio\.com\/(?:defaultcollection\/)?([^/]+)\/_git\/([^/]+)$/u,
      "dev.azure.com/$1/$2/_git/$3",
    );
  return canonical.startsWith("dev.azure.com/") ? canonical : null;
}

function decodeUrlPathSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function checkoutCommandId(args: string): string | null {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  for (const [index, part] of parts.entries()) {
    if (part === "--id" || part === "-i") return parts[index + 1] ?? null;
    if (part.startsWith("--id=")) return part.slice("--id=".length) || null;
  }
  return parts.find((part) => !part.startsWith("-")) ?? null;
}

const KIND = SourceControlProviderKind.make("azure-devops");

export const definition = defineSourceControl({
  kind: KIND,
  label: "Azure DevOps",
  pickerLabel: "Azure DevOps",
  icon,
  changeRequest: {
    shortLabel: "PR",
    shortLabelWithArticle: "a PR",
    singular: "pull request",
    plural: "pull requests",
  },
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
    const key = `${host}/${repository}`.toLowerCase();
    const [canonicalHost = host, ...path] = (canonicalRepositoryKey(key) ?? key).split("/");
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
  // Completing or abandoning is a status change, the same `update` this package runs.
  changeRequestCloseCommand:
    /\baz\s+repos\s+pr\s+update\b[^;&|]*--status[\s=]+["']?(?:completed|abandoned)\b/u,
  authorProfileUrl: () => null,
  reviewSummaryRequired: () => false,
  checkoutCommandArgument: (input) => {
    const args = CHECKOUT_COMMAND.exec(input)?.[1];
    return args ? checkoutCommandId(args) : null;
  },
  isChangeRequestReference: (url) => CHANGE_REQUEST_REFERENCE.test(url),
  checkoutChangeRequestHost: () => null,
  // `ssh.dev.azure.com` is the default SSH clone host (git@ssh.dev.azure.com:v3/org/project/repo),
  // so any `*.dev.azure.com` subdomain is Azure. Legacy hosts stay under `.visualstudio.com`,
  // including `vs-ssh.visualstudio.com`.
  recognizeRemote: ({ host, hostname }) =>
    hostname === "dev.azure.com" ||
    hostname.endsWith(".dev.azure.com") ||
    hostname.endsWith(".visualstudio.com")
      ? { kind: KIND, name: "Azure DevOps", baseUrl: `https://${host}` }
      : null,
  /**
   * `az repos pr list --repository` takes a name; organisation and project come from checkout.
   * Decode the remote URL's name segment: `az` treats escapes literally and returns 404.
   */
  repositorySelector: (identity) => {
    const segments = (identity.displayName ?? "").split("/").filter((part) => part !== "_git");
    const name = identity.name || segments.at(-1);
    return name ? decodeUrlPathSegment(name) : null;
  },
  repositoryKeyFromRemote,
  canonicalRepositoryKey,
  isChangeRequestInRepository: (identity, link) => {
    if (!isChangeRequestAuthorityOfProject(identity, link)) return false;
    const projectKey = identity.canonicalKey.toLowerCase();
    const linkKey = `${link.host}/${link.repository}`.toLowerCase();
    return (
      (canonicalRepositoryKey(projectKey) ?? projectKey) ===
      (canonicalRepositoryKey(linkKey) ?? linkKey)
    );
  },
  canReadChangeRequestOnHost: () => false,
});
