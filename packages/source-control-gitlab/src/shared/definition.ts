import { SourceControlProviderKind } from "@t3tools/contracts";
import {
  buildCommitUrl,
  changeRequestUrlBelow,
  defineSourceControl,
  isChangeRequestInProjectRepository,
  isChangeRequestOnProjectHost,
  parseChangeRequestPath,
  parseCommitPath,
  projectChangeRequestHost,
  remoteWebOrigin,
} from "@t3tools/source-control-core/shared/definition";
import { icon } from "./icon.ts";
import { gitLabReferenceAutolinks } from "./referenceAutolinks.ts";

const CHECKOUT_COMMAND = /^glab\s+mr\s+checkout\s+(.+)$/i;
const CHANGE_REQUEST_REFERENCE =
  /^https?:\/\/[^/?#\s]+\/[^/?#\s]+(?:\/[^/?#\s]+)+\/-\/merge_requests\/(\d+)(?:[/?#].*)?$/i;

// Self-managed GitLab runs on any hostname and nests projects in groups.
const CHANGE_REQUEST_PATH = /^\/([^/]+(?:\/[^/]+)+)\/-\/merge_requests\/(\d+)(?:\/|$)/u;
const COMMIT_PATH = /^\/([^/]+(?:\/[^/]+)+)\/-\/commit\/([0-9a-f]+)\/?$/iu;

const KIND = SourceControlProviderKind.make("gitlab");

export const definition = defineSourceControl({
  kind: KIND,
  label: "GitLab",
  pickerLabel: "GitLab",
  icon,
  repositoryPathHint: "group/project",
  publicHost: "gitlab.com",
  publishDescription: "gitlab.com",
  publishHost: () => "gitlab.com",
  newRepositoryOwner: (account) => ({ owner: account }),
  defaultCloneTransport: "ssh",
  changeRequestUrl: ({ host, repository, number, remoteUrl, webUrl }) =>
    webUrl
      ? changeRequestUrlBelow(webUrl, `-/merge_requests/${number}`)
      : `${remoteWebOrigin(host, remoteUrl)}/${repository}/-/merge_requests/${number}`,
  parseChangeRequestUrl: (url) => parseChangeRequestPath(url, CHANGE_REQUEST_PATH),
  commitUrl: (input) => buildCommitUrl(input, "-/commit"),
  parseCommitUrl: (url) => parseCommitPath(url, COMMIT_PATH),
  // `!12` already links the merge request itself; `#12` is always an issue.
  changeRequestUrlFromReferenceAutolink: (url) =>
    CHANGE_REQUEST_PATH.test(url.pathname) ? url.toString() : null,
  changeRequestActions: new Set([
    "merge",
    "ready",
    "draft",
    "close",
    "reopen",
    "update-branch",
    "enable-auto-merge",
    "disable-auto-merge",
    "delete-branch",
  ] as const),
  checkoutCommand: ({ number }) => `glab mr checkout ${number}`,
  // `accept` is glab's alias for `merge`.
  changeRequestCloseCommand: /\bglab\s+mr\s+(?:merge|accept|close)\b/u,
  changeRequestCreateCommand: /\bglab\s+mr\s+create\b/u,
  // Bot users, unlike GitHub's, have real profile pages.
  authorProfileUrl: (login, repositoryUrl) =>
    new URL(`/${encodeURIComponent(login)}`, repositoryUrl).toString(),
  referenceAutolinks: gitLabReferenceAutolinks,
  reviewSummaryRequired: () => false,
  checkoutCommandArgument: (input) => CHECKOUT_COMMAND.exec(input)?.[1]?.trim() ?? null,
  isChangeRequestReference: (url) => CHANGE_REQUEST_REFERENCE.test(url),
  checkoutChangeRequestHost: () => null,
  changeRequestHeadRef: (number) => `refs/merge-requests/${number}/head`,
  recognizeRemote: ({ host, hostname }) =>
    hostname === "gitlab.com" || hostname.split(".").includes("gitlab")
      ? {
          kind: KIND,
          name: hostname === "gitlab.com" ? "GitLab" : "GitLab Self-Hosted",
          baseUrl: `https://${host}`,
        }
      : null,
  isChangeRequestInRepository: (identity, link) =>
    isChangeRequestInProjectRepository(projectChangeRequestHost(identity, KIND), identity, link),
  canReadChangeRequestOnHost: (identity, link) =>
    isChangeRequestOnProjectHost(projectChangeRequestHost(identity, KIND), identity, link),
});
