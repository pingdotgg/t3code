import { describe, expect, it } from "@effect/vitest";

import { piUsageFormat } from "./usage.ts";

const timestamp = "2026-08-01T10:00:00Z";
const usage = { input: 100, output: 50, cost: { total: 0.25 } };

function parse(lines: readonly unknown[]) {
  const state = piUsageFormat.state!.initial();
  return lines.flatMap((line) => piUsageFormat.parseLine(JSON.stringify(line), state));
}

const assistant = (id: string, provider: string, model: string) => ({
  type: "message",
  id,
  timestamp,
  message: { role: "assistant", provider, model, usage },
});
const compaction = (id: string) => ({ type: "compaction", id, timestamp, usage });
const toolResult = (id: string) => ({
  type: "message",
  id,
  timestamp,
  message: { role: "toolResult", usage },
});

describe("piUsageFormat", () => {
  it("skips pi-ai's faux test provider and keeps real providers", () => {
    const records = parse([
      { type: "session", id: "s1" },
      assistant("a1", "faux", "faux-1"),
      { type: "usage", id: "u1", timestamp, provider: "faux", model: "faux-1", usage },
      assistant("a2", "anthropic", "claude-fable-5"),
    ]);
    expect(records.map((record) => record.model)).toEqual(["anthropic/claude-fable-5"]);
  });

  it("skips summaries a faux model wrote but keeps tool usage", () => {
    const records = parse([
      { type: "session", id: "s1" },
      assistant("a1", "faux", "faux-1"),
      compaction("c1"),
      toolResult("t1"),
      // A new session starts on a real model, so its summaries count again.
      { type: "session", id: "s2" },
      assistant("a2", "anthropic", "claude-fable-5"),
      compaction("c2"),
    ]);
    expect(records.map((record) => [record.sessionId, record.model])).toEqual([
      ["s1", "Tools/summaries"],
      ["s2", "anthropic/claude-fable-5"],
      ["s2", "Tools/summaries"],
    ]);
  });

  it("attributes summaries to the selected model before it answers", () => {
    const modelChange = (provider: string) => ({ type: "model_change", provider, modelId: "m" });
    const records = parse([
      { type: "session", id: "s1" },
      assistant("a1", "anthropic", "claude-fable-5"),
      modelChange("faux"),
      compaction("c1"),
      modelChange("anthropic"),
      compaction("c2"),
    ]);
    expect(records.map((record) => record.dedupeKey)).toEqual([
      JSON.stringify(["pi", "a1", timestamp, "anthropic/claude-fable-5"]),
      JSON.stringify(["pi", "c2", timestamp, "Tools/summaries"]),
    ]);
  });
});
