import { ProviderInstanceId, type ModelSelection } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  antigravityTerminalStatus,
  buildAntigravityTurnArgs,
  decodeAntigravityLine,
  normalizeAntigravityConversationId,
  parseAntigravityModels,
  resolveAntigravityModel,
} from "./AntigravityCli.ts";

const selection = (model: string, effort?: string): ModelSelection => ({
  instanceId: ProviderInstanceId.make("antigravity"),
  model,
  options: effort ? [{ id: "effort", value: effort }] : [],
});

describe("Antigravity model discovery", () => {
  it("groups current TSV effort variants into one selectable model", () => {
    const models = parseAntigravityModels(
      [
        "gemini-3.6-flash-high\tGemini 3.6 Flash (High)",
        "gemini-3.6-flash-medium\tGemini 3.6 Flash (Medium)",
        "gemini-3.6-flash-low\tGemini 3.6 Flash (Low)",
        "claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)",
      ].join("\n"),
    );

    expect(models.map(({ slug, name }) => ({ slug, name }))).toEqual([
      { slug: "gemini-3.6-flash", name: "Gemini 3.6 Flash" },
      { slug: "claude-sonnet-4-6", name: "Claude Sonnet 4.6 (Thinking)" },
    ]);
    expect(models[0]?.capabilities?.optionDescriptors?.[0]).toMatchObject({
      id: "effort",
      currentValue: "medium",
      options: [{ id: "low" }, { id: "medium", isDefault: true }, { id: "high" }],
    });
  });

  it("resolves a grouped model back to the concrete CLI slug", () => {
    expect(resolveAntigravityModel(selection("gemini-3.6-flash", "high"))).toBe(
      "gemini-3.6-flash-high",
    );
    expect(resolveAntigravityModel(selection("claude-sonnet-4-6"))).toBe("claude-sonnet-4-6");
    expect(resolveAntigravityModel(selection("gemini-3.6-flash"))).toBe("gemini-3.6-flash-medium");
  });
});

describe("Antigravity turn arguments", () => {
  it("starts a new project and applies plan mode, directories, and launch args", () => {
    expect(
      buildAntigravityTurnArgs({
        prompt: "hello",
        modelSelection: selection("gemini-3.6-flash", "medium"),
        conversationId: undefined,
        planMode: true,
        addDirectories: ["/work", "/attachments"],
        launchArgs: '--verbose --theme "dark mode"',
      }),
    ).toEqual([
      "-p",
      "hello",
      "--output-format",
      "stream-json",
      "--dangerously-skip-permissions",
      "--print-timeout",
      "24h",
      "--model",
      "gemini-3.6-flash-medium",
      "--new-project",
      "--mode",
      "plan",
      "--add-dir",
      "/work",
      "--add-dir",
      "/attachments",
      "--verbose",
      "--theme",
      "dark mode",
    ]);
  });

  it("resumes a persisted conversation", () => {
    const args = buildAntigravityTurnArgs({
      prompt: "continue",
      modelSelection: selection("claude-sonnet-4-6"),
      conversationId: "conversation-123",
      planMode: false,
      addDirectories: [],
      launchArgs: "",
    });
    expect(args).toContain("--conversation");
    expect(args).toContain("conversation-123");
    expect(args).not.toContain("--new-project");
  });
});

describe("Antigravity stream decoding", () => {
  it("decodes supported NDJSON and ignores noise", () => {
    expect(decodeAntigravityLine("not json")).toBeUndefined();
    expect(
      decodeAntigravityLine(
        JSON.stringify({
          event: "result",
          result: { conversation_id: "c1", status: "SUCCESS", response: "done" },
        }),
      ),
    ).toMatchObject({ event: "result", result: { conversation_id: "c1" } });
  });

  it("does not replace a resume cursor with AGY's blank failed-result id", () => {
    expect(normalizeAntigravityConversationId("")).toBeUndefined();
    expect(normalizeAntigravityConversationId(" c1 ")).toBe("c1");
  });

  it("maps terminal statuses", () => {
    expect(antigravityTerminalStatus("SUCCESS")).toBe("completed");
    expect(antigravityTerminalStatus("CANCELLED")).toBe("cancelled");
    expect(antigravityTerminalStatus("ERROR")).toBe("failed");
  });
});
