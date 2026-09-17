import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { threadAllowsProviderSwitch } from "./thread-provider-switching";

const startedThread = {
  latestRun: { id: "run-1" },
  latestUserMessageAt: "2026-06-01T00:00:00.000Z",
  runtime: { status: "idle" },
} as never;

const unstartedThread = {
  latestRun: null,
  latestUserMessageAt: null,
  runtime: null,
} as never;

function projectionWithSession(supportsProviderSwitchingViaHandoff: boolean) {
  return {
    thread: { id: "thread", activeProviderThreadId: "provider-thread" },
    runs: [],
    providerThreads: [
      { id: "provider-thread", appThreadId: "thread", providerSessionId: "provider-session" },
    ],
    providerSessions: [
      {
        id: "provider-session",
        status: "running",
        capabilities: { sessions: { supportsProviderSwitchingViaHandoff } },
      },
    ],
  } as unknown as OrchestrationV2ThreadProjection;
}

describe("threadAllowsProviderSwitch", () => {
  it("offers every provider when the session can hand the conversation off", () => {
    expect(
      threadAllowsProviderSwitch({
        thread: startedThread,
        projection: projectionWithSession(true),
      }),
    ).toBe(true);
  });

  it("keeps a started thread on its provider when the session cannot hand off", () => {
    expect(
      threadAllowsProviderSwitch({
        thread: startedThread,
        projection: projectionWithSession(false),
      }),
    ).toBe(false);
  });

  it("leaves a thread that never ran a turn unbound", () => {
    expect(threadAllowsProviderSwitch({ thread: unstartedThread, projection: null })).toBe(true);
  });

  it("keeps a started thread bound until its projection resolves a session", () => {
    expect(threadAllowsProviderSwitch({ thread: startedThread, projection: null })).toBe(false);
  });
});
