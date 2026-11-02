import { beforeEach, describe, expect, it } from "vite-plus/test";

import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, ThreadId } from "@t3tools/contracts";

import {
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

  it("keeps a newer drop deliverable after the first navigation fails", () => {
    const store = useSidebarPendingFileDropStore.getState();
    const firstId = store.queuePendingFileDrop(makeEntry("env-1", "thread-1", makeFiles("a.png")));
    const secondId = store.queuePendingFileDrop(makeEntry("env-1", "thread-1", makeFiles("b.png")));

    useSidebarPendingFileDropStore.getState().clearPendingFileDrop(firstId);
    const remaining = useSidebarPendingFileDropStore.getState().pending;
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.id).toBe(secondId);
    expect(fileNames(remaining[0]?.files ?? [])).toEqual(["b.png"]);

    expect(
      fileNames(
        useSidebarPendingFileDropStore
          .getState()
          .consumePendingFileDrop(refOf("env-1", "thread-1")) ?? [],
      ),
    ).toEqual(["b.png"]);
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
