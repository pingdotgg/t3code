import { makeProviderSettingsSchema, SourceControlProviderKind } from "@t3tools/contracts";
import {
  buildCommitUrl,
  changeRequestUrlBelow,
  defineSourceControl,
  hostCredentialSettingsFields,
  isChangeRequestInProjectRepository,
  isChangeRequestOnProjectHost,
  parseChangeRequestPath,
  parseCommitPath,
  parseIssuePath,
  projectChangeRequestHost,
  repositoryUrlFromPagePath,
} from "@t3tools/source-control-core/shared/definition";

import { icon } from "./icon.ts";

export const TANSTACK_SOURCE_HOST = "source.tanstack.com";

/** Every web page and clone URL names the owner with a leading `@`, as `/@TanStack/router`. */
const CHANGE_REQUEST_PATH = /^\/(?:@|%40)?([^/@%]+\/[^/]+)\/pull\/(\d+)(?:\/|$)/u;
const ISSUE_PATH = /^\/(?:@|%40)?([^/@%]+\/[^/]+)\/issues\/(\d+)(?:\/|$)/u;
const COMMIT_PATH = /^\/(?:@|%40)?([^/@%]+\/[^/]+)\/commit\/([0-9a-f]+)\/?$/iu;
const REPOSITORY_PAGE_PATH = /^\/(@[^/@]+\/[^/]+)\/(?:tree|blob)\/[^/]/u;
const CHECKOUT_COMMAND = /^src\s+pr\s+checkout\s+(.+)$/iu;

const KIND = SourceControlProviderKind.make("tanstack-source");

const isTanStackSourceHost = (hostname: string) => hostname.toLowerCase() === TANSTACK_SOURCE_HOST;

function parseChangeRequestUrl(url: URL) {
  const link = isTanStackSourceHost(url.hostname)
    ? parseChangeRequestPath(url, CHANGE_REQUEST_PATH)
    : null;
  return link === null
    ? null
    : { ...link, repositoryUrl: `${url.origin}/@${CHANGE_REQUEST_PATH.exec(url.pathname)![1]}` };
}

/** Keys drop the owner's `@`, so a project's repository is `owner/name` as the API names it. */
function repositoryKeyFromRemote(key: string): string | null {
  // Remote parsing spells the `@` percent-encoded.
  const match = /^source\.tanstack\.com\/(?:@|%40)([^/@%]+\/[^/]+)$/u.exec(key);
  return match?.[1] === undefined
    ? null
    : `${TANSTACK_SOURCE_HOST}/${match[1].replace(/\.git$/u, "")}`;
}

export const settings = makeProviderSettingsSchema(hostCredentialSettingsFields);
export type TanStackSourceSettings = typeof settings.Type;

export const definition = defineSourceControl({
  kind: KIND,
  label: "TanStack Source",
  pickerLabel: "TanStack Source",
  icon,
  searchKeywords: ["tanstack", "src"],
  credentials: {
    cliName: "src",
    cliLabel: "TanStack Source CLI",
    loginCommand: "src auth login --web",
    tokenEnvVar: "SRC_TOKEN",
    tokenAccess: "read and write access to repositories, issues and pull requests",
    newTokenUrl: (host) => `https://${host}/settings/tokens`,
  },
  changeRequest: {
    shortLabel: "PR",
    shortLabelWithArticle: "a PR",
    singular: "pull request",
    plural: "pull requests",
  },
  repositoryPathHint: "owner/repo",
  publicHost: TANSTACK_SOURCE_HOST,
  publishDescription: TANSTACK_SOURCE_HOST,
  publishHost: () => TANSTACK_SOURCE_HOST,
  newRepositoryOwner: (account) => ({ owner: account }),
  defaultCloneTransport: "https",
  changeRequestUrl: ({ host, repository, number, webUrl }) =>
    !Number.isSafeInteger(number) || number < 1
      ? null
      : webUrl
        ? changeRequestUrlBelow(webUrl, `pull/${number}`)
        : `https://${host}/@${repository.replace(/^@/u, "")}/pull/${number}`,
  parseChangeRequestUrl,
  commitUrl: (input) =>
    buildCommitUrl(
      input.webUrl
        ? input
        : { ...input, webUrl: `https://${input.host}/@${input.repository.replace(/^@/u, "")}` },
      "commit",
    ),
  parseIssueUrl: (url) =>
    isTanStackSourceHost(url.hostname) ? parseIssuePath(url, ISSUE_PATH) : null,
  parseCommitUrl: (url) =>
    isTanStackSourceHost(url.hostname) ? parseCommitPath(url, COMMIT_PATH) : null,
  repositoryUrlFromPage: (url) =>
    isTanStackSourceHost(url.hostname)
      ? repositoryUrlFromPagePath(url, REPOSITORY_PAGE_PATH)
      : null,
  changeRequestUrlFromReferenceAutolink: () => null,
  changeRequestActions: new Set([
    "merge",
    "ready",
    "draft",
    "close",
    "reopen",
    "update-branch",
    "enable-auto-merge",
    "disable-auto-merge",
    "revert",
  ] as const),
  checkoutCommand: ({ number }) => `src pr checkout ${number}`,
  changeRequestCloseCommand: /\bsrc\s+pr\s+(?:merge|close)\b/u,
  changeRequestCreateCommand: /\bsrc\s+pr\s+(?:create|new)\b/u,
  authorProfileUrl: (login) =>
    login.endsWith("[bot]")
      ? null
      : `https://${TANSTACK_SOURCE_HOST}/@${encodeURIComponent(login)}`,
  reviewSummaryRequired: () => false,
  checkoutCommandArgument: (input) => CHECKOUT_COMMAND.exec(input)?.[1]?.trim() ?? null,
  isChangeRequestReference: (url) => parsePullRequestUrl(url) !== null,
  checkoutChangeRequestHost: () => null,
  changeRequestHeadRef: (number) => `refs/pull/${number}/head`,
  repositoryKeyFromRemote,
  recognizeRemote: ({ hostname }) =>
    isTanStackSourceHost(hostname)
      ? { kind: KIND, name: "TanStack Source", baseUrl: `https://${TANSTACK_SOURCE_HOST}` }
      : null,
  isChangeRequestInRepository: (identity, link) =>
    isChangeRequestInProjectRepository(projectChangeRequestHost(identity, KIND), identity, link),
  canReadChangeRequestOnHost: (identity, link) =>
    isChangeRequestOnProjectHost(projectChangeRequestHost(identity, KIND), identity, link),
  settings,
});

export function parsePullRequestUrl(value: string) {
  try {
    return parseChangeRequestUrl(new URL(value));
  } catch {
    return null;
  }
}
