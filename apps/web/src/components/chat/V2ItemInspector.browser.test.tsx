import {
  EnvironmentId,
  NodeId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ProjectedTurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";

vi.mock("~/state/queries", () => ({
  useTurnItemDetail: () => ({ data: null, error: null, isPending: false }),
}));
vi.mock("./CommandOutputPanel", () => ({
  CommandOutputPanel: () => null,
  useCommandOutputStreaming: () => false,
}));

import { V2ItemInspector } from "./V2ItemInspector";

it("names both sides of a renamed file relative to the workspace", async () => {
  const now = DateTime.makeUnsafe("2026-11-27T00:00:00.000Z");
  const threadId = ThreadId.make("thread");
  const itemId = TurnItemId.make("rename");
  const projectedItem: OrchestrationV2ProjectedTurnItem = {
    position: 0,
    visibility: "local",
    sourceThreadId: threadId,
    sourceItemId: itemId,
    item: {
      id: itemId,
      threadId,
      runId: RunId.make("run"),
      nodeId: NodeId.make("node"),
      ordinal: 0,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      status: "completed",
      title: null,
      startedAt: now,
      completedAt: now,
      updatedAt: now,
      type: "file_change",
      fileName: "/repo/src/new-name.ts",
      changes: [
        { operation: "update", path: "/repo/src/new-name.ts", oldPath: "/repo/src/old-name.ts" },
      ],
    },
  };
  await using screen = await render(
    <V2ItemInspector
      projectedItem={projectedItem}
      environmentId={EnvironmentId.make("environment")}
      workspaceRoot="/repo"
    />,
    { router: false },
  );
  await expect
    .element(screen.getByRole("listitem"))
    .toHaveTextContent("update repo/src/old-name.ts → repo/src/new-name.ts");
});
