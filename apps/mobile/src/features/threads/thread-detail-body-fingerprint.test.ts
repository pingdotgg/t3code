import { describe, expect, it } from "vite-plus/test";

import type { ThreadDetailScreenProps } from "./ThreadDetailScreen";
import { threadDetailBodyFingerprint } from "./thread-detail-body-fingerprint";

function fingerprintWithResume(
  onResumeQueue: ThreadDetailScreenProps["onResumeQueue"],
): readonly unknown[] {
  // Partial fixture: this case only asserts Resume nullness remounts the body.
  return threadDetailBodyFingerprint({
    onResumeQueue,
    canStopThread: true,
    selectedThread: {
      id: "thread",
      title: "Thread",
      source: "local",
      modelSelection: null,
      runtimeMode: null,
      interactionMode: null,
      goal: null,
      snoozedUntil: null,
      settledOverride: null,
      lastVisitedAt: null,
      latestUserMessageAt: null,
      latestRun: null,
      runtime: null,
      limitRecovery: null,
      pendingBackgroundTasks: [],
      lineage: { parentThreadId: null },
    },
  } as unknown as ThreadDetailScreenProps);
}

describe("threadDetailBodyFingerprint", () => {
  it("changes when Resume becomes available or disappears", () => {
    const hidden = fingerprintWithResume(null);
    const visible = fingerprintWithResume(async () => undefined);
    expect(hidden).not.toEqual(visible);
    expect(fingerprintWithResume(null)).toEqual(hidden);
    expect(fingerprintWithResume(async () => undefined)).toEqual(visible);
  });
});
