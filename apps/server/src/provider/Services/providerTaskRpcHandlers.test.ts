import { describe, expect, it } from "vite-plus/test";
import { RuntimeTaskId, ThreadId } from "@t3tools/contracts";

import {
  ProviderAdapterSessionNotFoundError,
  ProviderUnsupportedError,
  ProviderValidationError,
} from "../Errors.ts";
import { toProviderStopTaskError } from "./providerTaskRpcHandlers.ts";

const input = {
  threadId: ThreadId.make("thread-1"),
  taskId: RuntimeTaskId.make("task-1"),
};

describe("toProviderStopTaskError", () => {
  it("turns an unsupported adapter into the refusal the UI phrases differently", () => {
    const wire = toProviderStopTaskError(
      input,
      new ProviderUnsupportedError({ provider: "cursor" }),
    );
    expect(wire._tag).toBe("ProviderTaskStopUnsupportedError");
    expect(wire.message).toBe("This provider can't stop tasks.");
  });

  it("carries the internal message on every other failure", () => {
    const wire = toProviderStopTaskError(
      input,
      new ProviderAdapterSessionNotFoundError({
        provider: "claudeAgent",
        threadId: input.threadId,
      }),
    );
    expect(wire._tag).toBe("ProviderTaskStopFailedError");
    expect(wire.message).toContain("task-1");
  });

  it("does not leak an internal tag onto the wire", () => {
    const wire = toProviderStopTaskError(
      input,
      new ProviderValidationError({ operation: "ProviderService.stopTask", issue: "bad payload" }),
    );
    expect(wire._tag).toBe("ProviderTaskStopFailedError");
  });
});
