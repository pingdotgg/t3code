/**
 * Forgejo's client definition, which covers Gitea as well. Browser- and React Native-safe.
 *
 * @module source-control-forgejo/client/definition
 */
import { SourceControlProviderKind } from "@t3tools/contracts";
import {
  type ChangeRequestProjectIdentity,
  defineSourceControlClient,
  isChangeRequestAuthorityOfProject,
  isChangeRequestInProjectRepository,
  isChangeRequestOnProjectHost,
  isChangeRequestPath,
} from "@t3tools/source-control-core/client/definition";

const CHECKOUT_COMMAND = /^tea\s+(?:pr|pulls)\s+checkout\s+(.+)$/i;
const CHANGE_REQUEST_REFERENCE =
  /^https?:\/\/[^/\s]+\/(?:[^/\s]+\/)+[^/\s]+\/pulls\/(\d+)(?:[/?#].*)?$/i;

const KIND = SourceControlProviderKind.make("forgejo");

/**
 * The repository's browser URL the server resolved from the signed-in account, which is the
 * only place a Forgejo mounted below a path says so.
 */
function resolvedWebUrl(identity: ChangeRequestProjectIdentity): URL | null {
  if (!identity.webUrl) return null;
  try {
    const url = new URL(identity.webUrl);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

export const definition = defineSourceControlClient({
  kind: KIND,
  label: "Forgejo",
  pickerLabel: "Forgejo / Gitea",
  icon: "forgejo",
  changeRequest: { shortLabel: "PR", singular: "pull request" },
  repositoryPathHint: "owner/repo",
  // Forgejo and Gitea are self-hosted, so no hostname names them.
  publicHost: null,
  publishDescription: "Your signed-in server",
  publishHost: (signedInHost) => signedInHost ?? "your server",
  newRepositoryOwner: (account) => (account ? { owner: account } : null),
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
  changeRequestActions: new Set(["merge", "close", "reopen", "update-branch"] as const),
  // Neither `fj` nor `tea` checks out by number, so fetch the pull ref from the repository itself.
  checkoutCommand: ({ number, repositoryUrl }) =>
    repositoryUrl
      ? `git fetch '${repositoryUrl.replaceAll("'", "'\\''")}' refs/pull/${number}/head && git checkout -B pulls/${number} FETCH_HEAD`
      : null,
  authorProfileUrl: () => null,
  // Forgejo refuses a change request review without a summary, even with inline comments.
  referenceAutolinkRepositoryUrl: () => null,
  reviewSummaryRequired: (verdict) => verdict === "request-changes",
  checkoutCommandArgument: (input) => CHECKOUT_COMMAND.exec(input)?.[1]?.trim() ?? null,
  isChangeRequestReference: (url) => CHANGE_REQUEST_REFERENCE.test(url),
  // Forgejo servers are addressed with their port, so two on one hostname stay apart.
  changeRequestUrlHost: (url) => url.host,
  checkoutChangeRequestHost: () => null,
  isChangeRequestInRepository: (identity, link) => {
    if (!isChangeRequestAuthorityOfProject(identity, link)) return false;
    const web = resolvedWebUrl(identity);
    if (!web) return isChangeRequestInProjectRepository(KIND, identity, link);
    return (
      web.host.toLowerCase() === (link.authority ?? link.host).toLowerCase() &&
      web.pathname.replace(/^\/+|\/+$/g, "").toLowerCase() === link.repository.toLowerCase()
    );
  },
  // A server mounted below a path serves only repositories under that mount.
  canReadChangeRequestOnHost: (identity, link) => {
    const web = resolvedWebUrl(identity);
    if (!web) return isChangeRequestOnProjectHost(KIND, identity, link);
    const mount = web.pathname
      .replace(/^\/+|\/+$/g, "")
      .split("/")
      .slice(0, -2)
      .join("/");
    return (
      web.host.toLowerCase() === (link.authority ?? link.host).toLowerCase() &&
      (!mount || link.repository.toLowerCase().startsWith(`${mount.toLowerCase()}/`))
    );
  },
  isChangeRequestUrl: (url) => isChangeRequestPath(url, "/pulls/"),
});
