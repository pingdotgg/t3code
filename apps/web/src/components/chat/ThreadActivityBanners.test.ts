import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { childInputNowItem } from "./ThreadActivityBanners";

describe("childInputNowItem", () => {
  it("leaves a subagent's approval to the floating card, not the timeline", () => {
    const child = {
      id: ThreadId.make("child"),
      environmentId: EnvironmentId.make("environment:test"),
      title: "Child",
      hasPendingApprovals: true,
      hasPendingUserInput: false,
      lineage: { sideChat: false },
    } as EnvironmentThreadShell;

    expect(
      childInputNowItem({
        childThreadInputs: [child],
        parentAwaitingUser: false,
        onOpenThread: () => undefined,
      }),
    ).toBeNull();
  });
});
