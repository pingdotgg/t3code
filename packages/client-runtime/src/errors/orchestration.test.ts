import {
  OrchestrationDispatchCommandError,
  OrchestrationGetSnapshotError,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { wasBootstrapThreadDeleted, wasSubscribeThreadNotFound } from "./orchestration.ts";

describe("wasSubscribeThreadNotFound", () => {
  it("matches the typed not-found error", () => {
    expect(
      wasSubscribeThreadNotFound(
        new OrchestrationGetSnapshotError({
          message: "Thread thread-1 was not found",
          cause: "thread-1",
          threadDisposition: "not-found",
        }),
      ),
    ).toBe(true);
  });

  it("rejects a missing disposition", () => {
    expect(
      wasSubscribeThreadNotFound(
        new OrchestrationGetSnapshotError({
          message: "Thread thread-1 was not found",
          cause: "thread-1",
        }),
      ),
    ).toBe(false);
  });

  it("rejects plain errors with a matching message", () => {
    expect(wasSubscribeThreadNotFound(new Error("Thread thread-1 was not found"))).toBe(false);
  });

  it("rejects other snapshot errors", () => {
    expect(
      wasSubscribeThreadNotFound(
        new OrchestrationGetSnapshotError({
          message: "Failed to load thread thread-1",
          cause: "thread-1",
        }),
      ),
    ).toBe(false);
  });

  it("rejects unrelated errors", () => {
    expect(wasSubscribeThreadNotFound(new Error("boom"))).toBe(false);
    expect(wasSubscribeThreadNotFound(null)).toBe(false);
  });
});

describe("wasBootstrapThreadDeleted", () => {
  it("accepts only a confirmed deleted bootstrap thread", () => {
    expect(
      wasBootstrapThreadDeleted(
        new OrchestrationDispatchCommandError({
          message: "Failed to create worktree.",
          bootstrapThreadDisposition: "deleted",
        }),
      ),
    ).toBe(true);
  });

  it("rejects a missing disposition", () => {
    expect(
      wasBootstrapThreadDeleted(
        new OrchestrationDispatchCommandError({ message: "Failed to create worktree." }),
      ),
    ).toBe(false);
  });

  it("rejects unrelated errors", () => {
    expect(wasBootstrapThreadDeleted(new Error("connection lost"))).toBe(false);
  });
});
