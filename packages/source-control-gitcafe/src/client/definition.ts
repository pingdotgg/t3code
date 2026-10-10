/**
 * GitCafe's client definition. Browser- and React Native-safe.
 *
 * @module source-control-gitcafe/client/definition
 */
import { SourceControlProviderKind } from "@t3tools/contracts";
import {
  defineSourceControlClient,
  isChangeRequestPath,
} from "@t3tools/source-control-core/client/definition";

/** GitCafe has no self-hosted installs: production and staging are its only hosts. */
const GITCAFE_HOSTS = new Set(["git.cafe", "staging.git.cafe"]);

export const definition = defineSourceControlClient({
  kind: SourceControlProviderKind.make("gitcafe"),
  label: "GitCafe",
  pickerLabel: "GitCafe",
  icon: "gitcafe",
  changeRequest: { shortLabel: "PR", singular: "pull request" },
  repositoryPathHint: "owner/repo",
  // Left unattributed so a reference with no repository identity behind it gets no checkout
  // command guessed from its hostname alone.
  publicHost: null,
  publishDescription: "git.cafe",
  publishHost: () => "git.cafe",
  defaultCloneTransport: "ssh",
  changeRequestUrl: ({ host, repository, number }) =>
    `https://${host}/${repository}/pulls/${number}`,
  checkoutCommand: ({ number }) => `cafe pr checkout ${number}`,
  authorProfileUrl: () => null,
  referenceAutolinkRepositoryUrl: () => null,
  reviewSummaryRequired: () => false,
  // `/pulls/` is Forgejo's shape too, so only GitCafe's own hosts claim it.
  isChangeRequestUrl: (url) => {
    try {
      return (
        GITCAFE_HOSTS.has(new URL(url).hostname.toLowerCase()) &&
        isChangeRequestPath(url, "/pulls/")
      );
    } catch {
      return false;
    }
  },
});
