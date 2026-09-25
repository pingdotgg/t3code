import { describe, expect, it } from "vite-plus/test";

import { isSubagentThreadId, makeSubagentThreadId, parentThreadIdOf } from "./subagentThreadId.ts";

describe("subagent thread ids", () => {
  it("round-trips the parent, including nested children", () => {
    const child = makeSubagentThreadId("0b6f7c1e-2d3a-4c5b-9e8f-1a2b3c4d5e6f", "abc123");
    expect(isSubagentThreadId(child)).toBe(true);
    expect(parentThreadIdOf(child)).toBe("0b6f7c1e-2d3a-4c5b-9e8f-1a2b3c4d5e6f");
    const grandchild = makeSubagentThreadId(child, "def456");
    expect(parentThreadIdOf(grandchild)).toBe(child);
  });

  it("leaves user threads alone", () => {
    expect(isSubagentThreadId("0b6f7c1e-2d3a-4c5b-9e8f-1a2b3c4d5e6f")).toBe(false);
    expect(parentThreadIdOf("sub.")).toBeNull();
  });
});
