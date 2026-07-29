import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { isFinalWorktreeThreadAfterDelete, ThreadArchiveBlockedError } from "./useThreadActions";

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

describe("isFinalWorktreeThreadAfterDelete", () => {
  const first = ThreadId.make("thread-1");
  const final = ThreadId.make("thread-2");

  it("waits until every sibling was actually deleted", () => {
    expect(isFinalWorktreeThreadAfterDelete(first, [first, final], new Set())).toBe(false);
    expect(isFinalWorktreeThreadAfterDelete(final, [first, final], new Set([first]))).toBe(true);
  });

  it("does not treat an intended but uncompleted sibling delete as cleanup authority", () => {
    expect(isFinalWorktreeThreadAfterDelete(first, [first, final], new Set([final]))).toBe(true);
    expect(isFinalWorktreeThreadAfterDelete(first, [first, final], new Set())).toBe(false);
  });
});
