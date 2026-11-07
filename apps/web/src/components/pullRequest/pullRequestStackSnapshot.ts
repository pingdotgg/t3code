import type { PullRequestRef, PullRequestStack, ThreadPullRequestLink } from "@t3tools/contracts";

/** Saved membership supports navigation, never action head SHAs. */
export function savedPullRequestStack(
  links: ReadonlyArray<ThreadPullRequestLink>,
  reference: PullRequestRef,
): PullRequestStack | null {
  const host = reference.host?.toLowerCase();
  if (!host) return null;
  const matching = links.filter(
    (link) =>
      link.host.toLowerCase() === host &&
      link.repository.toLowerCase() === reference.repository.toLowerCase(),
  );
  const exact = matching.filter((link) => link.number === reference.number);
  const candidates =
    exact.length > 0
      ? exact
      : matching.filter((link) =>
          link.stack?.layers.some((layer) => layer.number === reference.number),
        );
  const newest = candidates.toSorted(
    (a, b) =>
      Date.parse(b.snapshot?.syncedAt ?? b.linkedAt) -
      Date.parse(a.snapshot?.syncedAt ?? a.linkedAt),
  )[0];
  const stack = newest?.stack;
  if (!stack || !stack.layers.some((layer) => layer.number === reference.number)) return null;
  return {
    id: stack.id,
    number: stack.number,
    url: stack.url,
    base: stack.base,
    layers: stack.layers.map((layer) => {
      const snapshot = matching
        .filter((link) => link.number === layer.number)
        .toSorted(
          (a, b) =>
            Date.parse(b.snapshot?.syncedAt ?? b.linkedAt) -
            Date.parse(a.snapshot?.syncedAt ?? a.linkedAt),
        )[0]?.snapshot;
      return {
        ...layer,
        ...(snapshot
          ? {
              title: snapshot.title,
              isDraft: snapshot.isDraft,
              inMergeQueue: snapshot.inMergeQueue,
            }
          : {}),
      };
    }),
  };
}

export function pullRequestStackView(
  query: {
    data: PullRequestStack | null;
    isSuccess: boolean;
    isPending: boolean;
    error: string | null;
  },
  saved: PullRequestStack | null,
) {
  const data = query.isSuccess ? query.data : (query.data ?? saved);
  const dataWithQueueStatus =
    data === null ||
    saved === null ||
    !data.layers.some(
      (layer) =>
        layer.inMergeQueue === undefined &&
        saved.layers.some(
          (candidate) => candidate.number === layer.number && candidate.inMergeQueue !== undefined,
        ),
    )
      ? data
      : {
          ...data,
          layers: data.layers.map((layer) => {
            const savedLayer = saved.layers.find((candidate) => candidate.number === layer.number);
            return layer.inMergeQueue !== undefined || savedLayer?.inMergeQueue === undefined
              ? layer
              : { ...layer, inMergeQueue: savedLayer.inMergeQueue };
          }),
        };
  return {
    data: dataWithQueueStatus,
    isFresh: query.isSuccess,
    notice:
      data === null
        ? null
        : query.error
          ? "Stack data may be stale. We couldn’t refresh it."
          : !query.isSuccess || query.isPending
            ? "Refreshing stack… Showing saved data."
            : null,
  };
}
