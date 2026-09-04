import { ThreadId, type ThreadForkOrigin } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { presentThreadForkOrigin } from "./presentation.ts";

const ORIGIN = {
  sourceThreadId: ThreadId.make("source-thread"),
  sourceTurnId: null,
  sourceMessageId: null,
  forkedAt: "2026-08-01T12:00:00.000Z",
} satisfies ThreadForkOrigin;

describe("presentThreadForkOrigin", () => {
  it("omits fork origin presentation when the thread was not forked", () => {
    expect(presentThreadForkOrigin(null, null)).toBeNull();
  });

  it("marks a fork origin as deleted when its source shell is missing", () => {
    expect(presentThreadForkOrigin(ORIGIN, null)).toEqual({ kind: "deleted" });
  });

  it("presents an available fork origin with its current source title", () => {
    expect(presentThreadForkOrigin(ORIGIN, { title: "Original thread" })).toEqual({
      kind: "available",
      title: "Original thread",
    });
  });
});
