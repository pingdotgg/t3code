import { Atom, type AtomRegistry } from "effect/reactivity";

export function createThreadInsightsRefreshAtom(
  revisions: Atom.Atom<ReadonlyMap<string, string | undefined>>,
  refresh: (registry: AtomRegistry.AtomRegistry) => void,
) {
  return Atom.make((get) => {
    let previous = get.once(revisions);
    let timer: ReturnType<typeof setTimeout> | undefined;
    get.subscribe(revisions, (next) => {
      const changed = [...next].some(
        ([key, value]) => previous.has(key) && previous.get(key) !== value,
      );
      previous = next;
      // Keep the first deadline so continuous streaming cannot postpone the refresh forever.
      if (!changed || timer !== undefined) return;
      timer = setTimeout(() => {
        timer = undefined;
        refresh(get.registry);
      }, 1_000);
    });
    get.addFinalizer(() => {
      if (timer !== undefined) clearTimeout(timer);
    });
  });
}
