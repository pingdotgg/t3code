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

/** Only the resolved browser URL carries Forgejo's installation mount. */
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
  // Forgejo and Gitea are self-hosted.
  publicHost: null,
  publishDescription: "Your signed-in server",
  publishHost: (signedInHost) => signedInHost ?? "your server",
  newRepositoryOwner: (account) => (account ? { owner: account } : null),
  defaultCloneTransport: "https",
  // SSH remotes cannot identify the HTTP port; prefer the resolved browser URL.
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
    } catch {}
    return `https://${host}/${repository}/pulls/${number}`;
  },
  changeRequestActions: new Set(["merge", "close", "reopen", "update-branch"] as const),
  // Neither `fj` nor `tea` checks out by number.
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
