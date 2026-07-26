import { describe, expect, it } from "vite-plus/test";

import { providerThreadCopyAction } from "./threadReferences";

const baseSession = {
  threadId: "t3-thread-id",
  status: "ready",
  providerName: "codex",
  runtimeMode: "full-access",
  activeTurnId: null,
  lastError: null,
  updatedAt: "2026-07-26T00:00:00.000Z",
} as const;

describe("providerThreadCopyAction", () => {
  it("keeps the existing T3 ID separate and labels Codex IDs explicitly", () => {
    expect(
      providerThreadCopyAction({
        ...baseSession,
        providerThreadId: "codex-thread-id",
      }),
    ).toEqual({
      id: "copy-provider-thread-id",
      label: "Copy Codex Thread ID",
      value: "codex-thread-id",
    });
  });

  it("uses a provider-neutral label outside Codex", () => {
    expect(
      providerThreadCopyAction({
        ...baseSession,
        providerName: "claude",
        providerThreadId: "claude-session-id",
      }),
    ).toEqual({
      id: "copy-provider-thread-id",
      label: "Copy Provider Thread ID",
      value: "claude-session-id",
    });
  });

  it("does not add an action for legacy sessions without a provider ID", () => {
    expect(providerThreadCopyAction(baseSession)).toBeNull();
    expect(providerThreadCopyAction(null)).toBeNull();
  });
});
