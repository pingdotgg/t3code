import { makeProviderSettingsSchema, SourceControlProviderKind } from "@t3tools/contracts";
import {
  changeRequestUrlBelow,
  defineSourceControlClient,
  hostCredentialSettingsFields,
  isChangeRequestInProjectRepository,
  isChangeRequestOnProjectHost,
  parseChangeRequestPath,
  projectChangeRequestHost,
  remoteWebOrigin,
} from "@t3tools/source-control-core/client/definition";

import { gitHubMediaUrl } from "./gitHubMedia.ts";
import { icon } from "./icon.ts";
import { gitHubReferenceAutolinks } from "./referenceAutolinks.ts";

const CHECKOUT_COMMAND = /^gh\s+pr\s+checkout\s+(.+)$/i;
const CHANGE_REQUEST_REFERENCE =
  /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/(\d+)(?:[/?#].*)?$/i;

// GitHub Enterprise Server runs on any hostname, so the `<owner>/<repo>/pull/<n>` route alone
// identifies a GitHub pull request.
const CHANGE_REQUEST_PATH = /^\/([^/]+\/[^/]+)\/pull\/(\d+)(?:\/|$)/u;
const ISSUE_PATH = /^\/([^/]+\/[^/]+)\/issues\/(\d+)(?:\/|$)/u;

const KIND = SourceControlProviderKind.make("github");

function isGitHubHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === "github.com" || host.endsWith(".github.com") || host.split(".").includes("github")
  );
}

function isRepositoryPath(repository: string): boolean {
  const segments = repository.split("/");
  return (
    segments.length === 2 &&
    // GitHub owner and repository names are only these characters, so nothing here can
    // be an encoded dot segment, query or fragment that `new URL` would reinterpret.
    segments.every((segment) => /^[\w.-]+$/u.test(segment) && segment !== "." && segment !== "..")
  );
}

export const settings = makeProviderSettingsSchema(hostCredentialSettingsFields);
export type GitHubSettings = typeof settings.Type;

export const definition = defineSourceControlClient({
  kind: KIND,
  label: "GitHub",
  pickerLabel: "GitHub",
  icon,
  searchKeywords: ["ghes", "enterprise"],
  credentials: {
    cliName: "gh",
    cliLabel: "GitHub CLI",
    loginCommand: "gh auth login",
    tokenEnvVar: "GH_TOKEN",
    tokenAccess: "read and write access to pull requests and contents",
    newTokenUrl: (host) => `https://${host}/settings/personal-access-tokens/new`,
  },
  changeRequest: { shortLabel: "PR", singular: "pull request" },
  repositoryPathHint: "owner/repo",
  publicHost: "github.com",
  publishDescription: "github.com",
  publishHost: () => "github.com",
  newRepositoryOwner: (account) => ({ owner: account }),
  defaultCloneTransport: "https",
  changeRequestUrl: ({ host, repository, number, remoteUrl, webUrl }) => {
    if (!Number.isSafeInteger(number) || number < 1) return null;
    if (webUrl) return changeRequestUrlBelow(webUrl, `pull/${number}`);
    if (!isRepositoryPath(repository)) return null;
    try {
      return new URL(`/${repository}/pull/${number}`, remoteWebOrigin(host, remoteUrl)).toString();
    } catch {
      return null;
    }
  },
  parseChangeRequestUrl: (url) => parseChangeRequestPath(url, CHANGE_REQUEST_PATH),
  // GitHub writes every bare reference through `/issues/`, including pull requests.
  changeRequestUrlFromReferenceAutolink: (url) => {
    const match = isGitHubHost(url.hostname) ? ISSUE_PATH.exec(url.pathname) : null;
    if (match?.[1] === undefined || match[2] === undefined) return null;
    const candidate = new URL(url);
    candidate.pathname = `/${match[1]}/pull/${match[2]}`;
    return candidate.toString();
  },
  changeRequestActions: new Set([
    "merge",
    "ready",
    "draft",
    "close",
    "reopen",
    "delete-branch",
    "update-branch",
    "enable-auto-merge",
    "disable-auto-merge",
    "revert",
    "approve-workflows",
  ] as const),
  checkoutCommand: ({ number }) => `gh pr checkout ${number}`,
  changeRequestCloseCommand: /\bgh\s+(?:pr\s+(?:merge|close)|stack\s+merge)\b/u,
  authorProfileUrl: (login, repositoryUrl) =>
    login.endsWith("[bot]")
      ? null
      : new URL(`/${encodeURIComponent(login)}`, repositoryUrl).toString(),
  referenceAutolinks: gitHubReferenceAutolinks,
  changeRequestChecksUrl: (changeRequestUrl) => `${changeRequestUrl.replace(/\/+$/u, "")}/checks`,
  // Before servers reported their actions, GitHub was the only host they acted on from a list.
  changeRequestActionsWhenUnreported: new Set(["close", "merge", "ready", "reopen"] as const),
  // One search reads every repository on the host.
  changeRequestListScope: "host",
  reviewSummaryRequired: () => false,
  checkoutCommandArgument: (input) => CHECKOUT_COMMAND.exec(input)?.[1]?.trim() ?? null,
  isChangeRequestReference: (url) => CHANGE_REQUEST_REFERENCE.test(url),
  checkoutChangeRequestHost: (identity) => projectChangeRequestHost(identity, KIND),
  changeRequestHeadRef: (number) => `refs/pull/${number}/head`,
  // `*.ghe.com` is GitHub Enterprise Cloud with data residency, one subdomain per enterprise.
  recognizeRemote: ({ host, hostname }) =>
    hostname === "github.com" ||
    hostname.endsWith(".ghe.com") ||
    hostname.split(".").includes("github")
      ? {
          kind: KIND,
          name: hostname === "github.com" ? "GitHub" : "GitHub Self-Hosted",
          baseUrl: `https://${host}`,
        }
      : null,
  isChangeRequestInRepository: (identity, link) =>
    isChangeRequestInProjectRepository(projectChangeRequestHost(identity, KIND), identity, link),
  canReadChangeRequestOnHost: (identity, link) =>
    isChangeRequestOnProjectHost(projectChangeRequestHost(identity, KIND), identity, link),
  mediaUrl: gitHubMediaUrl,
  settings,
});
