import { RunId } from "@t3tools/contracts";
import { Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import {
  makeQueuedRunEditStore,
  makeQueuedRunsAtom,
  queuedRunEditBlockedReason,
  resolveQueuedEditExit,
  type QueuedRunStatus,
} from "./queuedRunEdit.ts";

const RUN = RunId.make("run-1");
const queued = (status = "queued"): ReadonlyArray<QueuedRunStatus> => [{ id: RUN, status }];

function setup(initialRuns: ReadonlyArray<QueuedRunStatus> | null = queued()) {
  const registry = AtomRegistry.make();
  const runs = Atom.make<ReadonlyArray<QueuedRunStatus> | null>(initialRuns);
  const store = makeQueuedRunEditStore<{ readonly runId: RunId; readonly text: string }>({
    registry,
    label: "test-queued-run-edits",
  });
  const exits: Array<{ threadKey: string; text: string }> = [];
  const holds: Array<{ runId: RunId; held: boolean }> = [];
  const begin = (runId = RUN) =>
    store.begin(
      "env:thread",
      { runId, text: "draft" },
      {
        runs,
        onRunLeftQueue: (threadKey, edit) => exits.push({ threadKey, text: edit.text }),
        hold: (held) => {
          holds.push({ runId, held });
          return Promise.resolve(true);
        },
      },
    );
  return { registry, runs, store, exits, holds, begin };
}

describe("resolveQueuedEditExit", () => {
  it("closes an unchanged edit without touching drafts", () => {
    expect(resolveQueuedEditExit({ editChanged: false, threadDraftEmpty: true })).toBe("clean");
  });

  it("keeps a changed edit only when the thread draft is empty", () => {
    expect(resolveQueuedEditExit({ editChanged: true, threadDraftEmpty: true })).toBe("kept");
    expect(resolveQueuedEditExit({ editChanged: true, threadDraftEmpty: false })).toBe("discarded");
  });
});

describe("queuedRunEditBlockedReason", () => {
  it("blocks edits only while a question holds the composer", () => {
    expect(queuedRunEditBlockedReason({ openQuestionCount: 0 })).toBeNull();
    expect(queuedRunEditBlockedReason({ openQuestionCount: 1 })).toBe(
      "Answer the question to edit queued messages",
    );
  });
});

describe("makeQueuedRunEditStore", () => {
  it("fires once when the edited run leaves the queue, with the latest edit", async () => {
    const { registry, runs, store, exits, begin } = setup();
    await begin();
    store.update("env:thread", (edit) => ({ ...edit, text: "changed" }));
    registry.set(runs, queued());
    expect(exits).toEqual([]);
    registry.set(runs, queued("running"));
    registry.set(runs, []);
    expect(exits).toEqual([{ threadKey: "env:thread", text: "changed" }]);
  });

  it("waits while the runs are unknown and treats a vanished run as left", async () => {
    const { registry, runs, exits, begin } = setup(null);
    await begin();
    expect(exits).toEqual([]);
    registry.set(runs, []);
    expect(exits).toHaveLength(1);
  });

  it("fires immediately when the run already left the queue", async () => {
    const { exits, begin } = setup(queued("running"));
    await begin();
    expect(exits).toHaveLength(1);
  });

  it("stops watching when the edit ends", async () => {
    const { registry, runs, store, exits, begin } = setup();
    await begin();
    store.end("env:thread");
    registry.set(runs, []);
    expect(exits).toEqual([]);
    expect(store.get("env:thread")).toBeNull();
  });

  it("holds the run while editing and releases it on cancel or when another run is edited", async () => {
    const OTHER = RunId.make("run-2");
    const { store, holds, begin } = setup([...queued(), { id: OTHER, status: "queued" }]);
    await begin();
    await begin();
    await begin(OTHER);
    store.end("env:thread");
    expect(holds).toEqual([
      { runId: RUN, held: true },
      { runId: RUN, held: false },
      { runId: OTHER, held: true },
      { runId: OTHER, held: false },
    ]);
  });

  it("opens the edit only once the server answers its hold", async () => {
    const { store } = setup();
    const replies: Array<(held: boolean) => void> = [];
    const released: Array<boolean> = [];
    const begin = () =>
      store.begin(
        "env:thread",
        { runId: RUN, text: "draft" },
        {
          runs: Atom.make(queued()),
          onRunLeftQueue: () => {},
          hold: (held) => {
            if (!held) {
              released.push(held);
              return Promise.resolve(true);
            }
            return new Promise((resolve) => replies.push(resolve));
          },
        },
      );

    // Cancelled before the server answered: the late hold is released.
    const cancelled = begin();
    store.end("env:thread");
    replies[0]!(true);
    expect(await cancelled).toBe("superseded");
    expect(store.get("env:thread")).toBeNull();
    expect(released).toEqual([false]);

    const accepted = begin();
    expect(store.get("env:thread")).toBeNull();
    replies[1]!(true);
    expect(await accepted).toBe("opened");
    expect(store.get("env:thread")).toEqual({ runId: RUN, text: "draft" });
    store.end("env:thread");

    // An older server has no hold command: the edit still opens, as it did before holds.
    const unsupported = begin();
    replies[2]!(false);
    expect(await unsupported).toBe("opened");
    expect(store.get("env:thread")).toEqual({ runId: RUN, text: "draft" });
  });

  it("holds the exit during a save and replays it when the save fails", async () => {
    const { registry, runs, store, exits, begin } = setup();
    await begin();
    const finishSave = store.startSave("env:thread");
    registry.set(runs, []);
    expect(exits).toEqual([]);
    expect(finishSave?.(false)).toBe(false);
    expect(exits).toHaveLength(1);
  });

  it("reports the edit still open when a save fails while its run is queued", async () => {
    const { store, exits, begin } = setup();
    await begin();
    const finishSave = store.startSave("env:thread");
    expect(finishSave?.(false)).toBe(true);
    expect(exits).toEqual([]);
    expect(store.get("env:thread")).toEqual({ runId: RUN, text: "draft" });
  });

  it("allows one save at a time and ends the edit when it succeeds", async () => {
    const { registry, store, holds, begin } = setup();
    await begin();
    const finishSave = store.startSave("env:thread");
    expect(registry.get(store.savingAtom)).toEqual({ "env:thread": true });
    expect(store.startSave("env:thread")).toBeNull();
    expect(finishSave?.(true)).toBe(true);
    expect(store.get("env:thread")).toBeNull();
    expect(registry.get(store.savingAtom)).toEqual({});
    // The save itself releases the hold on the server.
    expect(holds).toEqual([{ runId: RUN, held: true }]);
  });

  it("leaves an edit begun again during a save to that edit", async () => {
    const { registry, runs, store, exits, begin } = setup();
    await begin();
    const finishStale = store.startSave("env:thread");
    await begin();
    store.update("env:thread", (edit) => ({ ...edit, text: "newer" }));

    expect(finishStale?.(true)).toBe(false);
    expect(finishStale?.(false)).toBe(false);
    expect(store.get("env:thread")).toEqual({ runId: RUN, text: "newer" });
    registry.set(runs, []);
    expect(exits).toEqual([{ threadKey: "env:thread", text: "newer" }]);
  });

  // The server orders saves by arrival, not by edit age, so a second save could
  // land before the first and then be overwritten by it.
  it("keeps the save claimed until it settles, even when the edit is begun again or ended", async () => {
    const { registry, store, begin } = setup();
    await begin();
    const finishStale = store.startSave("env:thread");
    await begin();
    expect(registry.get(store.savingAtom)).toEqual({ "env:thread": true });
    expect(store.startSave("env:thread")).toBeNull();
    store.end("env:thread");
    await begin();
    expect(store.startSave("env:thread")).toBeNull();

    expect(finishStale?.(true)).toBe(false);
    expect(registry.get(store.savingAtom)).toEqual({});
    expect(finishStale?.(false)).toBe(false);
    const finishNewer = store.startSave("env:thread");
    expect(finishNewer?.(true)).toBe(true);
    expect(store.get("env:thread")).toBeNull();
  });

  it("does not revive a cancelled edit when its save fails", async () => {
    const { registry, runs, store, exits, begin } = setup();
    await begin();
    const finishSave = store.startSave("env:thread");
    store.end("env:thread");
    expect(finishSave?.(false)).toBe(false);
    registry.set(runs, []);
    expect(exits).toEqual([]);
    expect(registry.get(store.savingAtom)).toEqual({});
  });

  // The runs read the thread's detail, a live server subscription; a thread
  // with no edit open must not keep it.
  it("holds the thread's runs only while an edit is open and watching", async () => {
    // The registry removes idle nodes in a scheduled task; the test runs those tasks itself.
    const tasks: Array<() => void> = [];
    const registry = AtomRegistry.make({
      scheduleTask: (task) => {
        tasks.push(task);
        return () => {};
      },
    });
    const settle = () => {
      for (const task of tasks.splice(0)) task();
    };
    const source = Atom.make<ReadonlyArray<QueuedRunStatus> | null>(queued());
    let mounted = 0;
    const runs = Atom.make((get) => {
      mounted += 1;
      get.addFinalizer(() => {
        mounted -= 1;
      });
      return get(source);
    });
    const store = makeQueuedRunEditStore<{ readonly runId: RunId }>({
      registry,
      label: "test-queued-run-edits",
    });
    const begin = () =>
      store.begin(
        "env:thread",
        { runId: RUN },
        { runs, onRunLeftQueue: () => {}, hold: () => Promise.resolve(true) },
      );

    await begin();
    expect(mounted).toBe(1);
    store.end("env:thread");
    settle();
    expect(mounted).toBe(0);

    await begin();
    const finishSave = store.startSave("env:thread");
    settle();
    expect(mounted).toBe(0);
    finishSave?.(false);
    expect(mounted).toBe(1);

    registry.set(source, []);
    expect(store.get("env:thread")).toBeNull();
    settle();
    expect(mounted).toBe(0);
  });
});

describe("makeQueuedRunsAtom", () => {
  const thread = (overrides: { archivedAt?: string | null; deletedAt?: string | null } = {}) => ({
    id: "thread-1",
    archivedAt: null,
    deletedAt: null,
    ...overrides,
  });

  async function setupWatched() {
    const registry = AtomRegistry.make();
    const snapshot = Atom.make<{ threads: ReadonlyArray<ReturnType<typeof thread>> } | null>({
      threads: [thread()],
    });
    let detailReads = 0;
    const detailStatus = Atom.make("live");
    const detail = Atom.make<ReadonlyArray<QueuedRunStatus> | null>(queued());
    const runs = makeQueuedRunsAtom({
      threadId: "thread-1",
      snapshot,
      detailStatus,
      runs: Atom.make((get) => {
        detailReads += 1;
        return get(detail);
      }),
    });
    const store = makeQueuedRunEditStore<{ readonly runId: RunId }>({
      registry,
      label: "test-queued-run-edits",
    });
    const exits: Array<string> = [];
    await store.begin(
      "env:thread",
      { runId: RUN },
      { runs, onRunLeftQueue: (key) => exits.push(key), hold: () => Promise.resolve(true) },
    );
    return {
      registry,
      snapshot,
      detailStatus,
      detail,
      store,
      exits,
      detailReads: () => detailReads,
    };
  }

  it("ends the edit when the shell marks the thread deleted, without reading its detail again", async () => {
    const { registry, snapshot, detail, exits, detailReads } = await setupWatched();
    expect(exits).toEqual([]);
    registry.set(snapshot, { threads: [thread({ deletedAt: "2026-10-24T00:00:00Z" })] });
    expect(exits).toEqual(["env:thread"]);
    const reads = detailReads();
    registry.set(detail, []);
    expect(detailReads()).toBe(reads);
  });

  it("ends the edit when the detail reports the thread gone", async () => {
    const { registry, snapshot, detailStatus, exits } = await setupWatched();
    registry.set(snapshot, { threads: [] });
    expect(exits).toEqual([]);
    registry.set(detailStatus, "deleted");
    expect(exits).toEqual(["env:thread"]);
  });

  it("keeps an archived thread's edit open, ending it only when the run leaves the queue", async () => {
    const { registry, snapshot, detail, store, exits } = await setupWatched();
    // The shell drops archived threads, but their queue stays editable.
    registry.set(snapshot, { threads: [] });
    registry.set(snapshot, { threads: [thread({ archivedAt: "2026-10-24T00:00:00Z" })] });
    expect(exits).toEqual([]);
    expect(store.get("env:thread")).not.toBeNull();
    registry.set(detail, queued("running"));
    expect(exits).toEqual(["env:thread"]);
  });

  it("waits while the thread detail is unknown", async () => {
    const { registry, snapshot, detail, exits } = await setupWatched();
    registry.set(snapshot, null);
    registry.set(detail, null);
    expect(exits).toEqual([]);
    registry.set(detail, []);
    expect(exits).toEqual(["env:thread"]);
  });
});
