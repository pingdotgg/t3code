// The changed-files sheet hands its pick to the diff screen beneath it. Picking the file the
// screen already shows still jumps back to it, which a route param that did not change could not
// say. A screen that is not mounted yet opens at its `path` param instead.
type Listener = (path: string) => void;
const listeners = new Map<string, Set<Listener>>();

// The sheet pops to the nearest file diff (`StackActions.popTo`), so only that screen jumps; an
// earlier diff of the same pull request further down the stack keeps its file and selection.
export function requestPullRequestFileJump(
  routes: ReadonlyArray<{ readonly key: string; readonly name: string }>,
  path: string,
): void {
  const target = routes.findLast((route) => route.name === "PullRequestFile");
  if (!target) return;
  for (const listener of listeners.get(target.key) ?? []) listener(path);
}

export function subscribePullRequestFileJump(routeKey: string, listener: Listener): () => void {
  let scoped = listeners.get(routeKey);
  if (!scoped) listeners.set(routeKey, (scoped = new Set()));
  scoped.add(listener);
  return () => {
    scoped.delete(listener);
    if (scoped.size === 0) listeners.delete(routeKey);
  };
}
