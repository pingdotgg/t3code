import { describe, expect, it } from "@effect/vitest";
import type { HermesGatewayHistoryMessage } from "@t3tools/contracts";
import {
  HERMES_IMPORT_MAX_OUTPUT_CHARS,
  HERMES_IMPORT_TRUNCATION_MARKER,
  extractHermesReasoningText,
  hydrateImportedHermesActivities,
  isSyntheticHermesTranscriptRow,
  normalizeImportedHermesUserText,
  parseHermesToolArguments,
  truncateHermesToolOutput,
} from "./HermesImportHydration.ts";

function assistantCall(input: {
  readonly id: string;
  readonly name: string;
  readonly args: string;
  readonly text?: string;
}): HermesGatewayHistoryMessage {
  return {
    role: "assistant",
    text: input.text ?? "",
    tool_calls: [{ id: input.id, function: { name: input.name, arguments: input.args } }],
  };
}

function toolResult(input: {
  readonly callId: string;
  readonly text: string;
}): HermesGatewayHistoryMessage {
  return { role: "tool", text: input.text, tool_call_id: input.callId };
}

describe("parseHermesToolArguments", () => {
  it("parses valid JSON into structured input", () => {
    expect(parseHermesToolArguments('{"command":"ls -la"}')).toEqual({ command: "ls -la" });
  });

  it("preserves malformed payloads as raw strings without throwing", () => {
    expect(parseHermesToolArguments("{not json")).toEqual({ raw: "{not json" });
  });

  it("treats empty and missing arguments as empty input", () => {
    expect(parseHermesToolArguments("")).toEqual({});
    expect(parseHermesToolArguments(undefined)).toEqual({});
  });
});

describe("truncateHermesToolOutput", () => {
  it("bounds oversized output with an explicit marker", () => {
    const oversized = "x".repeat(HERMES_IMPORT_MAX_OUTPUT_CHARS + 100);
    const truncated = truncateHermesToolOutput(oversized);
    expect(truncated.endsWith(HERMES_IMPORT_TRUNCATION_MARKER)).toBe(true);
    expect(truncated.length).toBe(
      HERMES_IMPORT_MAX_OUTPUT_CHARS + HERMES_IMPORT_TRUNCATION_MARKER.length,
    );
  });

  it("leaves bounded output untouched", () => {
    expect(truncateHermesToolOutput("small")).toBe("small");
  });
});

describe("extractHermesReasoningText", () => {
  it("reads plain reasoning strings", () => {
    expect(extractHermesReasoningText({ role: "assistant", reasoning: "thinking..." })).toBe(
      "thinking...",
    );
  });

  it("reads structured reasoning arrays", () => {
    expect(
      extractHermesReasoningText({
        role: "assistant",
        reasoning_details: [{ text: "step one" }, { text: "step two" }],
      }),
    ).toBe("step one\nstep two");
  });

  it("returns empty for messages without reasoning", () => {
    expect(extractHermesReasoningText({ role: "assistant", text: "hi" })).toBe("");
  });
});

describe("normalizeImportedHermesUserText", () => {
  it("strips shared-session sender prefixes", () => {
    expect(normalizeImportedHermesUserText("[maria] hello there")).toBe("hello there");
  });

  it("strips mirror delivery prefixes", () => {
    expect(normalizeImportedHermesUserText("[Delivered from another session] the update")).toBe(
      "the update",
    );
  });

  it("keeps only the addressed message from channel backfill blocks", () => {
    expect(
      normalizeImportedHermesUserText("older channel chatter\n\n[New message]\n[maria] what now?"),
    ).toBe("what now?");
  });

  it("keeps only the addressed message from observed group context", () => {
    expect(
      normalizeImportedHermesUserText(
        [
          "[Observed Telegram group context - context only, not requests]",
          "someone: unrelated",
          "",
          "[Current addressed message - answer only this unless it explicitly asks you to use the observed context]",
          "the real ask",
        ].join("\n"),
      ),
    ).toBe("the real ask");
  });

  it("reduces attachment envelopes to compact markers", () => {
    expect(
      normalizeImportedHermesUserText(
        "[User sent an image: https://cdn.example/img.png]\ncheck this out",
      ),
    ).toBe("[Attachment: https://cdn.example/img.png]\ncheck this out");
    expect(
      normalizeImportedHermesUserText(
        "[The user sent a document: 'report.pdf'. It is saved at: /tmp/report.pdf. Use tools to read it.]",
      ),
    ).toBe("[Attachment: report.pdf]");
  });

  it("does not treat transport markers as sender names", () => {
    expect(normalizeImportedHermesUserText("[User sent a file: notes.txt]")).toBe(
      "[Attachment: notes.txt]",
    );
  });

  it("leaves plain messages untouched", () => {
    expect(normalizeImportedHermesUserText("just a normal [bracketed later] message")).toBe(
      "just a normal [bracketed later] message",
    );
  });
});

