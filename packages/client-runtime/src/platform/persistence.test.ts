import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { ConnectionPersistenceError } from "./persistence.ts";

describe("ConnectionPersistenceError", () => {
  it("retains storage context and cause without deriving its message from the cause", () => {
    const cause = new Error("sensitive filesystem detail");
    const error = new ConnectionPersistenceError({
      operation: "load-thread",
      stage: "decode",
      resource: "thread-cache",
      environmentId: EnvironmentId.make("environment-1"),
      threadId: ThreadId.make("thread-1"),
      path: "file:///cache/thread-1.json",
      cause,
    });

    expect(error.cause).toBe(cause);
    expect(error.message).toBe(
      "Could not load thread: thread cache decode failed for environment environment-1 and thread thread-1 at file:///cache/thread-1.json.",
    );
    expect(error.message).not.toContain(cause.message);
  });
});
