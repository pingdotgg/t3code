import { Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { advanceWorkspaceVisit, workspaceRevisionOf } from "../hooks/useWorkspaceRevision";
import { revisionedQuery } from "./revisionedQuery";

// A stand-in query that counts its fetches.
function setup(readQuery: (cache: Atom.Atom<number>) => Atom.Atom<number> = (cache) => cache) {
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
  const query = readQuery(
    Atom.make(() => {
      fetches += 1;
      return fetches;
    }).pipe(Atom.keepAlive),
  );
  const mount = async (revision: string | null | undefined, startedUnder?: string) => {
    const release = registry.mount(revisionedQuery(query, revision, startedUnder));
    // A stale read refetches in a microtask, after the render that read it.
    await Promise.resolve();
    return () => {
      release();
      for (const task of scheduled.splice(0)) task();
    };
  };
  return { registry, query, mount, fetches: () => fetches };
}

describe("revisionedQuery", () => {
  it("refetches once per new revision, not on the first read or a remount", async () => {
    const { mount, fetches } = setup();

    (await mount("mutation-1"))();
    expect(fetches()).toBe(1);

    (await mount("mutation-1"))();
    expect(fetches()).toBe(1);

    (await mount("mutation-2"))();
    expect(fetches()).toBe(2);
  });

  it("does not ping-pong while readers of the old and new revision overlap", async () => {
    const { mount, fetches } = setup();

    const releaseOld = await mount("mutation-1");
    const releaseNew = await mount("mutation-2");
    expect(fetches()).toBe(2);
    releaseOld();
    releaseNew();
  });

  it("refetches when an earlier revision is read again", async () => {
    const { mount, fetches } = setup();

    (await mount("mutation-1"))();
    (await mount("mutation-2"))();
    (await mount("mutation-1"))();
    expect(fetches()).toBe(3);
  });

  it("refetches a query another reader already cached on its first revisioned read", async () => {
    const { mount, fetches } = setup();

    (await mount(undefined))();
    expect(fetches()).toBe(1);

    (await mount("mutation-1"))();
    expect(fetches()).toBe(2);

    (await mount("mutation-1"))();
    expect(fetches()).toBe(2);
  });

  it("counts a query as cached while the atom it reads through keeps the value", async () => {
    // Like an environment query: its own node goes with its last reader, the cache stays.
    const { mount, fetches } = setup((cache) =>
      Atom.transform(cache, (get) => get(cache), { initialValueTarget: cache }),
    );

    (await mount(undefined))();
    (await mount("mutation-1"))();
    expect(fetches()).toBe(2);
  });

  it("does not refetch a cached query on a first read before any workspace change", async () => {
    const { mount, fetches } = setup();

    (await mount(undefined))();
    (await mount(null))();
    expect(fetches()).toBe(1);
  });

  it("leaves the query alone when read without a revision", async () => {
    const { mount, query, fetches } = setup();

    (await mount("mutation-1"))();
    expect(revisionedQuery(query, undefined)).toBe(query);
    (await mount(undefined))();
    (await mount("mutation-1"))();
    expect(fetches()).toBe(1);
  });

  it("refetches the query when the reader is refreshed", async () => {
    const { registry, query, mount, fetches } = setup();

    const release = await mount("mutation-1");
    registry.refresh(revisionedQuery(query, "mutation-1"));
    expect(fetches()).toBe(2);
    release();
  });

  it("drops a pending refetch when the registry is disposed before it runs", async () => {
    const { registry, query, mount } = setup();

    (await mount("mutation-1"))();
    const release = registry.mount(revisionedQuery(query, "mutation-2"));
    release();
    registry.dispose();

    // A refetch that ran now would throw "registry is disposed" as an uncaught error.
    await Promise.resolve();
  });

  it("records a fetch started without a revision under the one it names", async () => {
    const fresh = setup();
    (await fresh.mount(undefined, "visit-b"))();
    (await fresh.mount("visit-b"))();
    expect(fresh.fetches()).toBe(1);

    // Cached before that read: the revision still refetches it.
    const cached = setup();
    (await cached.mount("thread-a-1"))();
    (await cached.mount(undefined, "visit-b"))();
    expect(cached.fetches()).toBe(1);
    (await cached.mount("visit-b"))();
    expect(cached.fetches()).toBe(2);
  });

  it("does not refetch for either of two readers when a thread's history loads", async () => {
    const { mount, fetches } = setup();
    let visit = advanceWorkspaceVisit(
      null,
      { threadKey: "thread-b", unloaded: true, mutationId: null },
      "view",
    );
    // The Changes totals and the Diff panel read one query, each under its own format, and
    // stay mounted through the load as a rendered component does.
    let release = () => {};
    const render = async (unloaded: boolean, mutationId: string | null) => {
      visit = advanceWorkspaceVisit(visit, { threadKey: "thread-b", unloaded, mutationId }, "view");
      const { revision } = workspaceRevisionOf(visit, mutationId);
      const releaseTotals = await mount(JSON.stringify([revision, "status"]));
      const releaseDiff = await mount(revision);
      release();
      release = () => {
        releaseTotals();
        releaseDiff();
      };
    };

    await render(true, null);
    const opened = fetches();
    await render(false, "thread-b-1");
    expect(fetches()).toBe(opened);

    await render(false, "thread-b-2");
    expect(fetches()).toBeGreaterThan(opened);
    release();
  });

  it("does not restart the fetch of a query whose cache is gone", async () => {
    let fetches = 0;
    const scheduled: Array<() => void> = [];
    const registry = AtomRegistry.make({
      scheduleTask: (task) => {
        scheduled.push(task);
        return () => {};
      },
    });
    const query = Atom.make(() => (fetches += 1));
    const read = async (revision: string) => {
      const release = registry.mount(revisionedQuery(query, revision));
      await Promise.resolve();
      release();
      for (const task of scheduled.splice(0)) task();
    };

    await read("mutation-1");
    await read("mutation-2");
    expect(fetches).toBe(2);
  });
});
