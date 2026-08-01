import { describe, expect, it } from "vite-plus/test";

import {
  previewAutomationHostFocusConcurrencyKey,
  previewLiveGatewayConcurrencyKey,
  previewReviewSnapshotConcurrencyKey,
} from "./preview.ts";

describe("preview state commands", () => {
  it("keeps focus updates from replacement host connections independent", () => {
    const first = previewAutomationHostFocusConcurrencyKey({
      environmentId: "environment-1",
      input: { clientId: "client-1", connectionId: "connection-1" },
    });
    const replacement = previewAutomationHostFocusConcurrencyKey({
      environmentId: "environment-1",
      input: { clientId: "client-1", connectionId: "connection-2" },
    });

    expect(first).not.toBe(replacement);
  });

  it("deduplicates review captures only for the same environment, thread, and tab", () => {
    const first = previewReviewSnapshotConcurrencyKey({
      environmentId: "environment-1",
      input: { threadId: "thread-1", tabId: "tab-1" },
    });
    const same = previewReviewSnapshotConcurrencyKey({
      environmentId: "environment-1",
      input: { threadId: "thread-1", tabId: "tab-1" },
    });
    const otherTab = previewReviewSnapshotConcurrencyKey({
      environmentId: "environment-1",
      input: { threadId: "thread-1", tabId: "tab-2" },
    });
    const otherEnvironment = previewReviewSnapshotConcurrencyKey({
      environmentId: "environment-2",
      input: { threadId: "thread-1", tabId: "tab-1" },
    });

    expect(first).toBe(same);
    expect(first).not.toBe(otherTab);
    expect(first).not.toBe(otherEnvironment);
  });

  it("deduplicates live-gateway opens only for the same environment, thread, and tab", () => {
    const first = previewLiveGatewayConcurrencyKey({
      environmentId: "environment-1",
      input: { threadId: "thread-1", tabId: "tab-1" },
    });
    const same = previewLiveGatewayConcurrencyKey({
      environmentId: "environment-1",
      input: { threadId: "thread-1", tabId: "tab-1" },
    });
    const otherTab = previewLiveGatewayConcurrencyKey({
      environmentId: "environment-1",
      input: { threadId: "thread-1", tabId: "tab-2" },
    });

    expect(first).toBe(same);
    expect(first).not.toBe(otherTab);
  });
});
