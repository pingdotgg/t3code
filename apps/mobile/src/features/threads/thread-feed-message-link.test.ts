import { describe, expect, it } from "vite-plus/test";

import { ScheduledTaskId } from "@t3tools/contracts";
import {
  linkedMessageFoldRowId,
  resolveLinkedMessageStep,
  resolveMessageCopyContent,
} from "./thread-feed-message-link";

const absent = {
  presented: false,
  inFeed: false,
  foldedRunId: null,
  foldedRowId: null,
  synced: true,
  connectionPhase: "connected" as const,
  syncError: null,
  historyLoading: false,
  historyError: null,
  hasMoreHistory: true,
  lastLoadChangedNothing: false,
};

describe("resolveLinkedMessageStep", () => {
  it("waits for sync before consuming a cached target, then follows the replacement snapshot", () => {
    expect(resolveLinkedMessageStep({ ...absent, presented: true, synced: false })).toBe("wait");
    expect(resolveLinkedMessageStep({ ...absent, hasMoreHistory: true })).toBe("load");
    expect(resolveLinkedMessageStep({ ...absent, presented: true })).toBe("scroll");
  });

  it("waits for sync before expanding or rejecting cached rows", () => {
    expect(
      resolveLinkedMessageStep({ ...absent, inFeed: true, foldedRunId: "run-1", synced: false }),
    ).toBe("wait");
    expect(resolveLinkedMessageStep({ ...absent, inFeed: true, synced: false })).toBe("wait");
  });

  it("expands the turn that hides the message", () => {
    expect(resolveLinkedMessageStep({ ...absent, inFeed: true, foldedRunId: "run-1" })).toBe(
      "expand",
    );
  });

  it("does not page history for a loaded message that no fold hides", () => {
    expect(resolveLinkedMessageStep({ ...absent, inFeed: true })).toBe("missing");
  });

  it("waits for the sync and any history load before deciding the message is older", () => {
    expect(resolveLinkedMessageStep({ ...absent, synced: false })).toBe("wait");
    expect(resolveLinkedMessageStep({ ...absent, historyLoading: true })).toBe("wait");
    expect(resolveLinkedMessageStep({ ...absent, presented: true, historyLoading: true })).toBe(
      "wait",
    );
  });

  it("loads earlier history until it runs out, then reports the message missing", () => {
    expect(resolveLinkedMessageStep(absent)).toBe("load");
    expect(resolveLinkedMessageStep({ ...absent, hasMoreHistory: false })).toBe("missing");
  });

  it("reports a failed load instead of a missing message", () => {
    expect(resolveLinkedMessageStep({ ...absent, historyError: "offline" })).toBe("failed");
    expect(resolveLinkedMessageStep({ ...absent, lastLoadChangedNothing: true })).toBe("failed");
  });
});

