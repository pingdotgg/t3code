import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  canSendLater,
  firstSteerableQueuedRun,
  parseSendLaterMinutes,
  queuedRunReleaseIso,
} from "./sendLater";

const existingThread = {
  serverSupportsDelayedMessages: true,
  isServerThread: true,
  needsThreadBootstrap: false,
  sendQueuesBehindSetup: false,
};

describe("canSendLater", () => {
  it("offers a delayed send in an existing thread on a server that holds delayed messages", () => {
    expect(canSendLater(existingThread)).toBe(true);
  });

  it("keeps the instant send only on a server without delayed messages", () => {
    // Such a server drops the delay and would send the message immediately.
    expect(canSendLater({ ...existingThread, serverSupportsDelayedMessages: false })).toBe(false);
  });

  it("keeps the instant send only for messages that launch or bootstrap a thread", () => {
    expect(canSendLater({ ...existingThread, isServerThread: false })).toBe(false);
    expect(canSendLater({ ...existingThread, needsThreadBootstrap: true })).toBe(false);
  });

  it("keeps the instant send only while the thread is still preparing its workspace", () => {
    expect(canSendLater({ ...existingThread, sendQueuesBehindSetup: true })).toBe(false);
  });
});

describe("parseSendLaterMinutes", () => {
  it("turns whole minutes between 1 and 60 into a delay", () => {
    expect(parseSendLaterMinutes("1")).toBe(60_000);
    expect(parseSendLaterMinutes(" 10 ")).toBe(10 * 60_000);
    expect(parseSendLaterMinutes("060")).toBe(60 * 60_000);
  });

  it("rejects values the server would refuse instead of sending at once", () => {
    for (const value of ["", "  ", "0", "61", "1.5", "-5", "1e1", "NaN", "10m", "Infinity"]) {
      expect(parseSendLaterMinutes(value)).toBeNull();
    }
  });
});

describe("queuedRunReleaseIso", () => {
  it("reads a decoded release time and treats a released run as ready", () => {
    const releaseAt = DateTime.makeUnsafe("2026-10-17T15:42:00.000Z");
    expect(queuedRunReleaseIso({ releaseAt })).toBe("2026-10-17T15:42:00.000Z");
    expect(queuedRunReleaseIso({ releaseAt: "2026-10-17T15:42:00.000Z" })).toBe(
      "2026-10-17T15:42:00.000Z",
    );
    expect(queuedRunReleaseIso({ releaseAt: null })).toBeNull();
    expect(queuedRunReleaseIso({})).toBeNull();
  });
});

describe("firstSteerableQueuedRun", () => {
  it("skips delayed messages so the steer shortcut cannot send one early", () => {
    const delayed = { id: "delayed", run: { releaseAt: "2026-10-17T15:42:00.000Z" } };
    const ready = { id: "ready", run: {} };
    expect(firstSteerableQueuedRun([delayed, ready])?.id).toBe("ready");
    expect(firstSteerableQueuedRun([delayed])).toBeUndefined();
  });
});
