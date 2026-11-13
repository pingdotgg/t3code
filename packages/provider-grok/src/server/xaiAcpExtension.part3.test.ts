import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import { xAiPromptCompleteFromSessionUpdate } from "./xaiAcpExtension.ts";

describe("xAiPromptCompleteFromSessionUpdate", () => {
  it("ignores non-turn updates and task-completed prompt ids", () => {
    expect(
      xAiPromptCompleteFromSessionUpdate({
        sessionId: "root",
        update: { sessionUpdate: "hook_execution", prompt_id: "t3-xai-prompt-1" },
      }),
    ).toBeNull();
    expect(
      xAiPromptCompleteFromSessionUpdate({
        sessionId: "root",
        update: {
          sessionUpdate: "turn_completed",
          prompt_id: "task-completed-call-abc",
          stop_reason: "end_turn",
        },
      }),
    ).toBeNull();
    expect(
      xAiPromptCompleteFromSessionUpdate({
        sessionId: "root",
        update: { sessionUpdate: "turn_completed", stop_reason: "end_turn" },
      }),
    ).toBeNull();
  });
});
