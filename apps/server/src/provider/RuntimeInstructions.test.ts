import { describe, expect, it } from "vite-plus/test";
import { buildRuntimeInstructions } from "./RuntimeInstructions.ts";

describe("buildRuntimeInstructions", () => {
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

  it("describes computer use only when the cua-driver server is attached", () => {
    const withCua = buildRuntimeInstructions({ harness: "Claude Code", computerUse: true });
    expect(withCua).toContain("<computer_use>");
    expect(withCua).toContain('defaults to delivery_mode "background"');
    expect(withCua).toContain("leave the desktop as you found it");
    expect(buildRuntimeInstructions({ harness: "Claude Code" })).not.toContain("<computer_use>");
    expect(buildRuntimeInstructions({ harness: "Claude Code", computerUse: false })).not.toContain(
      "cua-driver",
    );
  });

  it.each([undefined, "", "auto", "default"])("omits unresolved model %s", (model) => {
    const instructions = buildRuntimeInstructions({ harness: "Cursor", model });
    expect(instructions).toContain("through the Cursor harness.");
    expect(instructions).not.toContain("reasoning effort");
  });
});
