import { describe, expect, it } from "vite-plus/test";

import { summarizeCodexExecOutput } from "./CodexImageCli.ts";

describe("summarizeCodexExecOutput", () => {
  it("prefers the last JSONL agent message over raw stdout", () => {
    const stdout = [
      `{"type":"thread.started"}`,
      `{"type":"item.completed","item":{"type":"agent_message","text":"Could not call image_gen."}}`,
    ].join("\n");
    expect(summarizeCodexExecOutput(stdout, "noise")).toBe("Could not call image_gen.");
  });

  it("falls back to stderr when JSONL has no message", () => {
    expect(summarizeCodexExecOutput("{not-json", "codex: feature disabled")).toBe(
      "codex: feature disabled",
    );
  });
});
