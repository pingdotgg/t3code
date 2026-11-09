import { ProviderDriverKind, type ProviderReplayTranscript } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { materializeReplayTranscriptRuntimeInstructions } from "./ReplayRuntimeInstructions.ts";

const sessionId = "session-1";
const prompt = (text: string) => ({
  type: "expect_outbound" as const,
  frame: {
    kind: "request",
    method: "session/prompt",
    params: { sessionId, prompt: [{ type: "text", text }] },
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

/** Whether each prompt in the materialized transcript ends with T3's runtime notes. */
const promptsWithNotes = (
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
    return frame.method === "session/prompt"
      ? [frame.params?.prompt?.at(-1)?.text?.startsWith("<runtime_info>") === true]
      : [];
  });

describe("materializeReplayTranscriptRuntimeInstructions", () => {
  it.each([
    {
      name: "a successful Kiro compaction",
      between: [
        kiroCompact,
        {
          type: "emit_inbound" as const,
          frame: { kind: "response", method: "_kiro/session/compact", result: null },
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
});
