import { Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { untilAtomValue } from "./waitForAtomValue";

describe("untilAtomValue", () => {
  it("reports immediately when the current value already qualifies", () => {
    const registry = AtomRegistry.make();
    const atom = Atom.make<number>(10);
    const seen: number[] = [];
    const stop = untilAtomValue({
      registry,
      atom,
      predicate: (value) => value >= 5,
      onArrival: (value) => seen.push(value),
    });
    expect(seen).toEqual([10]);
    stop();
    registry.set(atom, 20);
    expect(seen).toEqual([10]);
  });

  it("reports the first qualifying value and ignores the rest", () => {
    const registry = AtomRegistry.make();
    const atom = Atom.make<number>(1);
    const seen: number[] = [];
    const stop = untilAtomValue({
      registry,
      atom,
      predicate: (value) => value >= 5,
      onArrival: (value) => seen.push(value),
    });
    registry.set(atom, 2);
    registry.set(atom, 5);
    registry.set(atom, 7);
    expect(seen).toEqual([5]);
    stop();
  });

  it("stops reporting once the caller unsubscribes", () => {
    const registry = AtomRegistry.make();
    const atom = Atom.make<number>(1);
    const seen: number[] = [];
    const stop = untilAtomValue({
      registry,
      atom,
      predicate: (value) => value >= 5,
      onArrival: (value) => seen.push(value),
    });
    stop();
    registry.set(atom, 5);
    expect(seen).toEqual([]);
  });
});
