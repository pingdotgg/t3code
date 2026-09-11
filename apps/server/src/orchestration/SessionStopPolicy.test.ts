import { ProviderDriverKind, ProviderInstanceId, ThreadId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { canStopThreadSessionIfIdle } from "./SessionStopPolicy.ts";

const idle = {
  expectedProviderName: ProviderDriverKind.make("codex"),
  session: {
    threadId: ThreadId.make("thread-1"),
    status: "ready" as const,
    providerName: "codex",
    providerInstanceId: ProviderInstanceId.make("codex"),
    runtimeMode: "full-access" as const,
    activeTurnId: null,
    lastError: null,
    updatedAt: "2026-09-11T00:00:00.000Z",
  },
  latestTurnState: null,
  hasQueuedTurnStart: false,
  hasPendingRequests: false,
  backgroundLiveness: null,
};

describe("guarded Codex session stop policy", () => {
  it("allows the four non-working session states", () => {
    for (const status of ["ready", "idle", "interrupted", "error"] as const) {
      expect(canStopThreadSessionIfIdle({ ...idle, session: { ...idle.session, status } })).toBe(
        true,
      );
    }
  });

  it("rejects every signal that work is active or belongs to another provider", () => {
    const unsafe = [
      { ...idle, expectedProviderName: ProviderDriverKind.make("claudeAgent") },
      { ...idle, session: { ...idle.session, providerName: "claudeAgent" } },
      { ...idle, session: { ...idle.session, status: "starting" as const } },
      { ...idle, session: { ...idle.session, status: "running" as const } },
      { ...idle, session: { ...idle.session, activeTurnId: TurnId.make("turn-1") } },
      { ...idle, latestTurnState: "running" as const },
      { ...idle, hasQueuedTurnStart: true },
      { ...idle, hasPendingRequests: true },
      { ...idle, backgroundLiveness: "working" as const },
      { ...idle, backgroundLiveness: "monitoring" as const },
    ];

    for (const input of unsafe) {
      expect(canStopThreadSessionIfIdle(input)).toBe(false);
    }
  });
});
