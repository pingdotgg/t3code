import {
  ThreadId,
  TurnItemId,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import { resolveThreadImagePath } from "./ThreadImagePath.ts";

describe("resolveThreadImagePath", () => {
  it("returns the path only for the exact V2 image item", () => {
    const now = DateTime.makeUnsafe("2026-07-30T00:00:00.000Z");
    const item = {
      id: TurnItemId.make("image-item"),
      threadId: ThreadId.make("thread-1"),
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 0,
      status: "completed" as const,
      title: null,
      startedAt: now,
      completedAt: now,
      updatedAt: now,
      type: "image_view" as const,
      source: "image_view" as const,
      path: "/tmp/tool-output.png",
    } satisfies OrchestrationV2TurnItem;
    const projection = { turnItems: [item] } satisfies Pick<
      OrchestrationV2ThreadProjection,
      "turnItems"
    >;

    expect(resolveThreadImagePath(projection, item.id)).toBe(item.path);
    expect(resolveThreadImagePath(projection, TurnItemId.make("missing-item"))).toBeNull();
    expect(
      resolveThreadImagePath(
        { turnItems: [{ ...item, status: "running", completedAt: null }] },
        item.id,
      ),
    ).toBeNull();
  });
});
