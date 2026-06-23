import { describe, expect, it } from "vite-plus/test";
import { projectEntryText } from "./chatSearch";
import type { TimelineEntry } from "../../session-logic";

function messageEntry(text: string): TimelineEntry {
  return {
    id: "m1",
    kind: "message",
    createdAt: "2026-01-01T00:00:00.000Z",
    message: {
      id: "m1",
      role: "assistant",
      text,
      turnId: null,
      streaming: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  } as TimelineEntry;
}

describe("projectEntryText", () => {
  it("strips inline markdown to plain text", () => {
    const [unit] = projectEntryText(messageEntry("see `auth.ts` in **src**"));
    expect(unit).toEqual({ field: "text", text: "see auth.ts in src" });
  });

  it("keeps code-fence body verbatim", () => {
    const [unit] = projectEntryText(messageEntry("```js\nconst x = 1;\n```"));
    expect(unit?.text).toBe("const x = 1;");
  });

  it("drops link URLs, keeps label", () => {
    const [unit] = projectEntryText(messageEntry("open [auth.ts](http://x/y)"));
    expect(unit?.text).toBe("open auth.ts");
  });

  it("returns [] for empty message text", () => {
    expect(projectEntryText(messageEntry(""))).toEqual([]);
  });
});
