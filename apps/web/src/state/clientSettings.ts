import { Atom } from "effect/unstable/reactivity";

export const progressiveThreadHistoryEnabledAtom = Atom.make(false).pipe(
  Atom.keepAlive,
  Atom.withLabel("web-progressive-thread-history-enabled"),
);
