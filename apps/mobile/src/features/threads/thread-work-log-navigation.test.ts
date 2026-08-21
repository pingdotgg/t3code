import { describe, expect, it } from "vite-plus/test";

import { threadWorkLogItemHasOpenAction } from "./thread-work-log-navigation";

describe("threadWorkLogItemHasOpenAction", () => {
  it("keeps internal subagent threads out of mobile navigation", () => {
    expect(threadWorkLogItemHasOpenAction("subagent")).toBe(false);
  });

  it("keeps user-facing related threads navigable", () => {
    expect(threadWorkLogItemHasOpenAction("thread_created")).toBe(true);
    expect(threadWorkLogItemHasOpenAction("fork")).toBe(true);
  });
});
