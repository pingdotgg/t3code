import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { v2Projection } from "../../../../packages/client-runtime/src/state/orchestrationV2TestFixtures";
import { threadDetailToShell } from "./thread-detail-shell";

describe("threadDetailToShell", () => {
  it("keeps where a delegated task came from, which the thread header names", () => {
    const delegatedFrom = {
      environmentId: EnvironmentId.make("environment-linked"),
      threadId: ThreadId.make("thread-parent"),
      title: "Parent thread",
    };
    const linkOrigin = { sessionId: "session-1", label: "T3 Code", access: "full-access" as const };
    const shell = threadDetailToShell(EnvironmentId.make("environment-1"), {
      ...v2Projection,
      thread: { ...v2Projection.thread, delegatedFrom, linkOrigin },
    });

    expect(shell.delegatedFrom).toEqual(delegatedFrom);
    expect(shell.linkOrigin).toEqual(linkOrigin);
  });
});
