import { beforeEach, describe, expect, it } from "vite-plus/test";

import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, ThreadId } from "@t3tools/contracts";

import {
  useSidebarPendingFileDropStore,
  type SidebarPendingFileDrop,
} from "./sidebarPendingFileDropStore";

function makeFiles(count: number): File[] {
  return Array.from({ length: count }, (_, index) => new File(["x"], `f${index}.png`));
}

function makeEntry(environmentId: string, threadId: string, files: File[]): SidebarPendingFileDrop {
  return {
    threadRef: scopeThreadRef(environmentId as EnvironmentId, ThreadId.make(threadId)),
    files,
  };
}

beforeEach(() => {
  useSidebarPendingFileDropStore.setState({ pending: null });
});

describe("sidebarPendingFileDropStore", () => {
  it("starts empty", () => {
    expect(useSidebarPendingFileDropStore.getState().pending).toBeNull();
  });

  it("stashes and consumes a drop for the matching thread", () => {
    const files = makeFiles(2);
    const entry = makeEntry("env-1", "thread-1", files);
    useSidebarPendingFileDropStore.getState().setPendingFileDrop(entry);

    expect(
      useSidebarPendingFileDropStore.getState().consumePendingFileDrop(entry.threadRef),
    ).toEqual(files);
    expect(useSidebarPendingFileDropStore.getState().pending).toBeNull();
  });

  it("refuses to consume for a different thread without clearing the stash", () => {
    const entry = makeEntry("env-1", "thread-1", makeFiles(1));
    useSidebarPendingFileDropStore.getState().setPendingFileDrop(entry);

    const otherThread = makeEntry("env-1", "thread-2", []).threadRef;
    expect(
      useSidebarPendingFileDropStore.getState().consumePendingFileDrop(otherThread),
    ).toBeNull();
    expect(useSidebarPendingFileDropStore.getState().pending).toEqual(entry);

    useSidebarPendingFileDropStore.getState().clearPendingFileDrop();
    expect(useSidebarPendingFileDropStore.getState().pending).toBeNull();
  });

  it("replaces an earlier pending drop with a newer one", () => {
    const first = makeEntry("env-1", "thread-1", makeFiles(1));
    const second = makeEntry("env-2", "thread-2", makeFiles(3));
    useSidebarPendingFileDropStore.getState().setPendingFileDrop(first);
    useSidebarPendingFileDropStore.getState().setPendingFileDrop(second);

    expect(useSidebarPendingFileDropStore.getState().pending).toEqual(second);
    expect(
      useSidebarPendingFileDropStore.getState().consumePendingFileDrop(first.threadRef),
    ).toBeNull();
    expect(
      useSidebarPendingFileDropStore.getState().consumePendingFileDrop(second.threadRef),
    ).not.toBeNull();
  });

  it("does not confuse refs whose joined keys collide on colons", () => {
    const entry = makeEntry("a", "b:c", makeFiles(1));
    useSidebarPendingFileDropStore.getState().setPendingFileDrop(entry);

    const colliding = makeEntry("a:b", "c", []).threadRef;
    expect(useSidebarPendingFileDropStore.getState().consumePendingFileDrop(colliding)).toBeNull();
    expect(useSidebarPendingFileDropStore.getState().pending).toEqual(entry);
  });
});
