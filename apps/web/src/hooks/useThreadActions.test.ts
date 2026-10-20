import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  navigateAfterThreadDeletion,
  requestThreadUnpinConfirmation,
  runArchivedThreadBatch,
  ThreadArchiveBlockedError,
} from "./useThreadActions";
import { toastManager } from "../components/ui/toast";
import { refreshArchivedThreadsForEnvironment } from "../lib/archivedThreadsState";

vi.mock("../lib/archivedThreadsState", () => ({
  refreshArchivedThreadsForEnvironment: vi.fn(),
}));

describe("runArchivedThreadBatch", () => {
  afterEach(() => vi.clearAllMocks());

  const local = EnvironmentId.make("environment-local");
  const remote = EnvironmentId.make("environment-remote");
  const targets = [
    scopeThreadRef(local, ThreadId.make("thread-1")),
    scopeThreadRef(local, ThreadId.make("thread-2")),
    scopeThreadRef(remote, ThreadId.make("thread-3")),
  ];

  it("keeps going after a failure and refreshes each environment once", async () => {
    const firstFailure = AsyncResult.failure(Cause.fail(new Error("first")));
    const results = [
      firstFailure,
      AsyncResult.failure(Cause.fail(new Error("second"))),
      AsyncResult.success(undefined),
    ];
    const run = vi.fn(async () => results.shift()!);

    await expect(runArchivedThreadBatch(targets, run)).resolves.toBe(firstFailure);

    expect(run).toHaveBeenCalledTimes(3);
    expect(vi.mocked(refreshArchivedThreadsForEnvironment).mock.calls).toEqual([[local], [remote]]);
  });

  it("stops at an interruption without reporting it", async () => {
    const run = vi.fn(async () => AsyncResult.failure(Cause.interrupt()));

    await expect(runArchivedThreadBatch(targets, run)).resolves.toBeNull();

    expect(run).toHaveBeenCalledOnce();
    expect(vi.mocked(refreshArchivedThreadsForEnvironment).mock.calls).toEqual([[local]]);
  });
});

describe("navigateAfterThreadDeletion", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reports a rejected navigation without failing the completed deletion", async () => {
    const addToast = vi.spyOn(toastManager, "add").mockReturnValue("navigation-error");

    await expect(
      navigateAfterThreadDeletion(() => Promise.reject(new Error("route unavailable"))),
    ).resolves.toBeUndefined();

    expect(addToast).toHaveBeenCalledOnce();
    expect(addToast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Thread deleted, but navigation failed",
        description: "route unavailable",
      }),
    );
  });

  it("does not report an error after successful navigation", async () => {
    const addToast = vi.spyOn(toastManager, "add");

    await navigateAfterThreadDeletion(() => Promise.resolve());

    expect(addToast).not.toHaveBeenCalled();
  });
});

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
    expect(error.message).toBe("Cannot archive while the provider is active.");
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
