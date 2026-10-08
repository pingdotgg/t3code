import { describe, expect, it } from "vite-plus/test";
import { buildRuntimeInstructions, ISSUE_LINKING_INSTRUCTIONS } from "./RuntimeInstructions.ts";

describe("buildRuntimeInstructions", () => {
  it("requires explicit registration of every PR and stack layer", () => {
    const instructions = buildRuntimeInstructions({ harness: "Codex" });
    expect(instructions).toContain("When the t3-code MCP server exposes link_pull_request");
    expect(instructions).toContain("with the full PR URL immediately after creating a PR");
    expect(instructions).toContain("For a stack, call it for every layer");
    expect(instructions).toContain("call list_thread_pull_requests and link any PR");
  });

  it.each(["Codex", "Claude Code", "Cursor", "Grok", "OpenCode", "Antigravity"])(
    "links created and requested issues through the available T3 tool in %s",
    (harness) => {
      const instructions = buildRuntimeInstructions({ harness, issueToolsAvailable: true });
      expect(instructions).toContain(`</pull_request_linking>\n\n${ISSUE_LINKING_INSTRUCTIONS}`);
      expect(instructions).toContain("the user asks you to work on an issue");
      expect(instructions).toContain(
        "call link_issue immediately after creating an issue for this thread",
      );
      expect(instructions).toContain(
        "attach that issue to the current thread before starting work",
      );
      expect(instructions).toContain("mcp__t3-code__link_issue or mcp__t3_code__link_issue");
    },
  );

  it.each([false, undefined])("omits issue linking without the capability: %s", (available) => {
    const instructions = buildRuntimeInstructions({
      harness: "Codex",
      issueToolsAvailable: available,
    });
    expect(instructions).not.toContain("<issue_linking>");
    expect(instructions).not.toContain("link_issue");
    expect(instructions).toContain("<pull_request_linking>");
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

  it("names the model by display name and slug when they differ", () => {
    expect(
      buildRuntimeInstructions({ harness: "Codex", model: "gpt-5.4", modelName: "GPT-5.4" }),
    ).toContain("through the Codex harness, as GPT-5.4 (model slug: gpt-5.4).");
    expect(
      buildRuntimeInstructions({ harness: "Codex", model: "my-model", modelName: "my-model" }),
    ).toContain("through the Codex harness, as my-model.");
  });

  it.each([undefined, "", "auto", "default"])("omits unresolved model %s", (model) => {
    const instructions = buildRuntimeInstructions({ harness: "Cursor", model });
    expect(instructions).toContain("through the Cursor harness.");
    expect(instructions).not.toContain("reasoning effort");
  });
});
