/**
 * Forgejo's client definition, which covers Gitea as well. Browser- and React Native-safe.
 *
 * @module source-control-forgejo/client/definition
 */
import { SourceControlProviderKind } from "@t3tools/contracts";
import {
  defineSourceControlClient,
  isChangeRequestPath,
} from "@t3tools/source-control-core/client/definition";

export const definition = defineSourceControlClient({
  kind: SourceControlProviderKind.make("forgejo"),
  label: "Forgejo",
  pickerLabel: "Forgejo / Gitea",
  icon: "forgejo",
  changeRequest: { shortLabel: "PR", singular: "pull request" },
  repositoryPathHint: "owner/repo",
  // Forgejo and Gitea are self-hosted, so no hostname names them.
  publicHost: null,
  publishDescription: "Your signed-in server",
  publishHost: (signedInHost) => signedInHost ?? "your server",
  defaultCloneTransport: "https",
  // The server's resolved web URL wins; otherwise an HTTP remote on the same host names the
  // origin, which may carry a port. SSH remotes say nothing about the web origin.
  changeRequestUrl: ({ host, repository, number, remoteUrl, webUrl }) => {
    if (webUrl) return `${webUrl.replace(/\/+$/, "")}/pulls/${number}`;
    try {
      const remote = new URL(remoteUrl ?? "");
      if (
        (remote.protocol === "http:" || remote.protocol === "https:") &&
        (remote.hostname.toLowerCase() === host.toLowerCase() ||
          remote.host.toLowerCase() === host.toLowerCase())
      ) {
        return `${remote.origin}/${repository}/pulls/${number}`;
      }
    } catch {
      // Not an HTTP remote.
    }
    return `https://${host}/${repository}/pulls/${number}`;
  },
  // Neither `fj` nor `tea` checks out by number, so fetch the pull ref from the repository itself.
  checkoutCommand: ({ number, repositoryUrl }) =>
    repositoryUrl
      ? `git fetch '${repositoryUrl.replaceAll("'", "'\\''")}' refs/pull/${number}/head && git checkout -B pulls/${number} FETCH_HEAD`
      : null,
  authorProfileUrl: () => null,
  // Forgejo refuses a change request review without a summary, even with inline comments.
  referenceAutolinkRepositoryUrl: () => null,
  reviewSummaryRequired: (verdict) => verdict === "request-changes",
  isChangeRequestUrl: (url) => isChangeRequestPath(url, "/pulls/"),
});
