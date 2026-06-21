import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProviderItemId, ThreadId } from "@t3tools/contracts";

import { resolveSubagentParentThreadRef } from "./subagentControls";

const environmentId = EnvironmentId.make("environment-local");

describe("resolveSubagentParentThreadRef", () => {
  it("returns the scoped parent thread for subagent children", () => {
    expect(
      resolveSubagentParentThreadRef({
        environmentId,
        parentRelation: {
          kind: "subagent",
          parentThreadId: ThreadId.make("thread-parent"),
          rootThreadId: ThreadId.make("thread-parent"),
          parentTurnId: null,
          parentItemId: ProviderItemId.make("item-parent"),
          parentActivitySequence: 0,
          providerThreadId: "provider-thread-parent",
          titleSeed: null,
          depth: 1,
          status: "running",
          startedAt: "2026-06-19T10:00:00.000Z",
          completedAt: null,
        },
      }),
    ).toEqual({
      environmentId,
      threadId: ThreadId.make("thread-parent"),
    });
  });

  it("does not synthesize a parent target for ordinary threads", () => {
    expect(
      resolveSubagentParentThreadRef({
        environmentId,
        parentRelation: undefined,
      }),
    ).toBeNull();
  });
});
