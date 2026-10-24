import type { PullRequestRef, RepositoryIdentity, ThreadPullRequestKey } from "@t3tools/contracts";
import { sourceControlClients } from "../sourceControl/sourceControlClients.ts";
import { normalizeThreadPullRequestKey } from "../sourceControl/threadPullRequests.ts";

export function pullRequestSyncKey(
  reference: PullRequestRef,
  identity?: RepositoryIdentity | null,
): ThreadPullRequestKey | null {
  const host = identity
    ? sourceControlClients.changeRequestHost(identity, identity.provider)
    : undefined;
  // A host whose tools select a repository by something other than its path (Azure DevOps takes
  // the bare name) can only key such a reference through the project's own repository.
  const definition = identity?.provider ? sourceControlClients.find(identity.provider) : undefined;
  if (identity && definition?.repositorySelector && !reference.repository.includes("/")) {
    if (
      reference.repository.toLowerCase() !==
        definition.repositorySelector(identity)?.toLowerCase() ||
      (reference.host !== undefined && reference.host.toLowerCase() !== host)
    )
      return null;
    const [projectHost, ...repository] = identity.canonicalKey.split("/");
    if (!projectHost || repository.length === 0) return null;
    return normalizeThreadPullRequestKey({
      host: projectHost,
      repository: repository.join("/"),
      number: reference.number,
    });
  }
  const resolvedHost = reference.host ?? host;
  return resolvedHost === undefined
    ? null
    : normalizeThreadPullRequestKey({
        host: resolvedHost,
        repository: reference.repository,
        number: reference.number,
      });
}
