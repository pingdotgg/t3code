import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { RuntimeTaskId, ThreadId } from "./baseSchemas.ts";

import {
  ProviderStopTaskError,
  ProviderStopTaskInput,
  ProviderTaskStopFailedError,
  ProviderTaskStopUnsupportedError,
} from "./providerTask.ts";

const decodeInput = Schema.decodeUnknownResult(ProviderStopTaskInput);
const decodeError = Schema.decodeUnknownResult(ProviderStopTaskError);
const encodeError = Schema.encodeUnknownSync(ProviderStopTaskError);
const isStopTaskError = Schema.is(ProviderStopTaskError);

describe("ProviderStopTaskInput", () => {
  it("decodes a thread + task pair", () => {
    const decoded = decodeInput({ threadId: "thread-1", taskId: "task-1" });
    expect(decoded._tag).toBe("Success");
    if (decoded._tag === "Success") {
      expect(decoded.success.threadId).toBe("thread-1");
      expect(decoded.success.taskId).toBe("task-1");
    }
  });

  it("rejects a payload with no taskId", () => {
    expect(decodeInput({ threadId: "thread-1" })._tag).toBe("Failure");
  });
});

describe("ProviderStopTaskError", () => {
  it("round-trips the unsupported refusal with its user-facing copy", () => {
    const error = new ProviderTaskStopUnsupportedError({
      threadId: ThreadId.make("thread-1"),
      taskId: RuntimeTaskId.make("task-1"),
    });
    expect(error.message).toBe("This provider can't stop tasks.");
    expect(isStopTaskError(error)).toBe(true);

    const decoded = decodeError(encodeError(error));
    expect(decoded._tag).toBe("Success");
    if (decoded._tag === "Success") {
      expect(decoded.success._tag).toBe("ProviderTaskStopUnsupportedError");
    }
  });

  it("round-trips a failure detail", () => {
    const error = new ProviderTaskStopFailedError({
      threadId: ThreadId.make("thread-1"),
      taskId: RuntimeTaskId.make("task-1"),
      detail: "session closed",
    });
    expect(error.message).toContain("session closed");

    const decoded = decodeError(encodeError(error));
    expect(decoded._tag).toBe("Success");
    if (decoded._tag === "Success") {
      expect(decoded.success._tag).toBe("ProviderTaskStopFailedError");
    }
  });

  it("fails closed on an unknown tag", () => {
    expect(decodeError({ _tag: "ProviderTaskStopRetriedError" })._tag).toBe("Failure");
  });
});
