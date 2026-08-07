import { describe, expect, it } from "vite-plus/test";

import { threadWorkLogOverflowNoun } from "./thread-work-log-labels";

describe("thread work log overflow labels", () => {
  it("describes tool-only groups as tool calls", () => {
    expect(threadWorkLogOverflowNoun(true, 1)).toBe("tool call");
    expect(threadWorkLogOverflowNoun(true, 2)).toBe("tool calls");
  });

  it("describes mixed groups as log entries", () => {
    expect(threadWorkLogOverflowNoun(false, 1)).toBe("log entry");
    expect(threadWorkLogOverflowNoun(false, 2)).toBe("log entries");
  });
});
