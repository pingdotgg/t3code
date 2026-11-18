import { Atom } from "effect/reactivity";
import { useState } from "react";
import { appAtomRegistry } from "../../state/atom-registry";

type PullRequestView = { readonly section?: "overview" | "guide" | "diff"; readonly path?: string };
const rememberedView = Atom.family((key: string) =>
  Atom.make<PullRequestView>({}).pipe(Atom.keepAlive, Atom.withLabel(`mobile:pr:view:${key}`)),
);

export function readPullRequestView(key: string) {
  return appAtomRegistry.get(rememberedView(key));
}
export function rememberPullRequestView(key: string, patch: PullRequestView) {
  const atom = rememberedView(key);
  appAtomRegistry.set(atom, { ...appAtomRegistry.get(atom), ...patch });
}

// Scrolling keeps rewriting the remembered path. An open diff that followed it would
// re-target its native scroll destination at every file boundary.
export function useEntryPullRequestPath(key: string) {
  const [entry, setEntry] = useState(() => ({ key, path: readPullRequestView(key).path ?? "" }));
  if (entry.key === key) return entry.path;
  const path = readPullRequestView(key).path ?? "";
  setEntry({ key, path });
  return path;
}
