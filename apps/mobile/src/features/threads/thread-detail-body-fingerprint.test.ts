import { describe, expect, it } from "vite-plus/test";

import type { ThreadDetailScreenProps } from "./ThreadDetailScreen";
import { threadDetailBodyFingerprint } from "./thread-detail-body-fingerprint";

function fingerprintWithResume(
  onResumeQueue: ThreadDetailScreenProps["onResumeQueue"],
  compactBeforeSend?: ThreadDetailScreenProps["compactBeforeSend"],
): readonly unknown[] {
  // Partial fixture: only conditional controls are exercised.
  return threadDetailBodyFingerprint({
    onResumeQueue,
    compactBeforeSend,
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
  it("changes when Resume or the compaction notice changes", () => {
    const hidden = fingerprintWithResume(null);
    const visible = fingerprintWithResume(async () => undefined);
    expect(hidden).not.toEqual(visible);
    expect(fingerprintWithResume(null)).toEqual(hidden);
    expect(fingerprintWithResume(async () => undefined)).toEqual(visible);
    const notice = { tokens: 1000, keepFullHistory: () => undefined };
    expect(fingerprintWithResume(null, notice)).not.toEqual(hidden);
    expect(fingerprintWithResume(null, { ...notice, tokens: 2000 })).not.toEqual(
      fingerprintWithResume(null, notice),
    );
    expect(fingerprintWithResume(null, null)).toEqual(hidden);
  });
});
