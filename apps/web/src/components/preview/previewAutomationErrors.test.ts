import {
  type DesktopPreviewAutomationClickResult,
  EnvironmentId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  confirmPreviewAutomationClickTarget,
  PreviewAutomationOperationError,
  PreviewAutomationTargetLookupHostError,
} from "./previewAutomationErrors";

type NotSentClickResult = Extract<DesktopPreviewAutomationClickResult, { _tag: "NotSent" }>;

describe("confirmPreviewAutomationClickTarget", () => {
  const context = {
    requestId: "request-1",
    operation: "click" as const,
    environmentId: EnvironmentId.make("environment-1"),
    threadId: ThreadId.make("thread-1"),
    tabId: "tab-1",
  };

  const lookupError = (
    result:
      | { readonly _tag: "NotSent"; readonly reason: "target-missing" }
      | { readonly _tag: "NotSent"; readonly reason: "target-hidden" }
      | { readonly _tag: "NotSent"; readonly reason: "target-disabled" }
      | {
          readonly _tag: "NotSent";
          readonly reason: "target-ambiguous";
          readonly matchCount: number;
        },
  ) => {
    try {
      confirmPreviewAutomationClickTarget(result, context);
      throw new Error("Expected click target confirmation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(PreviewAutomationTargetLookupHostError);
      return error as PreviewAutomationTargetLookupHostError;
    }
  };

  it("maps typed IPC outcomes to visible, disabled, ambiguous, and missing reasons", () => {
    const hidden = lookupError({ _tag: "NotSent", reason: "target-hidden" });
    const disabled = lookupError({ _tag: "NotSent", reason: "target-disabled" });
    const ambiguous = lookupError({
      _tag: "NotSent",
      reason: "target-ambiguous",
      matchCount: 3,
    });
    const missing = lookupError({ _tag: "NotSent", reason: "target-missing" });

    expect(hidden.message).toContain("not visible");
    expect(disabled.message).toContain("disabled");
    expect(ambiguous.message).toContain("matched 3 elements");
    expect(missing.message).toContain("not found");
    expect(hidden.message).not.toContain("secret");
    expect(disabled.message).not.toContain("secret");
    expect(ambiguous.message).not.toContain("secret");
  });

  it("fails every NotSent outcome and preserves successful results", () => {
    const results = [
      { _tag: "NotSent", reason: "tab-not-visible" },
      { _tag: "NotSent", reason: "timeout", timeoutMs: 5_000 },
      { _tag: "NotSent", reason: "target-missing" },
      { _tag: "NotSent", reason: "target-hidden" },
      { _tag: "NotSent", reason: "target-disabled" },
      { _tag: "NotSent", reason: "target-ambiguous", matchCount: 3 },
    ] satisfies ReadonlyArray<NotSentClickResult>;

    for (const result of results) {
      expect(() => confirmPreviewAutomationClickTarget(result, context)).toThrow();
    }

    for (const result of results.slice(0, 2)) {
      try {
        confirmPreviewAutomationClickTarget(result, context);
        throw new Error("Expected click target confirmation to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(PreviewAutomationOperationError);
        expect((error as PreviewAutomationOperationError).cause).toEqual(result);
      }
    }

    const dispatched = { _tag: "Dispatched" } as const;
    expect(confirmPreviewAutomationClickTarget(dispatched, context)).toBe(dispatched);
    expect(confirmPreviewAutomationClickTarget(undefined, context)).toBeUndefined();
  });
});
