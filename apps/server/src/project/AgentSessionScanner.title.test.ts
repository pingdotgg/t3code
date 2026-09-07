import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";

import * as AgentSessionScanner from "./AgentSessionScanner.ts";

const parseCodexTranscript = (records: ReadonlyArray<unknown>) =>
  AgentSessionScanner.parseAgentSessionTranscript({
    contents: records.map((record) => JSON.stringify(record)).join("\n"),
    source: "codex",
    providerInstanceId: ProviderInstanceId.make("codex"),
    fallbackSessionId: "fallback",
    lastActiveAtMs: Date.parse("2026-08-25T08:00:00.000Z"),
  });

describe("Codex imported thread titles", () => {
  it("prefers a saved session title", () => {
    const thread = parseCodexTranscript([
      { type: "session_meta", payload: { id: "codex-session", name: "Saved task title" } },
      { type: "event_msg", payload: { type: "user_message", message: "Fallback prompt title" } },
    ]);

    expect(thread?.title).toBe("Saved task title");
  });

  it("uses threadName when a saved name is unavailable", () => {
    const thread = parseCodexTranscript([
      { type: "session_meta", payload: { id: "codex-session", threadName: "Saved thread name" } },
      { type: "event_msg", payload: { type: "user_message", message: "Fallback prompt title" } },
    ]);

    expect(thread?.title).toBe("Saved thread name");
  });

  it("skips a recommended plugins preamble while preserving the imported message", () => {
    const prompt =
      "<recommended_plugins>\n<plugin>Documents</plugin>\n</recommended_plugins>\n\nFix the imported task title.";
    const thread = parseCodexTranscript([
      { type: "session_meta", payload: { id: "codex-session" } },
      { type: "event_msg", payload: { type: "user_message", message: prompt } },
    ]);

    expect(thread?.title).toBe("Fix the imported task title.");
    expect(thread?.messages.map((message) => message.text)).toEqual([prompt]);
  });

  it("skips user instructions while preserving the imported message", () => {
    const prompt =
      "<user_instructions>\nAlways inspect the repository first.\n</user_instructions>\n\nFix the imported task title.";
    const thread = parseCodexTranscript([
      { type: "session_meta", payload: { id: "codex-session" } },
      { type: "event_msg", payload: { type: "user_message", message: prompt } },
    ]);

    expect(thread?.title).toBe("Fix the imported task title.");
    expect(thread?.messages.map((message) => message.text)).toEqual([prompt]);
  });

  it("skips an environment context preamble in the same user message", () => {
    const prompt =
      "<environment_context>\n<cwd>/tmp/project</cwd>\n</environment_context>\n\nCreate a useful project.";
    const thread = parseCodexTranscript([
      { type: "session_meta", payload: { id: "codex-session" } },
      { type: "event_msg", payload: { type: "user_message", message: prompt } },
    ]);

    expect(thread?.title).toBe("Create a useful project.");
    expect(thread?.messages.map((message) => message.text)).toEqual([prompt]);
  });

  it("skips a standalone context message and derives the title from the next user message", () => {
    const context = "<environment_context>\n<cwd>/tmp/project</cwd>\n</environment_context>";
    const thread = parseCodexTranscript([
      { type: "session_meta", payload: { id: "codex-session" } },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: context }],
        },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Initialize Git and add a README." }],
        },
      },
    ]);

    expect(thread?.title).toBe("Initialize Git and add a README.");
    expect(thread?.messages.map((message) => message.text)).toEqual([
      context,
      "Initialize Git and add a README.",
    ]);
  });
});
