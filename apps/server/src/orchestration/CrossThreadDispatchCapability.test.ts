import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  consumeCrossThreadDispatchCapability,
  issueCrossThreadDispatchCapability,
} from "./CrossThreadDispatchCapability.ts";

describe("CrossThreadDispatchCapability", () => {
  it("binds a capability to one source thread and consumes it once", () => {
    const sourceThreadId = ThreadId.make("source-thread");
    const token = issueCrossThreadDispatchCapability(sourceThreadId);

    expect(consumeCrossThreadDispatchCapability(token, ThreadId.make("other-thread"))).toBe(false);
    expect(consumeCrossThreadDispatchCapability(token, sourceThreadId)).toBe(false);

    const validToken = issueCrossThreadDispatchCapability(sourceThreadId);
    expect(consumeCrossThreadDispatchCapability(validToken, sourceThreadId)).toBe(true);
    expect(consumeCrossThreadDispatchCapability(validToken, sourceThreadId)).toBe(false);
  });
});
