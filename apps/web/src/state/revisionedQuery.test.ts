import * as Effect from "effect/Effect";
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
  const mount = async (
    revision: string | null | undefined,
    options?: Parameters<typeof revisionedQuery>[2],
  ) => {
    const release = registry.mount(revisionedQuery(query, revision, options));
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
    (await fresh.mount(undefined, { startedUnder: "visit-b" }))();
    (await fresh.mount("visit-b"))();
    expect(fresh.fetches()).toBe(1);

    // Cached before that read: the revision still refetches it.
    const cached = setup();
    (await cached.mount("thread-a-1"))();
    (await cached.mount(undefined, { startedUnder: "visit-b" }))();
    expect(cached.fetches()).toBe(1);
    (await cached.mount("visit-b"))();
    expect(cached.fetches()).toBe(2);
  });

  it("refetches once for two readers of one query, and not when a thread's history loads", async () => {
    const { mount, fetches } = setup();
    (await mount("thread-a-1", { detail: "status" }))();
    (await mount("thread-a-1"))();
    expect(fetches()).toBe(1);

    let visit = advanceWorkspaceVisit(
      null,
      { threadKey: "thread-b", unloaded: true, mutationId: null },
      "view",
    );
    // The Changes totals, which add status totals of their own, then the Diff panel.
    const render = async (unloaded: boolean, mutationId: string | null) => {
      visit = advanceWorkspaceVisit(visit, { threadKey: "thread-b", unloaded, mutationId }, "view");
      const { revision } = workspaceRevisionOf(visit, mutationId);
      (await mount(revision, { detail: "status" }))();
      (await mount(revision))();
    };

    await render(true, null);
    expect(fetches()).toBe(2);
    await render(false, "thread-b-1");
    expect(fetches()).toBe(2);
    await render(false, "thread-b-2");
    expect(fetches()).toBe(3);
  });

  it("refetches when a reader's own detail changes, whatever the other readers read", async () => {
    const { mount, fetches } = setup();

    (await mount("mutation-1", { detail: "status-1" }))();
    (await mount("mutation-1"))();
    (await mount("mutation-1", { detail: "status-1" }))();
    expect(fetches()).toBe(1);

    (await mount("mutation-1", { detail: "status-2" }))();
    expect(fetches()).toBe(2);
    (await mount("mutation-1"))();
    expect(fetches()).toBe(2);
  });

  it("leaves a fetch that began after the revision changed to finish", async () => {
    let fetches = 0;
    const registry = AtomRegistry.make();
    const query = Atom.make(
      Effect.suspend(() => ((fetches += 1) === 1 ? Effect.succeed(fetches) : Effect.never)),
    ).pipe(Atom.keepAlive);

    registry.mount(revisionedQuery(query, "mutation-1"));
    await Promise.resolve();
    expect(fetches).toBe(1);

    // Another reader's own refresh lands between the read and its deferred refetch.
    registry.mount(revisionedQuery(query, "mutation-2"));
    registry.refresh(query);
    await Promise.resolve();
    expect(fetches).toBe(2);

    // A fetch already in flight when the revision changes started before the change.
    registry.mount(revisionedQuery(query, "mutation-3"));
    await Promise.resolve();
    expect(fetches).toBe(3);
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
