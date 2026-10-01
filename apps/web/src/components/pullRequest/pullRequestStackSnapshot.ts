import type { PullRequestRef, PullRequestStack, ThreadPullRequestLink } from "@t3tools/contracts";

/** Saved native membership is enough for navigation, but never supplies action head SHAs. */
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
        ...(snapshot ? { title: snapshot.title, isDraft: snapshot.isDraft } : {}),
      };
    }),
  };
}

/** A fresh absence overrides saved membership; failed refreshes preserve available navigation. */
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
  return {
    data,
    isFresh: query.isSuccess && !query.isPending,
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
