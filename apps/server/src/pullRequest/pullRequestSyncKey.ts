import {
  pullRequestHostOf,
  type PullRequestRef,
  type RepositoryIdentity,
  type SourceControlProviderKind,
  type ThreadPullRequestKey,
} from "@t3tools/contracts";
import { sourceControlRepositorySelector } from "@t3tools/shared/sourceControl";
import { normalizeThreadPullRequestKey } from "@t3tools/shared/threadPullRequests";

/** Convert checkout-scoped references to the host-level identity used by linked threads. */
export function pullRequestSyncKey(
  reference: PullRequestRef,
  identity?: RepositoryIdentity | null,
): ThreadPullRequestKey | null {
  if (identity?.provider === "azure-devops" && !reference.repository.includes("/")) {
    if (
      reference.repository.toLowerCase() !==
        sourceControlRepositorySelector(identity)?.toLowerCase() ||
      (reference.host !== undefined &&
        reference.host.toLowerCase() !== pullRequestHostOf(identity, "azure-devops"))
    )
      return null;
    const [host, ...repository] = identity.canonicalKey.split("/");
    if (!host || repository.length === 0) return null;
    return normalizeThreadPullRequestKey({
      host,
      repository: repository.join("/"),
      number: reference.number,
    });
  }
  const host =
    reference.host ??
    (identity
      ? pullRequestHostOf(identity, identity.provider as SourceControlProviderKind)
      : undefined);
  return host === undefined
    ? null
    : normalizeThreadPullRequestKey({
        host,
        repository: reference.repository,
        number: reference.number,
      });
}
