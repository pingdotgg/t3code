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

  it.each([undefined, "", "auto", "default"])("omits unresolved model %s", (model) => {
    const instructions = buildRuntimeInstructions({ harness: "Cursor", model });
    expect(instructions).toContain("through the Cursor harness.");
    expect(instructions).not.toContain("reasoning effort");
  });

  it("appends the message artifact block only while message artifacts are enabled", () => {
    const enabled = buildRuntimeInstructions({ harness: "Codex", messageArtifacts: true });
    expect(enabled).toMatch(/<\/pull_request_linking>\n\n<message_artifacts>\n[^<]*t3-artifact/u);
    expect(enabled.trimEnd().endsWith("</message_artifacts>")).toBe(true);
    for (const disabled of [false, undefined]) {
      const instructions = buildRuntimeInstructions({
        harness: "Codex",
        messageArtifacts: disabled,
      });
      expect(instructions).not.toContain("message_artifacts");
      expect(instructions).not.toContain("t3-artifact");
    }
  });
});
