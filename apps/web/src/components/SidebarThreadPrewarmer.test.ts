import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime";
import { describe, expect, it } from "vitest";

import { getSidebarThreadPrewarmKey } from "./SidebarThreadPrewarmer";

const environmentId = EnvironmentId.make("environment-1");

describe("getSidebarThreadPrewarmKey", () => {
  it("prewarms the parent detail for a background-agent row", () => {
    const parentThreadId = ThreadId.make("parent-thread");
    const virtualRunId = ThreadId.make("agent-run:parent-thread:agent-1");

    expect(
      getSidebarThreadPrewarmKey({
        environmentId,
        id: virtualRunId,
        virtualAgentRun: {
          parentThreadId,
          taskId: "agent-1",
          status: "running",
        },
      }),
    ).toBe(scopedThreadKey(scopeThreadRef(environmentId, parentThreadId)));
  });

  it("prewarms a normal row's own detail", () => {
    const threadId = ThreadId.make("thread-1");

    expect(
      getSidebarThreadPrewarmKey({
        environmentId,
        id: threadId,
      }),
    ).toBe(scopedThreadKey(scopeThreadRef(environmentId, threadId)));
  });
});
