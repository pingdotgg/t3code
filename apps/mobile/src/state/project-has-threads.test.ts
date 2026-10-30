import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

// The live sources pull in the connection runtime; the factory gets its own.
vi.mock("./threads", () => ({
  environmentThreadShells: { environmentThreadRefsByProjectAtom: () => null },
  olderSettledThreads: { olderSettledAtom: () => null },
}));

import { makeProjectHasThreadsAtom } from "./project-has-threads";

const environmentId = EnvironmentId.make("env-1");
const mine = ProjectId.make("project-mine");
const other = ProjectId.make("project-other");

function setup() {
  const refs = Atom.make<ReadonlyMap<ProjectId, ReadonlyArray<string>>>(new Map());
  const older = Atom.make<{ readonly counts: ReadonlyMap<ProjectId, number> } | null>(null);
  const family = makeProjectHasThreadsAtom({
    threadRefsByProject: () => refs,
    olderSettled: () => older,
  });
  const registry = AtomRegistry.make();
  const onChange = vi.fn();
  const atom = family(environmentId)(mine);
  // Immediate, as useAtomValue reads the value when it subscribes.
  const unsubscribe = registry.subscribe(atom, onChange, { immediate: true });
  onChange.mockClear();
  return { registry, refs, older, atom, onChange, unsubscribe };
}

describe("project has threads", () => {
  it("notifies its reader only when its own project's answer flips", () => {
    const { registry, refs, atom, onChange, unsubscribe } = setup();
    expect(registry.get(atom)).toBe(false);

    // Another project's threads come and go (streaming shells, new threads).
    const broad = vi.fn();
    const unsubscribeBroad = registry.subscribe(refs, broad);
    registry.set(refs, new Map([[other, ["a"]]]));
    registry.set(refs, new Map([[other, ["a", "b"]]]));
    // A thread-list reader sees both changes; this project's reader sees none.
    expect(broad).toHaveBeenCalledTimes(2);
    expect(onChange).not.toHaveBeenCalled();
    unsubscribeBroad();

    registry.set(
      refs,
      new Map([
        [other, ["a", "b"]],
        [mine, ["c"]],
      ]),
    );
    expect(registry.get(atom)).toBe(true);
    expect(onChange).toHaveBeenCalledTimes(1);

    registry.set(
      refs,
      new Map([
        [other, ["a"]],
        [mine, ["c", "d"]],
      ]),
    );
    expect(onChange).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("counts older settled threads the client does not hold", () => {
    const { registry, older, atom, unsubscribe } = setup();
    registry.set(older, { counts: new Map([[mine, 2]]) });
    expect(registry.get(atom)).toBe(true);
    unsubscribe();
  });
});
