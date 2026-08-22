import type { AtomRegistry } from "effect/unstable/reactivity";

import { environmentThreadShells } from "../../state/threads";

const roots = new WeakMap<
  AtomRegistry.AtomRegistry,
  { owners: number; readonly release: () => void }
>();

export function acquireBackgroundConnectionRoot(registry: AtomRegistry.AtomRegistry): () => void {
  let shared = roots.get(registry);
  if (shared === undefined) {
    shared = {
      owners: 1,
      release: registry.mount(environmentThreadShells.threadShellsAtom),
    };
    roots.set(registry, shared);
  } else {
    shared.owners += 1;
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = roots.get(registry);
    if (current === undefined) return;
    current.owners -= 1;
    if (current.owners > 0) return;
    roots.delete(registry);
    current.release();
  };
}
