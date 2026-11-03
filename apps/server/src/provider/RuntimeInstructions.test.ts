import { describe, expect, it } from "vite-plus/test";
import { buildRuntimeInstructions } from "./RuntimeInstructions.ts";

describe("buildRuntimeInstructions", () => {
  it.each(["Claude Code", "Codex", "Cursor", "OpenCode", "Antigravity", "Grok"])(
    "bounds shell batching for %s",
    (harness) => {
      const instructions = buildRuntimeInstructions({ harness });
      const batching = instructions.match(
        /<tool_call_batching>([\s\S]*?)<\/tool_call_batching>/,
      )?.[1];
      expect(batching).toBeDefined();
      expect(batching).toContain("independent read-only shell commands are already known");
      expect(batching).toContain("one shell tool call that runs them sequentially");
      expect(batching).toContain("check each exit status");
      expect(batching).toContain("report failures even when a later command succeeds");

      // Must-say-NO twins: dependencies and privileged work cannot use the read-only shortcut.
      expect(batching).toContain(
        "Use separate calls when an earlier result determines the next command",
      );
      expect(batching).toContain("output needs inspection before continuing");
      expect(batching).toContain(
        "Keep mutations, approval requests, and commands with different permissions in separate calls",
      );
      expect(batching).toContain("Follow the user's instructions and tool safety requirements");
      expect(batching).toContain(
        "starting one subprocess per command still incurs those process starts",
      );
    },
  );

  it("requires explicit registration of every PR and stack layer", () => {
    const instructions = buildRuntimeInstructions({ harness: "Codex" });
    expect(instructions).toContain("When the t3-code MCP server exposes link_pull_request");
    expect(instructions).toContain("with the full PR URL immediately after creating a PR");
    expect(instructions).toContain("For a stack, call it for every layer");
    expect(instructions).toContain("call list_thread_pull_requests and link any PR");
  });

  it("keeps known model and effort metadata on one line", () => {
    expect(
      buildRuntimeInstructions({
        harness: "Codex",
        model: "  custom\nmodel  ",
        reasoningEffort: " high\n",
      }),
    ).toContain("through the Codex harness, as custom model with high reasoning effort.");
  });

  it.each([undefined, "", "auto", "default"])("omits unresolved model %s", (model) => {
    const instructions = buildRuntimeInstructions({ harness: "Cursor", model });
    expect(instructions).toContain("through the Cursor harness.");
    expect(instructions).not.toContain("reasoning effort");
  });
});
