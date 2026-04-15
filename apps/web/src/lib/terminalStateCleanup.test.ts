import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime";
import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { collectActiveTerminalThreadIds } from "./terminalStateCleanup";

const threadId = (id: string): ThreadId => ThreadId.make(id);
const threadKey = (environmentId: string, id: string): string =>
  scopedThreadKey(scopeThreadRef(environmentId as never, threadId(id)));

describe("collectActiveTerminalThreadIds", () => {
  it("retains non-deleted server threads", () => {
    const activeThreadIds = collectActiveTerminalThreadIds({
      snapshotThreads: [
        { key: threadKey("env-a", "server-1"), deletedAt: null, archivedAt: null },
        { key: threadKey("env-b", "server-2"), deletedAt: null, archivedAt: null },
      ],
      draftThreadKeys: [],
    });

    expect(activeThreadIds).toEqual(
      new Set([threadKey("env-a", "server-1"), threadKey("env-b", "server-2")]),
    );
  });

  it("ignores deleted and archived server threads and keeps local draft threads", () => {
    const activeThreadIds = collectActiveTerminalThreadIds({
      snapshotThreads: [
        { key: threadKey("env-a", "server-active"), deletedAt: null, archivedAt: null },
        {
          key: threadKey("env-a", "server-deleted"),
          deletedAt: "2026-03-05T08:00:00.000Z",
          archivedAt: null,
        },
        {
          key: threadKey("env-a", "server-archived"),
          deletedAt: null,
          archivedAt: "2026-03-05T09:00:00.000Z",
        },
      ],
      draftThreadKeys: [threadKey("env-a", "local-draft")],
    });

    expect(activeThreadIds).toEqual(
      new Set([threadKey("env-a", "server-active"), threadKey("env-a", "local-draft")]),
    );
  });

  it("does not keep draft-linked terminal state for archived server threads", () => {
    const archivedThreadId = threadKey("env-a", "server-archived");

    const activeThreadIds = collectActiveTerminalThreadIds({
      snapshotThreads: [
        {
          key: archivedThreadId,
          deletedAt: null,
          archivedAt: "2026-03-05T09:00:00.000Z",
        },
      ],
      draftThreadKeys: [archivedThreadId, threadKey("env-a", "local-draft")],
    });

    expect(activeThreadIds).toEqual(new Set([threadKey("env-a", "local-draft")]));
  });
});
