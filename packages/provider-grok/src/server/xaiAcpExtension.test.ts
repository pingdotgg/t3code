import { it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { describe, expect } from "vite-plus/test";
import {
  XAiExitPlanModeRequest,
  XAI_EMPTY_PLAN_MARKDOWN,
  isGrokPlanMarkdownPath,
  extractXAiExitPlanMarkdown,
  extractGrokPlanMarkdownFromToolCallData,
} from "./xaiAcpExtension.ts";

describe("Grok exit_plan_mode capture (#8358)", () => {
  it("extracts plan markdown from exit_plan_mode payloads", () => {
    const decode = Schema.decodeUnknownSync(XAiExitPlanModeRequest);
    const direct = decode({
      sessionId: "session-1",
      toolCallId: "exit-1",
      planContent: "# Plan\n\n- do the thing\n",
    });
    expect(extractXAiExitPlanMarkdown(direct)).toBe("# Plan\n\n- do the thing");

    const wrapped = decode({
      method: "_x.ai/exit_plan_mode",
      params: {
        sessionId: "session-1",
        toolCallId: "exit-1",
        planContent: null,
      },
    });
    expect(extractXAiExitPlanMarkdown(wrapped, "  # fallback plan  ")).toBe("# fallback plan");
    expect(extractXAiExitPlanMarkdown(wrapped, "")).toBe(XAI_EMPTY_PLAN_MARKDOWN);
    expect(extractXAiExitPlanMarkdown(wrapped)).toBe(XAI_EMPTY_PLAN_MARKDOWN);
  });
  it("identifies Grok plan.md paths and extracts markdown from tool call data", () => {
    const home = "/home/ada";
    const linuxHost = { platform: "linux" as const, environment: {}, homeDirectory: home };
    const windowsHost = { platform: "win32" as const, environment: {}, homeDirectory: home };
    const grokHomeHost = {
      platform: "linux" as const,
      environment: { GROK_HOME: "/opt/grok-data" },
      homeDirectory: home,
    };
    const sessionPlan = `${home}/.grok/sessions/abc/plan.md`;
    const nestedSessionPlan = `${home}/.grok/sessions/%2Fhome%2Fproj/019fd20e-c563-70a0-b801-a6bc51815a9b/plan.md`;
    expect(isGrokPlanMarkdownPath(sessionPlan, linuxHost)).toBe(true);
    expect(isGrokPlanMarkdownPath(nestedSessionPlan, linuxHost)).toBe(true);
    expect(isGrokPlanMarkdownPath("~/.grok/sessions/abc/plan.md", linuxHost)).toBe(true);
    expect(isGrokPlanMarkdownPath("/tmp/mock-home/.grok/sessions/sess/plan.md", linuxHost)).toBe(
      true,
    );
    expect(isGrokPlanMarkdownPath("/home/other/.grok/sessions/sess/plan.md", linuxHost)).toBe(true);
    expect(isGrokPlanMarkdownPath("/HOME/other/.grok/sessions/sess/plan.md", linuxHost)).toBe(
      false,
    );
    expect(isGrokPlanMarkdownPath("C:/Users/other/.grok/sessions/id/plan.md", windowsHost)).toBe(
      true,
    );
    expect(isGrokPlanMarkdownPath("c:/users/OTHER/.GROK/SESSIONS/id/PLAN.MD", windowsHost)).toBe(
      true,
    );
    expect(
      isGrokPlanMarkdownPath("C:\\Users\\other\\.grok\\sessions\\id\\plan.md", windowsHost),
    ).toBe(true);
    expect(isGrokPlanMarkdownPath("/opt/grok-data/sessions/sess/plan.md", grokHomeHost)).toBe(true);
    expect(
      isGrokPlanMarkdownPath("/OPT/GROK-DATA/sessions/sess/plan.md", {
        platform: "win32",
        environment: { GROK_HOME: "/opt/grok-data" },
        homeDirectory: home,
      }),
    ).toBe(true);
    expect(isGrokPlanMarkdownPath("/OPT/GROK-DATA/sessions/sess/plan.md", grokHomeHost)).toBe(
      false,
    );
    expect(isGrokPlanMarkdownPath("plan.md", linuxHost)).toBe(false);
    expect(isGrokPlanMarkdownPath("/repo/docs/plan.md", linuxHost)).toBe(false);
    expect(isGrokPlanMarkdownPath("/tmp/other.md", linuxHost)).toBe(false);
    expect(isGrokPlanMarkdownPath("/repo/.grok/sessions/example/plan.md", linuxHost)).toBe(false);
    expect(
      isGrokPlanMarkdownPath(`${home}/project/.grok/sessions/example/plan.md`, linuxHost),
    ).toBe(false);
    expect(
      isGrokPlanMarkdownPath("/home/other/.grok/sessions/../../project/plan.md", linuxHost),
    ).toBe(false);
    expect(
      isGrokPlanMarkdownPath("/home/other/.grok/sessions/foo/../../../project/plan.md", linuxHost),
    ).toBe(false);

    expect(
      extractGrokPlanMarkdownFromToolCallData(
        {
          rawInput: {
            file_path: sessionPlan,
            content: "# From rawInput\n\n- a\n",
          },
        },
        linuxHost,
      ),
    ).toBe("# From rawInput\n\n- a");

    expect(
      extractGrokPlanMarkdownFromToolCallData(
        {
          content: [
            {
              type: "diff",
              path: sessionPlan,
              oldText: "",
              newText: "# From diff\n\n- b\n",
            },
          ],
        },
        linuxHost,
      ),
    ).toBe("# From diff\n\n- b");

    expect(
      extractGrokPlanMarkdownFromToolCallData(
        {
          rawInput: { file_path: sessionPlan, content: "" },
          content: [
            {
              type: "diff",
              path: sessionPlan,
              oldText: "",
              newText: "# From diff after empty rawInput\n",
            },
          ],
        },
        linuxHost,
      ),
    ).toBe("# From diff after empty rawInput");

    expect(
      extractGrokPlanMarkdownFromToolCallData(
        {
          rawInput: { file_path: sessionPlan, content: "" },
        },
        linuxHost,
      ),
    ).toBe("");

    expect(
      extractGrokPlanMarkdownFromToolCallData(
        {
          content: [{ type: "diff", path: sessionPlan, oldText: "# old", newText: "" }],
        },
        linuxHost,
      ),
    ).toBe("");

    expect(
      extractGrokPlanMarkdownFromToolCallData(
        {
          rawInput: { file_path: "/tmp/readme.md", content: "nope" },
        },
        linuxHost,
      ),
    ).toBeUndefined();

    expect(
      extractGrokPlanMarkdownFromToolCallData(
        {
          rawInput: { file_path: "/repo/docs/plan.md", content: "# Project plan\n" },
        },
        linuxHost,
      ),
    ).toBeUndefined();
  });
});
