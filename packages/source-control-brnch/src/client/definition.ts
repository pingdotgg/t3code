/**
 * Brnch's client definition. Browser- and React Native-safe.
 *
 * @module source-control-brnch/client/definition
 */
import { SourceControlProviderKind } from "@t3tools/contracts";
import {
  defineSourceControlClient,
  isChangeRequestInProjectRepository,
  isChangeRequestOnProjectHost,
} from "@t3tools/source-control-core/client/definition";

const KIND = SourceControlProviderKind.make("brnch");

/** Brnch has no self-hosted installs, so a change URL is only believed from brnch.io. */
const CHANGE_URL = /^https:\/\/brnch\.io\/[^/\s]+\/[^/\s]+\/changes\/(\d+)(?:[/?#].*)?$/iu;

export const definition = defineSourceControlClient({
  kind: KIND,
  label: "Brnch",
  pickerLabel: "Brnch",
  icon: "brnch",
  changeRequest: { shortLabel: "change", singular: "change" },
  repositoryPathHint: "owner/repo",
  publicHost: "brnch.io",
  publishDescription: "brnch.io",
  publishHost: () => "brnch.io",
  newRepositoryOwner: (account) => (account ? { owner: account } : null),
  defaultCloneTransport: "https",
  changeRequestUrl: ({ host, repository, number }) =>
    `https://${host}/${repository}/changes/${number}`,
  // What `brnch change` and `brnch merge` offer; the CLI has no command back to draft.
  changeRequestActions: new Set(["ready", "close", "reopen", "merge"] as const),
  // `brnch` has no checkout command; the server checks a change out with git.
  checkoutCommand: () => null,
  authorProfileUrl: () => null,
  referenceAutolinkRepositoryUrl: () => null,
  reviewSummaryRequired: () => false,
  checkoutCommandArgument: () => null,
  isChangeRequestReference: (url) => CHANGE_URL.test(url),
  changeRequestUrlHost: (url) => url.hostname,
  checkoutChangeRequestHost: () => "brnch.io",
  isChangeRequestInRepository: (identity, link) =>
    isChangeRequestInProjectRepository(KIND, identity, link),
  canReadChangeRequestOnHost: (identity, link) =>
    isChangeRequestOnProjectHost(KIND, identity, link),
  isChangeRequestUrl: (url) => CHANGE_URL.test(url),
});
