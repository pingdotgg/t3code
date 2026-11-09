import { ProviderDriverKind, type ProviderReplayTranscript } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { materializeReplayTranscriptRuntimeInstructions } from "./ReplayRuntimeInstructions.ts";

const sessionId = "session-1";
const prompt = (...texts: ReadonlyArray<string>) => ({
  type: "expect_outbound" as const,
  frame: {
    kind: "request",
    method: "session/prompt",
    params: { sessionId, prompt: texts.map((text) => ({ type: "text", text })) },
  },
});
const promptAnswer = {
  type: "emit_inbound" as const,
  frame: { kind: "response", method: "session/prompt", result: { stopReason: "end_turn" } },
};
const kiroCompact = {
  type: "expect_outbound" as const,
  frame: { kind: "request", method: "_kiro/session/compact", params: { sessionId } },
};
const update = (update: Record<string, unknown>) => ({
  type: "emit_inbound" as const,
  frame: { kind: "notification", method: "session/update", params: { sessionId, update } },
});

/** The last text block of each prompt in the materialized transcript. */
const lastPromptBlocks = (
  entries: ProviderReplayTranscript["entries"],
  driver: "kiro" | "grok" = "kiro",
) =>
  materializeReplayTranscriptRuntimeInstructions(
    { provider: driver, protocol: "acp", version: "1", scenario: "test", entries },
    { driver: ProviderDriverKind.make(driver), model: "auto" },
  ).entries.flatMap((entry) => {
    if (entry.type !== "expect_outbound") return [];
    const frame = entry.frame as {
      readonly method?: string;
      readonly params?: { readonly prompt?: ReadonlyArray<{ readonly text?: string }> };
    };
    return frame.method === "session/prompt" ? [frame.params?.prompt?.at(-1)?.text ?? ""] : [];
  });

/** Whether each prompt in the materialized transcript ends with T3's runtime notes. */
const promptsWithNotes = (
  entries: ProviderReplayTranscript["entries"],
  driver: "kiro" | "grok" = "kiro",
) => lastPromptBlocks(entries, driver).map((text) => text.startsWith("<runtime_info>"));

describe("materializeReplayTranscriptRuntimeInstructions", () => {
  it.each([
    {
      name: "a successful Kiro compaction",
      between: [
        kiroCompact,
        {
          type: "emit_inbound" as const,
          frame: { kind: "response", method: "_kiro/session/compact", result: { success: true } },
        },
      ],
      resend: true,
    },
    {
      name: "a Kiro compaction the agent refused",
      between: [
        kiroCompact,
        {
          type: "emit_inbound" as const,
          frame: { kind: "response", method: "_kiro/session/compact", result: { success: false } },
        },
      ],
      resend: false,
    },
    {
      name: "a failed Kiro compaction",
      between: [
        kiroCompact,
        {
          type: "emit_inbound" as const,
          frame: {
            kind: "response",
            method: "_kiro/session/compact",
            error: { code: -32603, message: "failed" },
          },
        },
      ],
      resend: false,
    },
    {
      name: "a completed compaction the agent reports",
      between: [
        update({ sessionUpdate: "compaction_update", compactionId: "c1", status: "completed" }),
      ],
      resend: true,
    },
    {
      name: "a Kiro compaction answered without success",
      between: [
        kiroCompact,
        {
          type: "emit_inbound" as const,
          frame: { kind: "response", method: "_kiro/session/compact", result: null },
        },
      ],
      resend: false,
    },
    {
      name: "a repeated patch of a compaction already resent for",
      between: [
        update({ sessionUpdate: "compaction_update", compactionId: "c1", status: "completed" }),
        prompt("middle"),
        promptAnswer,
        update({
          sessionUpdate: "compaction_update",
          compactionId: "c1",
          status: "completed",
          summary: [{ type: "text", text: "Summary" }],
        }),
      ],
      resend: false,
    },
    {
      name: "a runtime restart without session/close",
      between: [
        {
          type: "expect_outbound" as const,
          frame: { kind: "request", method: "initialize", params: { protocolVersion: 1 } },
        },
      ],
      resend: true,
    },
    {
      name: "a compaction still in progress",
      between: [
        update({ sessionUpdate: "compaction_update", compactionId: "c1", status: "in_progress" }),
      ],
      resend: false,
    },
    {
      name: "a successful /compact prompt to Grok",
      between: [prompt("/compact keep the plan"), promptAnswer],
      driver: "grok" as const,
      resend: true,
    },
    {
      name: "a /compact prompt Kiro takes as chat",
      between: [prompt("/compact keep the plan"), promptAnswer],
      resend: false,
    },
  ])("after $name, resend is $resend", ({ between, resend, driver }) => {
    const notes = promptsWithNotes(
      [prompt("first"), promptAnswer, ...between, prompt("second"), promptAnswer],
      driver,
    );
    expect(notes.at(0)).toBe(true);
    expect(notes.at(-1)).toBe(resend);
  });
  it("resends after a compaction that completes while the instructed prompt runs", () => {
    const notes = promptsWithNotes([
      prompt("first"),
      update({ sessionUpdate: "compaction_update", compactionId: "c1", status: "completed" }),
      promptAnswer,
      prompt("second"),
      promptAnswer,
    ]);
    expect(notes).toEqual([true, true]);
  });

  it("resends after a turn that completes with a compaction still open, and after its real end", () => {
    const notes = promptsWithNotes([
      prompt("first"),
      update({ sessionUpdate: "compaction_update", compactionId: "c1", status: "in_progress" }),
      promptAnswer,
      prompt("second"),
      promptAnswer,
      update({ sessionUpdate: "compaction_update", compactionId: "c1", status: "completed" }),
      prompt("third"),
      promptAnswer,
    ]);
    expect(notes).toEqual([true, true, true]);
  });

  it("resends after a compaction that a later, note-free turn leaves open", () => {
    const notes = promptsWithNotes([
      prompt("first"),
      promptAnswer,
      prompt("second"),
      update({ sessionUpdate: "compaction_update", compactionId: "c1", status: "in_progress" }),
      promptAnswer,
      prompt("third"),
      promptAnswer,
    ]);
    expect(notes).toEqual([true, false, true]);
  });

  it("resends the first model's notes after switching back from a recorded second model", () => {
    const otherModel = "<runtime_info>Other model notes</runtime_info>";
    const [onA, onB, backOnA] = lastPromptBlocks([
      prompt("on A"),
      promptAnswer,
      prompt("on B", otherModel),
      promptAnswer,
      prompt("back on A"),
      promptAnswer,
    ]);
    expect(onA).toMatch(/^<runtime_info>/);
    expect(onB).toBe(otherModel);
    expect(backOnA).toBe(onA);
  });
});
