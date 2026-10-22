import { Atom } from "effect/reactivity";

// Shared across mounted routes so an async confirmation cannot race another composer.
export const rewindingThreadKeysAtom = Atom.make<ReadonlySet<string>>(new Set<string>()).pipe(
  Atom.keepAlive,
);
export const sendingThreadKeysAtom = Atom.make<ReadonlySet<string>>(new Set<string>()).pipe(
  Atom.keepAlive,
);
