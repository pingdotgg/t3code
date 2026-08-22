import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { PreviewAutomationOperationError } from "./previewAutomationErrors";

describe("PreviewAutomationOperationError", () => {
  const context = {
    requestId: "request-1",
    operation: "click" as const,
    environmentId: EnvironmentId.make("environment-1"),
    threadId: ThreadId.make("thread-1"),
    tabId: "tab-1",
  };

  it("maps typed not-found failures to a visible/disabled/ambiguous reason", () => {
    const hidden = PreviewAutomationOperationError.fromCause({
      ...context,
      cause: { _tag: "PreviewAutomationTargetHiddenError" },
    });
    const disabled = PreviewAutomationOperationError.fromCause({
      ...context,
      cause: { _tag: "PreviewAutomationTargetDisabledError" },
    });
    const ambiguous = PreviewAutomationOperationError.fromCause({
      ...context,
      cause: { _tag: "PreviewAutomationTargetAmbiguousError", matchCount: 3 },
    });
    const missing = PreviewAutomationOperationError.fromCause({
      ...context,
      cause: { _tag: "PreviewAutomationTargetNotFoundError" },
    });
    expect(hidden.message).toContain("not visible");
    expect(disabled.message).toContain("disabled");
    expect(ambiguous.message).toContain("matched 3 elements");
    expect(missing.message).toContain("could not find a target");
    expect(hidden.message).not.toContain("secret");
    expect(disabled.message).not.toContain("secret");
    expect(ambiguous.message).not.toContain("secret");
  });
});