describe("hydrateImportedHermesActivities", () => {
  it("pairs tool calls with results into completed activities", () => {
    const { activities, hiddenOrdinals } = hydrateImportedHermesActivities([
      { role: "user", text: "run it" },
      assistantCall({ id: "call-1", name: "custom_tool", args: '{"value":1}' }),
      toolResult({ callId: "call-1", text: "done" }),
    ]);
    expect(activities).toHaveLength(1);
    const activity = activities[0]!;
    expect(activity.kind).toBe("dynamic_tool");
    if (activity.kind === "dynamic_tool") {
      expect(activity.toolName).toBe("custom_tool");
      expect(activity.input).toEqual({ value: 1 });
      expect(activity.output).toBe("done");
      expect(activity.status).toBe("completed");
    }
    // The bare-call assistant row and the tool-result row are subsumed.
    expect(hiddenOrdinals).toEqual(new Set([1, 2]));
  });

  it("maps terminal tools to command executions", () => {
    const { activities } = hydrateImportedHermesActivities([
      assistantCall({ id: "c", name: "terminal", args: '{"command":"git status"}' }),
      toolResult({ callId: "c", text: "clean" }),
    ]);
    expect(activities[0]).toMatchObject({
      kind: "command_execution",
      input: "git status",
      output: "clean",
      status: "completed",
    });
  });

  it("maps file tools to file changes", () => {
    const { activities } = hydrateImportedHermesActivities([
      assistantCall({ id: "c", name: "edit_file", args: '{"path":"src/app.ts"}' }),
      toolResult({ callId: "c", text: "ok" }),
    ]);
    expect(activities[0]).toMatchObject({ kind: "file_change", fileName: "src/app.ts" });
  });

  it("maps web search tools to web searches", () => {
    const { activities } = hydrateImportedHermesActivities([
      assistantCall({ id: "c", name: "web_search", args: '{"query":"effect ts"}' }),
      toolResult({ callId: "c", text: "results" }),
    ]);
    expect(activities[0]).toMatchObject({ kind: "web_search", patterns: ["effect ts"] });
  });

  it("keeps unmatched calls as stopped activities", () => {
    const { activities } = hydrateImportedHermesActivities([
      assistantCall({ id: "orphan", name: "terminal", args: '{"command":"sleep 100"}' }),
    ]);
    expect(activities[0]).toMatchObject({
      kind: "command_execution",
      input: "sleep 100",
      status: "cancelled",
    });
  });

  it("rehydrates reasoning as an activity", () => {
    const { activities } = hydrateImportedHermesActivities([
      { role: "assistant", text: "answer", reasoning: "chain of thought" },
    ]);
    expect(activities[0]).toMatchObject({ kind: "reasoning", text: "chain of thought" });
  });

  it("preserves stock normalized tool rows as generic activities", () => {
    const { activities, hiddenOrdinals } = hydrateImportedHermesActivities([
      { role: "tool", name: "notes", context: "saved a note" },
    ]);
    expect(activities[0]).toMatchObject({
      kind: "dynamic_tool",
      toolName: "notes",
      input: { context: "saved a note" },
    });
    expect(hiddenOrdinals.has(0)).toBe(true);
  });

  it("suppresses synthetic transcript rows", () => {
    const synthetic: HermesGatewayHistoryMessage = {
      role: "user",
      text: "[delegation completed]",
      display_kind: "async_delegation_complete",
    };
    expect(isSyntheticHermesTranscriptRow(synthetic)).toBe(true);
    const { activities, hiddenOrdinals } = hydrateImportedHermesActivities([synthetic]);
    expect(activities).toHaveLength(0);
    expect(hiddenOrdinals.has(0)).toBe(true);
  });

  it("suppresses gateway-forged delegation completion notifications", () => {
    const { activities, hiddenOrdinals } = hydrateImportedHermesActivities([
      { role: "user", text: "[ASYNC DELEGATION COMPLETE — deleg-42]\nResult summary..." },
      { role: "user", text: '[IMPORTANT: Background process 7 matched watch pattern "done"]' },
    ]);
    expect(activities).toHaveLength(0);
    expect(hiddenOrdinals).toEqual(new Set([0, 1]));
  });

  it("keeps visible assistant text rows in the transcript while extracting their calls", () => {
    const { hiddenOrdinals } = hydrateImportedHermesActivities([
      assistantCall({ id: "c", name: "terminal", args: '{"command":"ls"}', text: "running ls" }),
      toolResult({ callId: "c", text: "files" }),
    ]);
    expect(hiddenOrdinals.has(0)).toBe(false);
    expect(hiddenOrdinals.has(1)).toBe(true);
  });

  it("is deterministic: stable keys and history-ordered output", () => {
    const history: ReadonlyArray<HermesGatewayHistoryMessage> = [
      assistantCall({ id: "b", name: "terminal", args: '{"command":"two"}' }),
      toolResult({ callId: "b", text: "2" }),
      { role: "assistant", text: "", reasoning: "later thought" },
    ];
    const first = hydrateImportedHermesActivities(history);
    const second = hydrateImportedHermesActivities(history);
    expect(first).toEqual(second);
    expect(first.activities.map((activity) => activity.ordinal)).toEqual(
      first.activities.map((activity) => activity.ordinal).sort((a, b) => a - b),
    );
  });

  it("handles malformed tool_call payload shapes without throwing", () => {
    const { activities } = hydrateImportedHermesActivities([
      {
        role: "assistant",
        text: "",
        tool_calls: [null, "junk", { function: {} }, { id: "x", function: { name: "t" } }],
      },
    ]);
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({ kind: "dynamic_tool", status: "cancelled" });
  });
});
