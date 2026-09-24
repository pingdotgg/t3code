import { MessageId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { newMessageId } from "../lib/utils";

import {
  beginMessageDispatchState,
  resolveActiveLocalDispatch,
  startMessageDispatch,
  startNewThreadBusyState,
  type ActiveLocalDispatch,
  type LocalDispatchSnapshot,
} from "./ChatView.localDispatch";

const firstMessageId = MessageId.make("message-first");
const nextMessageId = MessageId.make("message-next");
const firstStartedAt = "2026-08-20T00:00:00.000Z";
const nextStartedAt = "2026-08-20T00:01:00.000Z";

function makeSnapshot(
  expectedUserMessageId: MessageId,
  preparingWorktree = false,
  submissionIntent: LocalDispatchSnapshot["submissionIntent"] = "foreground",
): LocalDispatchSnapshot {
  return {
    startedAt: firstStartedAt,
    preparingWorktree,
    submissionIntent,
    expectedUserMessageId,
    latestTurnId: null,
    latestTurnRequestedAt: null,
    latestTurnStartedAt: null,
    latestTurnCompletedAt: null,
    sessionStatus: null,
    sessionUpdatedAt: null,
    latestTurnStartFailureId: null,
  };
}

describe("local dispatch state", () => {
  const messageDispatch: ActiveLocalDispatch = {
    kind: "message",
    snapshot: makeSnapshot(firstMessageId),
  };
  const newThreadDispatch: ActiveLocalDispatch = {
    kind: "new-thread",
    startedAt: firstStartedAt,
    preparingWorktree: false,
    submissionIntent: "foreground",
  };

  it("starts the next message after the server acknowledges the previous one", () => {
    const nextSnapshot = makeSnapshot(nextMessageId);

    expect(startMessageDispatch(messageDispatch, true, nextSnapshot)).toEqual({
      kind: "message",
      snapshot: nextSnapshot,
    });
  });

  it("keeps an unacknowledged message until its exact projection arrives", () => {
    expect(startMessageDispatch(messageDispatch, false, makeSnapshot(nextMessageId))).toBe(
      messageDispatch,
    );
  });

  it("preserves background intent while worktree preparation finishes", () => {
    const backgroundDispatch: ActiveLocalDispatch = {
      kind: "message",
      snapshot: makeSnapshot(firstMessageId, true, "background"),
    };

    expect(startMessageDispatch(backgroundDispatch, false, makeSnapshot(firstMessageId))).toEqual({
      kind: "message",
      snapshot: makeSnapshot(firstMessageId, false, "background"),
    });
  });

  it("tracks the allocated id and background intent when message dispatch begins", () => {
    const allocatedMessageId = newMessageId();

    expect(
      beginMessageDispatchState(null, false, undefined, allocatedMessageId, {
        submissionIntent: "background",
      }),
    ).toMatchObject({
      kind: "message",
      snapshot: {
        expectedUserMessageId: allocatedMessageId,
        submissionIntent: "background",
      },
    });
  });

  it("does not let source-thread acknowledgement clear new-thread work", () => {
    expect(resolveActiveLocalDispatch(newThreadDispatch, true)).toBe(newThreadDispatch);
  });

  it("keeps fanout preparation and background intent across source-thread acknowledgement", () => {
    const fanout = startNewThreadBusyState(messageDispatch, true, nextStartedAt, {
      preparingWorktree: true,
      submissionIntent: "background",
    });

    expect(fanout).toEqual({
      kind: "new-thread",
      startedAt: nextStartedAt,
      preparingWorktree: true,
      submissionIntent: "background",
    });
    expect(resolveActiveLocalDispatch(fanout, true)).toBe(fanout);
    expect(startNewThreadBusyState(fanout, true, firstStartedAt)).toBe(fanout);
  });

  it("starts new-thread work after an acknowledged message dispatch", () => {
    expect(startNewThreadBusyState(messageDispatch, true, nextStartedAt)).toEqual({
      kind: "new-thread",
      startedAt: nextStartedAt,
      preparingWorktree: false,
      submissionIntent: "foreground",
    });
  });

  it("does not replace an active dispatch with a different dispatch kind", () => {
    expect(startNewThreadBusyState(messageDispatch, false, nextStartedAt)).toBe(messageDispatch);
    expect(startMessageDispatch(newThreadDispatch, false, makeSnapshot(nextMessageId))).toBe(
      newThreadDispatch,
    );
  });
});
