/**
 * Bitbucket's client definition. Browser- and React Native-safe.
 *
 * @module source-control-bitbucket/client/definition
 */
import { SourceControlProviderKind } from "@t3tools/contracts";
import {
  defineSourceControlClient,
  isChangeRequestInProjectRepository,
  isChangeRequestOnProjectHost,
  isChangeRequestPath,
} from "@t3tools/source-control-core/client/definition";

const safeShellArgument = /^[A-Za-z0-9._/@+=,-]+$/;
const repositoryName = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

const KIND = SourceControlProviderKind.make("bitbucket");

export const definition = defineSourceControlClient({
  kind: KIND,
  label: "Bitbucket",
  pickerLabel: "Bitbucket",
  icon: "bitbucket",
  changeRequest: { shortLabel: "PR", singular: "pull request" },
  repositoryPathHint: "workspace/repository",
  publicHost: "bitbucket.org",
  publishDescription: "bitbucket.org",
  publishHost: () => "bitbucket.org",
  // A new repository belongs to a workspace, which the signed-in account does not name.
  newRepositoryOwner: () => null,
  defaultCloneTransport: "ssh",
  changeRequestUrl: ({ host, repository, number }) =>
    `https://${host}/${repository}/pull-requests/${number}`,
  // No endpoint reopens a declined pull request, and nothing documented moves one in or out of
  // draft, so neither is offered rather than failing when pressed.
  changeRequestActions: new Set(["merge", "close"] as const),
  // Bitbucket has no checkout CLI, so clone the head branch from its own repository.
  checkoutCommand: ({ number, headBranch, headRepositoryNameWithOwner }) =>
    headRepositoryNameWithOwner &&
    repositoryName.test(headRepositoryNameWithOwner) &&
    safeShellArgument.test(headBranch)
      ? `git clone --single-branch --branch ${headBranch} https://bitbucket.org/${headRepositoryNameWithOwner}.git t3code-pr-${number}`
      : null,
  authorProfileUrl: () => null,
  referenceAutolinkRepositoryUrl: () => null,
  reviewSummaryRequired: () => false,
  // No checkout CLI, and the reference field never accepted Bitbucket URLs.
  checkoutCommandArgument: () => null,
  isChangeRequestReference: () => false,
  changeRequestUrlHost: (url) => url.hostname,
  checkoutChangeRequestHost: () => null,
  isChangeRequestInRepository: (identity, link) =>
    isChangeRequestInProjectRepository(KIND, identity, link),
  canReadChangeRequestOnHost: (identity, link) =>
    isChangeRequestOnProjectHost(KIND, identity, link),
  isChangeRequestUrl: (url) => isChangeRequestPath(url, "/pull-requests/"),
});
