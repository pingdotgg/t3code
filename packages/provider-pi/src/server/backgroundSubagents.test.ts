import { describe, expect, it } from "@effect/vitest";
import { piBackgroundSubagentEntryUpdate } from "./backgroundSubagents.ts";

const data = { version: 1, id: "sa-1", toolCallId: "spawn-1", status: "running" };
const entry = { type: "custom", customType: "t3-subagent", data };

describe("Pi subagent lifecycle entries", () => {
  it("accepts versioned lifecycle metadata without parsing tool output", () => {
    expect(piBackgroundSubagentEntryUpdate(entry)).toEqual(data);
    expect(
      piBackgroundSubagentEntryUpdate({
        ...entry,
        data: { ...data, status: "completed", progress: null, result: "## Findings\nPassed" },
      }),
    ).toEqual({ ...data, status: "completed", progress: null, result: "## Findings\nPassed" });
  });

  it("ignores unrelated entries, unknown versions and malformed identities or statuses", () => {
    for (const invalid of [
      null,
      {},
      { ...entry, type: "message" },
      { ...entry, customType: "subagent-result" },
      ...[{ version: 2 }, { id: "" }, { toolCallId: "" }, { status: "done" }, { result: {} }].map(
        (patch) => ({ ...entry, data: { ...data, ...patch } }),
      ),
    ])
      expect(piBackgroundSubagentEntryUpdate(invalid)).toBeNull();
  });

  it("bounds display fields and preserves explicit clears", () => {
    const decoded = piBackgroundSubagentEntryUpdate({
      ...entry,
      data: {
        ...data,
        title: "t".repeat(1000),
        prompt: "p".repeat(20000),
        model: "m".repeat(1000),
        progress: "g".repeat(1000),
        result: "r".repeat(20000),
      },
    });
    expect(decoded?.title?.length).toBe(160);
    expect(decoded?.prompt?.length).toBe(10000);
    expect(decoded?.model?.length).toBe(512);
    expect(decoded?.progress?.length).toBe(200);
    expect(decoded?.result?.length).toBe(10000);
    expect(
      piBackgroundSubagentEntryUpdate({
        ...entry,
        data: { ...data, progress: null, result: null, model: null },
      }),
    ).toEqual({ ...data, progress: null, result: null, model: null });
  });
});
