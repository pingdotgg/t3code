import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { QueueMcpEditInput, QueueMcpListInput } from "./queueMcp.ts";

const decodeEdit = Schema.decodeUnknownSync(QueueMcpEditInput);
const decodeList = Schema.decodeUnknownSync(QueueMcpListInput);

describe("queue MCP contracts", () => {
  it("preserves nonblank prompt whitespace and rejects blank edits", () => {
    expect(decodeEdit({ queuedRunId: "run:queued", text: "  keep indentation\n" }).text).toBe(
      "  keep indentation\n",
    );
    expect(() => decodeEdit({ queuedRunId: "run:queued", text: " \n\t " })).toThrow();
  });

  it("keeps list text pages compact while read remains the detailed path", () => {
    expect(decodeList({ maxCharsPerMessage: 8_000 }).maxCharsPerMessage).toBe(8_000);
    expect(() => decodeList({ maxCharsPerMessage: 8_001 })).toThrow();
  });
});