it("retains unknown sync readiness and waits only for active synchronization", () => {
  const { synced: _synced, ...unknown } = absent;
  expect(resolveLinkedMessageStep(unknown)).toBe("load");
  expect(resolveLinkedMessageStep({ ...unknown, presented: true })).toBe("scroll");
  expect(resolveLinkedMessageStep({ ...unknown, syncStatus: "synchronizing" })).toBe("wait");
  expect(resolveLinkedMessageStep({ ...unknown, syncStatus: "live" })).toBe("load");
});
it.each(["empty", "cached"] as const)(
  "keeps the link pending while %s messages can still synchronize",
  (syncStatus) => {
    for (const connectionPhase of [
      "available",
      "connecting",
      "reconnecting",
      "connected",
    ] as const) {
      expect(resolveLinkedMessageStep({ ...absent, syncStatus, connectionPhase })).toBe("wait");
      expect(
        resolveLinkedMessageStep({ ...absent, syncStatus, connectionPhase, presented: true }),
      ).toBe("wait");
      if (connectionPhase !== "connected") {
        expect(
          resolveLinkedMessageStep({
            ...absent,
            syncStatus,
            connectionPhase,
            syncError: "Previous connection failed",
          }),
        ).toBe("wait");
      }
    }
    expect(resolveLinkedMessageStep({ ...absent, syncStatus: "synchronizing" })).toBe("wait");
    expect(resolveLinkedMessageStep({ ...absent, syncStatus: "live" })).toBe("load");
    expect(resolveLinkedMessageStep({ ...absent, syncStatus: "live", presented: true })).toBe(
      "scroll",
    );
  },
);
it.each(["empty", "cached", "synchronizing"] as const)(
  "reports unavailable %s messages when the connection cannot synchronize",
  (syncStatus) => {
    for (const connectionPhase of ["offline", "error", "unsupported"] as const) {
      expect(resolveLinkedMessageStep({ ...absent, syncStatus, connectionPhase })).toBe("failed");
      expect(
        resolveLinkedMessageStep({ ...absent, syncStatus, connectionPhase, historyLoading: true }),
      ).toBe("wait");
    }
  },
);
it.each(["empty", "cached"] as const)(
  "reports a %s synchronization failure even while the connection stays connected",
  (syncStatus) => {
    expect(
      resolveLinkedMessageStep({ ...absent, syncStatus, syncError: "Could not synchronize" }),
    ).toBe("failed");
  },
);
it("reports a deleted thread's target missing", () => {
  expect(resolveLinkedMessageStep({ ...absent, syncStatus: "deleted" })).toBe("missing");
});

it.each(["agent", "automation"] as const)(
  "reveals a collapsed %s message before scrolling to its body",
  (attribution) => {
    const message = {
      id: "message-1",
      role: "user",
      text: "Full message body",
      createdBy: "agent" as const,
      ...(attribution === "automation" ? { scheduledTaskId: ScheduledTaskId.make("task-1") } : {}),
    };
    const foldedRowId = linkedMessageFoldRowId(message, {});
    expect(foldedRowId).toBe(`${attribution}:message-1`);
    const target = { ...absent, presented: true, inFeed: true, foldedRowId };
    expect(resolveLinkedMessageStep(target)).toBe("expand-row");
    expect(resolveLinkedMessageStep({ ...target, syncStatus: "cached" })).toBe("wait");
    expect(
      resolveLinkedMessageStep({
        ...target,
        foldedRowId: linkedMessageFoldRowId(message, { [`${attribution}:message-1`]: true }),
      }),
    ).toBe("scroll");
  },
);

it("keeps ordinary user, server, and assistant messages unfolded", () => {
  const message = { id: "message-1", role: "user", text: "Full message body" };
  expect(linkedMessageFoldRowId(message, {})).toBeNull();
  expect(
    linkedMessageFoldRowId({ ...message, createdBy: "agent", creationSource: "server" }, {}),
  ).toBeNull();
  expect(
    linkedMessageFoldRowId({ ...message, role: "assistant", createdBy: "agent" }, {}),
  ).toBeNull();
});

it("copies an attachment-only message's URL instead of empty text", () => {
  const messageLink = {
    environmentId: "environment-1",
    threadId: "thread-1",
    messageId: "message-1",
  };
  for (const text of ["", " \n "]) {
    expect(resolveMessageCopyContent(text, messageLink)).toEqual({
      kind: "message-link",
      text: "https://app.t3.codes/environment-1/thread-1?message=message-1",
    });
  }
  expect(resolveMessageCopyContent("", null)).toBeNull();
  expect(resolveMessageCopyContent("  Message body  ", messageLink)).toEqual({
    kind: "text",
    text: "  Message body  ",
  });
});

it("stops automatic history paging at its budget but still opens a loaded target", () => {
  const exhausted = { ...absent, historyPagesRequested: 20 };
  expect(resolveLinkedMessageStep({ ...absent, historyPagesRequested: 19 })).toBe("load");
  expect(resolveLinkedMessageStep(exhausted)).toBe("failed");
  expect(resolveLinkedMessageStep({ ...exhausted, presented: true })).toBe("scroll");
  expect(resolveLinkedMessageStep({ ...exhausted, hasMoreHistory: false })).toBe("missing");
});
