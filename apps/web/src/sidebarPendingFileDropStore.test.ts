import { beforeEach, describe, expect, it } from "vite-plus/test";

import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, ThreadId } from "@t3tools/contracts";

import {
  isSameSidebarThreadRef,
  useSidebarPendingFileDropStore,
  type SidebarPendingFileDrop,
} from "./sidebarPendingFileDropStore";

function makeFiles(...names: string[]): File[] {
  return names.map((name) => new File(["x"], name));
}

function makeEntry(
  environmentId: string,
  threadId: string,
  files: File[],
): Omit<SidebarPendingFileDrop, "id"> {
  return {
    threadRef: scopeThreadRef(environmentId as EnvironmentId, ThreadId.make(threadId)),
    files,
  };
}

function fileNames(files: File[]): string[] {
  return files.map((file) => file.name);
}

function refOf(environmentId: string, threadId: string) {
  return makeEntry(environmentId, threadId, []).threadRef;
}

beforeEach(() => {
  useSidebarPendingFileDropStore.setState({ pending: [] });
});

describe("sidebarPendingFileDropStore", () => {
  it("starts empty", () => {
    expect(useSidebarPendingFileDropStore.getState().pending).toEqual([]);
  });

  it("stashes and consumes a drop for the matching thread", () => {
    const files = makeFiles("a.png", "b.png");
    const store = useSidebarPendingFileDropStore.getState();
    store.queuePendingFileDrop(makeEntry("env-1", "thread-1", files));

    expect(
      useSidebarPendingFileDropStore.getState().consumePendingFileDrop(refOf("env-1", "thread-1")),
    ).toEqual(files);
    expect(useSidebarPendingFileDropStore.getState().pending).toEqual([]);
  });

  it("accumulates repeat drops onto the same thread instead of replacing", () => {
    const store = useSidebarPendingFileDropStore.getState();
    store.queuePendingFileDrop(makeEntry("env-1", "thread-1", makeFiles("a.png")));
    store.queuePendingFileDrop(makeEntry("env-1", "thread-1", makeFiles("b.png")));

    expect(
      fileNames(
        useSidebarPendingFileDropStore
          .getState()
          .consumePendingFileDrop(refOf("env-1", "thread-1")) ?? [],
      ),
    ).toEqual(["a.png", "b.png"]);
    expect(useSidebarPendingFileDropStore.getState().pending).toEqual([]);
  });

  it("keeps drops for other threads when consuming one thread", () => {
    const store = useSidebarPendingFileDropStore.getState();
    store.queuePendingFileDrop(makeEntry("env-1", "thread-1", makeFiles("a.png")));
    store.queuePendingFileDrop(makeEntry("env-1", "thread-2", makeFiles("b.png")));

    expect(
      fileNames(
        useSidebarPendingFileDropStore
          .getState()
          .consumePendingFileDrop(refOf("env-1", "thread-2")) ?? [],
      ),
    ).toEqual(["b.png"]);
    expect(useSidebarPendingFileDropStore.getState().pending).toHaveLength(1);
  });

  it("clears only the drop matching a stale navigation's id", () => {
    const store = useSidebarPendingFileDropStore.getState();
    const firstId = store.queuePendingFileDrop(makeEntry("env-1", "thread-1", makeFiles("a.png")));
    store.queuePendingFileDrop(makeEntry("env-1", "thread-1", makeFiles("b.png")));

    useSidebarPendingFileDropStore.getState().clearPendingFileDrop(firstId);
    expect(
      fileNames(
        useSidebarPendingFileDropStore
          .getState()
          .consumePendingFileDrop(refOf("env-1", "thread-1")) ?? [],
      ),
    ).toEqual(["b.png"]);
  });

  it("keeps a newer drop deliverable after the first navigation fails", () => {
    // Mirrors handleThreadFileDrop: two drops queued for the same unopened
    // thread, then the first navigation fails (or lands elsewhere) and cleans
    // up by its own drop id. The newer drop must survive with its files
    // intact so the thread opening still attaches them.
    const store = useSidebarPendingFileDropStore.getState();
    const firstId = store.queuePendingFileDrop(makeEntry("env-1", "thread-1", makeFiles("a.png")));
    const secondId = store.queuePendingFileDrop(makeEntry("env-1", "thread-1", makeFiles("b.png")));

    // First navigation fails: handler clears only its own drop.
    useSidebarPendingFileDropStore.getState().clearPendingFileDrop(firstId);
    const remaining = useSidebarPendingFileDropStore.getState().pending;
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.id).toBe(secondId);
    expect(fileNames(remaining[0]?.files ?? [])).toEqual(["b.png"]);

    // Thread opens: the surviving drop is still attached.
    expect(
      fileNames(
        useSidebarPendingFileDropStore
          .getState()
          .consumePendingFileDrop(refOf("env-1", "thread-1")) ?? [],
      ),
    ).toEqual(["b.png"]);
    expect(useSidebarPendingFileDropStore.getState().pending).toEqual([]);
  });

  it("clears every drop for a missing thread", () => {
    const store = useSidebarPendingFileDropStore.getState();
    store.queuePendingFileDrop(makeEntry("env-1", "thread-1", makeFiles("a.png")));
    store.queuePendingFileDrop(makeEntry("env-1", "thread-1", makeFiles("b.png")));
    store.queuePendingFileDrop(makeEntry("env-1", "thread-2", makeFiles("c.png")));

    useSidebarPendingFileDropStore
      .getState()
      .clearPendingFileDropsForThread(refOf("env-1", "thread-1"));
    expect(
      fileNames(
        useSidebarPendingFileDropStore
          .getState()
          .consumePendingFileDrop(refOf("env-1", "thread-2")) ?? [],
      ),
    ).toEqual(["c.png"]);
    expect(useSidebarPendingFileDropStore.getState().pending).toEqual([]);
  });

  it("does not confuse refs whose joined keys collide on colons", () => {
    const store = useSidebarPendingFileDropStore.getState();
    store.queuePendingFileDrop(makeEntry("a", "b:c", makeFiles("a.png")));

    expect(
      useSidebarPendingFileDropStore.getState().consumePendingFileDrop(refOf("a:b", "c")),
    ).toBeNull();
    expect(useSidebarPendingFileDropStore.getState().pending).toHaveLength(1);
  });
});

describe("isSameSidebarThreadRef", () => {
  it("compares fields, not joined keys", () => {
    expect(isSameSidebarThreadRef(refOf("a", "b:c"), refOf("a", "b:c"))).toBe(true);
    expect(isSameSidebarThreadRef(refOf("a", "b:c"), refOf("a:b", "c"))).toBe(false);
    expect(isSameSidebarThreadRef(refOf("a", "b"), refOf("a", "c"))).toBe(false);
  });
});
