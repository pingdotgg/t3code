import type { PullRequestDiffStat, PullRequestRef } from "@t3tools/contracts";

type StatRef = Pick<PullRequestDiffStat, "host" | "repository" | "number"> & {
  readonly projectId: string;
};

export const pullRequestStatKey = (ref: StatRef) =>
  JSON.stringify([
    ref.projectId,
    ref.host?.toLowerCase() ?? "",
    ref.repository.toLowerCase(),
    ref.number,
  ]);

/** Older servers omit the host; infer it only when the request identifies one host. */
export function resolvePullRequestStats(
  refs: readonly PullRequestRef[],
  stats: readonly PullRequestDiffStat[],
): PullRequestDiffStat[] {
  return stats.flatMap((stat) => {
    const matches = refs.filter(
      (ref) =>
        ref.projectId === stat.projectId &&
        ref.repository.toLowerCase() === stat.repository.toLowerCase() &&
        ref.number === stat.number &&
        (stat.host === undefined ||
          ref.host === undefined ||
          ref.host.toLowerCase() === stat.host.toLowerCase()),
    );
    if (matches.length === 0) return [];
    if (stat.host !== undefined) return [stat];
    const hosts = new Set(matches.map((ref) => ref.host?.toLowerCase()));
    if (hosts.size !== 1) return [];
    const host = hosts.values().next().value;
    return [host === undefined ? stat : { ...stat, host }];
  });
}
