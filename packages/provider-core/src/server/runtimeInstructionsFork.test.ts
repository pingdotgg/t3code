import { describe, expect, it } from "vite-plus/test";
import {
  AGENT_FEEDBACK_INSTRUCTIONS,
  buildRuntimeInstructions,
  PULL_REQUEST_LINKING_INSTRUCTIONS,
  threadHistoryInstructionMode,
} from "./runtimeInstructions.ts";

describe("buildRuntimeInstructions fork blocks", () => {
  it("tells the agent to address and resolve the user's document comments", () => {
    const instructions = buildRuntimeInstructions({ harness: "Codex" });
    expect(instructions).toContain("review comments whose section reads `Document comment <id>`");
    expect(instructions).toContain("call resolve_document_comment with that id");
    expect(instructions).toContain("list_document_comments shows the open ones");
  });

  // Upstream's recorded prompts start with its own text, and replay matches them against ours.
  it("puts Lathe's blocks after upstream's instructions, never inside them", () => {
    const instructions = buildRuntimeInstructions({
      harness: "Kiro",
      model: "claude-sonnet-4.5",
      agentFeedback: "auto",
      threadHistory: "read",
    });
    const upstreamText = `</runtime_info>\n\n${PULL_REQUEST_LINKING_INSTRUCTIONS}\n${AGENT_FEEDBACK_INSTRUCTIONS.auto}`;
    expect(instructions).toContain(upstreamText);
    const afterUpstream = instructions.slice(
      instructions.indexOf(upstreamText) + upstreamText.length,
    );
    expect(afterUpstream.startsWith("\n\n<document_comments>")).toBe(true);
    expect(afterUpstream).toContain("<thread_history>");
  });

  it("omits the thread history block without the capability", () => {
    const instructions = buildRuntimeInstructions({ harness: "Codex" });
    expect(instructions).not.toContain("<thread_history>");
    expect(instructions).not.toContain("read_thread");
  });

  it("includes find_threads in search mode only", () => {
    const read = buildRuntimeInstructions({ harness: "Codex", threadHistory: "read" });
    expect(read).toContain("<thread_history>");
    expect(read).toContain("with read_thread and read_thread_turns. Use them");
    expect(read).not.toContain("find_threads");

    const search = buildRuntimeInstructions({ harness: "Codex", threadHistory: "search" });
    expect(search).toContain("with read_thread, read_thread_turns, and find_threads. Use them");
    expect(search).toContain("When you do, call read_thread before anything else.");
  });

  it("contains no em-dash", () => {
    for (const threadHistory of [undefined, "read", "search"] as const) {
      const text = buildRuntimeInstructions({ harness: "Codex", threadHistory });
      expect(text).not.toContain(String.fromCharCode(0x2014));
    }
  });
});

describe("threadHistoryInstructionMode", () => {
  it("derives the mode from the session capabilities", () => {
    expect(threadHistoryInstructionMode(new Set(["thread-history", "thread-search"]))).toBe(
      "search",
    );
    expect(threadHistoryInstructionMode(new Set(["thread-history", "preview"]))).toBe("read");
    expect(threadHistoryInstructionMode(new Set(["preview", "device"]))).toBeUndefined();
    expect(threadHistoryInstructionMode(undefined)).toBeUndefined();
  });
});
