import type { ChangeRequestTerminology } from "@t3tools/client-runtime/source-control-clients";
import type { PullRequestRef, PullRequestStack, ThreadPullRequestLink } from "@t3tools/contracts";

export function pullRequestStackMerge(
  stack: PullRequestStack,
  number: number,
  terminology: ChangeRequestTerminology,
) {
  const position = stack.layers.findIndex((layer) => layer.number === number);
  const layers = stack.layers.slice(0, position + 1).filter((layer) => layer.state !== "merged");
  const heads = layers.flatMap((layer) =>
    layer.headSha ? [{ number: layer.number, headSha: layer.headSha }] : [],
  );
  const reason =
    position < 0
      ? `This ${terminology.singular} is no longer in the stack. Refresh it.`
      : stack.layers[position]?.state !== "open" || layers.length === 0
        ? `There are no open layers to merge through this ${terminology.singular}.`
        : layers.some((layer) => layer.state !== "open")
          ? "Reopen the closed layers before merging this stack."
          : layers.some((layer) => layer.isDraft)
            ? "Mark every layer being merged ready for review."
            : heads.length !== layers.length
              ? "Refresh the stack to load its latest revisions before merging."
              : null;
  return { position: position + 1, layers, heads, reason };
}

/** Saved membership supplies navigation while offline, never revisions for a merge. */
export function savedPullRequestStack(
  links: readonly ThreadPullRequestLink[],
  reference: PullRequestRef,
): PullRequestStack | null {
  const matches = links.filter(
    (link) =>
      link.host.toLowerCase() === reference.host?.toLowerCase() &&
      link.repository.toLowerCase() === reference.repository.toLowerCase(),
  );
  const candidates = matches.filter(
    (link) =>
      link.number === reference.number ||
      link.stack?.layers.some((layer) => layer.number === reference.number),
  );
  const newest = [...candidates].sort(
    (a, b) =>
      Date.parse(b.snapshot?.syncedAt ?? b.linkedAt) -
      Date.parse(a.snapshot?.syncedAt ?? a.linkedAt),
  )[0]?.stack;
  if (!newest?.layers.some((layer) => layer.number === reference.number)) return null;
  return {
    ...newest,
    layers: newest.layers.map((layer) => {
      const snapshot = [...matches]
        .filter((link) => link.number === layer.number)
        .sort(
          (a, b) =>
            Date.parse(b.snapshot?.syncedAt ?? b.linkedAt) -
            Date.parse(a.snapshot?.syncedAt ?? a.linkedAt),
        )[0]?.snapshot;
      return {
        number: layer.number,
        headBranch: layer.headBranch,
        state: layer.state,
        ...(snapshot ? { title: snapshot.title, isDraft: snapshot.isDraft } : {}),
      };
    }),
  };
}

/** The list summary describes the layer it was opened from, so another layer's route drops it. */
export function pullRequestLayerParams<Params extends { readonly initialSummary?: unknown }>(
  params: Params,
  number: number,
) {
  const { initialSummary: _, ...layer } = params;
  return { ...layer, number };
}

export function singlePullRequestMergeAllowed(input: {
  readonly supportsStackActions: boolean;
  readonly hasStack: boolean;
  readonly isFresh: boolean;
}) {
  return !input.supportsStackActions || (!input.hasStack && input.isFresh);
}
