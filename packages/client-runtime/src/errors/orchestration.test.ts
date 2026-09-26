import {
  EnvironmentResourceNotFoundError,
  OrchestrationDispatchCommandError,
  OrchestrationGetSnapshotError,
  OrchestrationThreadNotFoundError,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { describe, expect, it } from "vite-plus/test";

import {
  findHttpThreadNotFoundError,
  hasTerminalThreadNotFoundFailure,
  isTerminalThreadNotFoundError,
  wasBootstrapThreadDeleted,
  wasBootstrapThreadNotCreated,
} from "./orchestration.ts";

const THREAD_ID = ThreadId.make("thread-1");
const httpThreadNotFound = new EnvironmentResourceNotFoundError({
  code: "not_found",
  reason: "thread_not_found",
  traceId: "trace-thread-not-found",
});
const socketThreadNotFound = new OrchestrationThreadNotFoundError({ threadId: THREAD_ID });

describe("terminal thread-not-found classification", () => {
  it("recognizes the authoritative HTTP and WebSocket errors", () => {
    expect(isTerminalThreadNotFoundError(httpThreadNotFound)).toBe(true);
    expect(isTerminalThreadNotFoundError(socketThreadNotFound)).toBe(true);
    expect(
      isTerminalThreadNotFoundError(
        new OrchestrationGetSnapshotError({
          message: `Thread ${THREAD_ID} was not found`,
          cause: THREAD_ID,
        }),
      ),
    ).toBe(false);
    expect(isTerminalThreadNotFoundError(new Error("connection lost"))).toBe(false);
  });

  it("finds the HTTP error anywhere in a combined cause", () => {
    const cause = Cause.combine(Cause.fail(socketThreadNotFound), Cause.fail(httpThreadNotFound));

    expect(findHttpThreadNotFoundError(cause)).toBe(httpThreadNotFound);
    expect(findHttpThreadNotFoundError(Cause.fail(socketThreadNotFound))).toBeUndefined();
  });

  it("treats either transport error as terminal without accepting defects", () => {
    expect(hasTerminalThreadNotFoundFailure(Cause.fail(httpThreadNotFound))).toBe(true);
    expect(hasTerminalThreadNotFoundFailure(Cause.fail(socketThreadNotFound))).toBe(true);
    expect(hasTerminalThreadNotFoundFailure(Cause.die(socketThreadNotFound))).toBe(false);
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
    expect(
      wasBootstrapThreadDeleted(
        new OrchestrationDispatchCommandError({ message: "Failed to create worktree." }),
      ),
    ).toBe(false);
    expect(wasBootstrapThreadDeleted(new Error("connection lost"))).toBe(false);
  });
});

describe("wasBootstrapThreadNotCreated", () => {
  it("accepts only a confirmed never-created bootstrap thread", () => {
    const notCreated = new OrchestrationDispatchCommandError({
      message: "A separate worktree requires a base commit.",
      bootstrapThreadDisposition: "not-created",
    });
    expect(wasBootstrapThreadNotCreated(notCreated)).toBe(true);
    expect(wasBootstrapThreadDeleted(notCreated)).toBe(false);
    expect(
      wasBootstrapThreadNotCreated(
        new OrchestrationDispatchCommandError({
          message: "Failed to create worktree.",
          bootstrapThreadDisposition: "deleted",
        }),
      ),
    ).toBe(false);
    expect(
      wasBootstrapThreadNotCreated(
        new OrchestrationDispatchCommandError({
          message: "Failed to create worktree.",
        }),
      ),
    ).toBe(false);
    expect(wasBootstrapThreadNotCreated(new Error("connection lost"))).toBe(false);
  });
});
