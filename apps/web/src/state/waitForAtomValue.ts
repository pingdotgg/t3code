import type { Atom, AtomRegistry } from "effect/unstable/reactivity";

export async function waitForAtomValue<A>(input: {
  readonly registry: AtomRegistry.AtomRegistry;
  readonly atom: Atom.Atom<A>;
  readonly predicate: (value: A) => boolean;
  readonly timeoutMs: number;
}): Promise<boolean> {
  const read = () => input.registry.get(input.atom);
  if (input.predicate(read())) {
    return true;
  }

  return await new Promise<boolean>((resolve) => {
    let settled = false;
    let timeoutId: ReturnType<typeof globalThis.setTimeout> | null = null;
    let unsubscribe: (() => void) | null = null;
    let unsubscribeWhenReady = false;

    const finish = (result: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutId !== null) {
        globalThis.clearTimeout(timeoutId);
      }
      if (unsubscribe === null) {
        unsubscribeWhenReady = true;
      } else {
        unsubscribe();
      }
      resolve(result);
    };

    unsubscribe = input.registry.subscribe(input.atom, (value) => {
      if (input.predicate(value)) {
        finish(true);
      }
    });
    if (unsubscribeWhenReady) {
      unsubscribe();
      return;
    }

    // Close the gap between the initial read and subscription registration.
    if (input.predicate(read())) {
      finish(true);
      return;
    }

    timeoutId = globalThis.setTimeout(() => {
      finish(false);
    }, input.timeoutMs);
  });
}
