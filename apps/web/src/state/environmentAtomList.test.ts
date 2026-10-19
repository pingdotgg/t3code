import { EnvironmentId } from "@t3tools/contracts";
import { Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { environmentAtomList, environmentIdsKey } from "./environmentAtomList";

const counts = Atom.family((environmentId: EnvironmentId) => Atom.make(environmentId.length));
const countsList = environmentAtomList("test-counts", counts);

describe("environmentAtomList", () => {
  it("returns the same atom and snapshot for an equal id list", () => {
    const registry = AtomRegistry.make();
    const first = countsList(
      environmentIdsKey([EnvironmentId.make("a"), EnvironmentId.make("bb")]),
    );
    const second = countsList(
      environmentIdsKey([EnvironmentId.make("a"), EnvironmentId.make("bb")]),
    );
    expect(second).toBe(first);
    expect(registry.get(first)).toEqual([1, 2]);
    expect(registry.get(second)).toBe(registry.get(first));
    expect(registry.get(countsList(environmentIdsKey([])))).toEqual([]);
  });
});
