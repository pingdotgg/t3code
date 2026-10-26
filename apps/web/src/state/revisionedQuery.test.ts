import { Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { revisionedQuery } from "./revisionedQuery";

// A stand-in query that counts its fetches.
function setup() {
  let fetches = 0;
  // Node removal runs on the registry's scheduler; releasing flushes it so the
  // next mount of the same revision builds a fresh node, as a React remount does.
  const scheduled: Array<() => void> = [];
  const registry = AtomRegistry.make({
    scheduleTask: (task) => {
      scheduled.push(task);
      return () => {};
    },
  });
  const query = Atom.make(() => {
    fetches += 1;
    return fetches;
  }).pipe(Atom.keepAlive);
  const mount = (revision: string | null | undefined) => {
    const release = registry.mount(revisionedQuery(query, revision));
    return () => {
      release();
      for (const task of scheduled.splice(0)) task();
    };
  };
  return { registry, query, mount, fetches: () => fetches };
}

describe("revisionedQuery", () => {
  it("refetches once per new revision, not on the first read or a remount", () => {
    const { mount, fetches } = setup();

    mount("mutation-1")();
    expect(fetches()).toBe(1);

    mount("mutation-1")();
    expect(fetches()).toBe(1);

    mount("mutation-2")();
    expect(fetches()).toBe(2);
  });

  it("does not ping-pong while readers of the old and new revision overlap", () => {
    const { mount, fetches } = setup();

    const releaseOld = mount("mutation-1");
    const releaseNew = mount("mutation-2");
    expect(fetches()).toBe(2);
    releaseOld();
    releaseNew();
  });

  it("refetches when an earlier revision is read again", () => {
    const { mount, fetches } = setup();

    mount("mutation-1")();
    mount("mutation-2")();
    mount("mutation-1")();
    expect(fetches()).toBe(3);
  });

  it("refetches a query another reader already cached on its first revisioned read", () => {
    const { mount, fetches } = setup();

    mount(undefined)();
    expect(fetches()).toBe(1);

    mount("mutation-1")();
    expect(fetches()).toBe(2);

    mount("mutation-1")();
    expect(fetches()).toBe(2);
  });

  it("does not refetch a cached query on a first read before any workspace change", () => {
    const { mount, fetches } = setup();

    mount(undefined)();
    mount(null)();
    expect(fetches()).toBe(1);
  });

  it("leaves the query alone when read without a revision", () => {
    const { mount, query, fetches } = setup();

    mount("mutation-1")();
    expect(revisionedQuery(query, undefined)).toBe(query);
    mount(undefined)();
    mount("mutation-1")();
    expect(fetches()).toBe(1);
  });

  it("refetches the query when the reader is refreshed", () => {
    const { registry, query, mount, fetches } = setup();

    const release = mount("mutation-1");
    registry.refresh(revisionedQuery(query, "mutation-1"));
    expect(fetches()).toBe(2);
    release();
  });
});
