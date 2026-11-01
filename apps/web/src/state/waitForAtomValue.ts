import type { Atom, AtomRegistry } from "effect/reactivity";

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

/**
 * Reports the first value satisfying `predicate`, then unsubscribes; an already-satisfying
 * current value reports immediately. Returns the subscription's unsubscribe, a no-op once a
 * value has arrived.
 */
export function untilAtomValue<A>(input: {
  readonly registry: AtomRegistry.AtomRegistry;
  readonly atom: Atom.Atom<A>;
  readonly predicate: (value: A) => boolean;
  readonly onArrival: (value: A) => void;
}): () => void {
  const current = input.registry.get(input.atom);
  if (input.predicate(current)) {
    input.onArrival(current);
    return () => {};
  }
  let settled = false;
  const unsubscribe = input.registry.subscribe(input.atom, (value) => {
    if (settled || !input.predicate(value)) return;
    settled = true;
    unsubscribe();
    input.onArrival(value);
  });
  return unsubscribe;
}
