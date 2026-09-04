import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  requestThreadUnpinConfirmation,
  resolveThreadDeleteTarget,
  ThreadArchiveBlockedError,
} from "./useThreadActions";

describe("ThreadArchiveBlockedError", () => {
  it("keeps the blocked thread context with the fixed message", () => {
    const error = new ThreadArchiveBlockedError({
      environmentId: EnvironmentId.make("environment-1"),
      threadId: ThreadId.make("thread-1"),
    });

    expect(error).toMatchObject({
      environmentId: "environment-1",
      threadId: "thread-1",
    });
    expect(error.message).toBe("Cannot archive a running thread.");
  });
});

describe("resolveThreadDeleteTarget", () => {
  const target: ScopedThreadRef = {
    environmentId: EnvironmentId.make("environment-1"),
    threadId: ThreadId.make("thread-1"),
  };
  const activeThread = { id: ThreadId.make("thread-1"), title: "active-thread" };
  const archivedThread = { id: ThreadId.make("thread-1"), title: "archived-thread" };

  it("uses the active-store resolution when it hits, without fetching", async () => {
    const fetchArchived = () => {
      throw new Error("must not fetch the archived snapshot when the active store hits");
    };
    const result = await resolveThreadDeleteTarget({
      target,
      resolveActive: () => ({ thread: activeThread, threadRef: target }),
      fetchArchived,
    });

    expect(result).toEqual({ thread: activeThread, threadRef: target });
  });

  it("falls back to a live fetch and resolves the thread when the fetch finds it (t3code#9085)", async () => {
    // Archived threads are excluded from the main shell store
    // (`listActiveThreadRows`), so deleting one from Settings → Archived
    // must still resolve a thread — otherwise the worktree-cleanup path in
    // deleteThread never runs and the worktree is silently orphaned. There's
    // no synchronous archived cache to try first (it's only warm while the
    // archived panel is open), so this must always be a live fetch.
    const result = await resolveThreadDeleteTarget({
      target,
      resolveActive: () => null,
      fetchArchived: async () => [archivedThread],
    });

    expect(result).toEqual({
      thread: archivedThread,
      threadRef: target,
      archivedThreads: [archivedThread],
    });
  });

  it("returns null when the fetch succeeds but the thread isn't in it", async () => {
    const result = await resolveThreadDeleteTarget({
      target,
      resolveActive: () => null,
      fetchArchived: async () => [],
    });

    expect(result).toBeNull();
  });

  it("fails soft to null when the fetch errors (e.g. offline), instead of blocking the delete", async () => {
    const result = await resolveThreadDeleteTarget({
      target,
      resolveActive: () => null,
      fetchArchived: async () => null,
    });

    expect(result).toBeNull();
  });
});

describe("requestThreadUnpinConfirmation", () => {
  it("skips the dialog when confirmation is disabled", async () => {
    let callCount = 0;
    const result = await requestThreadUnpinConfirmation({
      enabled: false,
      title: "Pinned thread",
      confirm: async () => {
        callCount += 1;
        return false;
      },
    });

    expect(result).toMatchObject({ _tag: "Success", value: true });
    expect(callCount).toBe(0);
  });

  it("degrades gracefully when dialogs are unavailable", async () => {
    const result = await requestThreadUnpinConfirmation({
      enabled: true,
      title: "Pinned thread",
      confirm: null,
    });

    expect(result).toMatchObject({ _tag: "Success", value: true });
  });

  it("uses the thread title and returns the user's decision", async () => {
    let message = "";
    const result = await requestThreadUnpinConfirmation({
      enabled: true,
      title: "Release prep",
      confirm: async (nextMessage) => {
        message = nextMessage;
        return false;
      },
    });

    expect(message).toBe(
      'Unpin thread "Release prep"?\nThis will move the thread out of your pinned section.',
    );
    expect(result).toMatchObject({ _tag: "Success", value: false });
  });

  it("keeps dialog failures observable", async () => {
    const result = await requestThreadUnpinConfirmation({
      enabled: true,
      title: "Pinned thread",
      confirm: () => Promise.reject(new Error("dialog unavailable")),
    });

    expect(result._tag).toBe("Failure");
  });
});
