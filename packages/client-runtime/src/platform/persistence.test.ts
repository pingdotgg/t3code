import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  ConnectionStorageOperationError,
  ConnectionTransientError,
  DesktopSecureStorageUnavailableError,
} from "../connection/model.ts";
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
      cause,
    });

    expect(error.cause).toBe(cause);
    expect(error.message).toBe(
      "Could not load thread: thread cache decode failed for environment environment-1 and thread thread-1.",
    );
    expect(error.message).not.toContain(cause.message);
  });

  it.each([
    ["decode", "read", "decode"],
    ["encode", "write", "encode"],
    ["migrate", "read", "migrate"],
    ["remove", "write", "remove"],
  ] as const)(
    "derives the %s catalog stage from the structured storage failure",
    (storageOperation, fallbackStage, expectedStage) => {
      const cause = ConnectionTransientError.fromStorageFailure(
        new ConnectionStorageOperationError({
          operation: storageOperation,
          backend: "schema",
          cause: new Error("storage failure"),
        }),
      );

      const error = ConnectionPersistenceError.fromStorageFailure({
        operation: "register-connection",
        fallbackStage,
        resource: "connection-catalog",
        environmentId: EnvironmentId.make("environment-1"),
        cause,
      });

      expect(error.stage).toBe(expectedStage);
      expect(error.message).toBe(
        `Could not register connection: connection catalog ${expectedStage} failed for environment environment-1.`,
      );
      expect(error.cause).toBe(cause);
    },
  );

  it("uses the caller's stage when a storage failure has no operation", () => {
    const cause = ConnectionTransientError.fromStorageFailure(
      new DesktopSecureStorageUnavailableError(),
    );

    const error = ConnectionPersistenceError.fromStorageFailure({
      operation: "list-targets",
      fallbackStage: "read",
      resource: "connection-catalog",
      cause,
    });

    expect(error.stage).toBe("read");
  });
});
