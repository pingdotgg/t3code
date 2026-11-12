import { Atom } from "effect/reactivity";
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
