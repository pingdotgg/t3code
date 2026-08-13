import { EventId, TurnId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { GLYPH_POSES, lerpPose, poseDistance } from "./poses.ts";
import {
  classifyToolHint,
  resolveAgentGlyphStatus,
  resolveLastToolHint,
  type AgentGlyphStatusInput,
} from "./status.ts";

function input(overrides: Partial<AgentGlyphStatusInput> = {}): AgentGlyphStatusInput {
  return {
    sessionStatus: null,
    latestTurnState: null,
    isPreparing: false,
    hasPendingApproval: false,
    hasPendingUserInput: false,
    hasThreadError: false,
    reviewFocused: false,
    lastTool: null,
    ...overrides,
  };
}

function activity(overrides: {
  kind?: string;
  summary?: string;
  tone?: OrchestrationThreadActivity["tone"];
  payload?: Record<string, unknown>;
  turnId?: string;
}): OrchestrationThreadActivity {
  return {
    id: EventId.make(`evt-${Math.random().toString(16).slice(2)}`),
    tone: overrides.tone ?? "tool",
    kind: overrides.kind ?? "tool.updated",
    summary: overrides.summary ?? "Edit file",
    payload: overrides.payload ?? { itemType: "file_change", status: "inProgress" },
    turnId: TurnId.make(overrides.turnId ?? "turn-1"),
    createdAt: "2026-08-13T12:00:00.000Z",
  };
}

describe("classifyToolHint", () => {
  it("maps file edits to work", () => {
    expect(classifyToolHint({ itemType: "file_change" })).toBe("work");
    expect(classifyToolHint({ toolTitle: "ApplyPatch" })).toBe("work");
  });

  it("maps test commands to test and screenshots to ui-test", () => {
    expect(classifyToolHint({ command: "vp test run status.test.ts" })).toBe("test");
    expect(classifyToolHint({ command: "vitest" })).toBe("test");
    expect(classifyToolHint({ itemType: "image_view", label: "screenshot" })).toBe("ui-test");
    expect(classifyToolHint({ toolTitle: "computer-use" })).toBe("ui-test");
  });

  it("maps failed tools to debug", () => {
    expect(classifyToolHint({ itemType: "command_execution", toolLifecycleStatus: "failed" })).toBe(
      "debug",
    );
  });
});

describe("resolveAgentGlyphStatus", () => {
  it("stays idle when the session is not running", () => {
    expect(resolveAgentGlyphStatus(input({ sessionStatus: "ready" }))).toBe("idle");
    expect(
      resolveAgentGlyphStatus(
        input({
          sessionStatus: "ready",
          lastTool: { itemType: "file_change", toolLifecycleStatus: "inProgress" },
        }),
      ),
    ).toBe("idle");
  });

  it("thinks when running with no tool, works when the last tool is a file edit", () => {
    expect(resolveAgentGlyphStatus(input({ sessionStatus: "running" }))).toBe("think");
    expect(
      resolveAgentGlyphStatus(
        input({
          sessionStatus: "running",
          lastTool: { itemType: "file_change" },
        }),
      ),
    ).toBe("work");
  });

  it("waits for the user before showing work", () => {
    expect(
      resolveAgentGlyphStatus(
        input({
          sessionStatus: "running",
          hasPendingUserInput: true,
          lastTool: { itemType: "file_change" },
        }),
      ),
    ).toBe("wait");
  });

  it("uses review only when the session is settled and the diff panel is focused", () => {
    expect(resolveAgentGlyphStatus(input({ sessionStatus: "ready", reviewFocused: true }))).toBe(
      "review",
    );
    expect(resolveAgentGlyphStatus(input({ sessionStatus: "running", reviewFocused: true }))).toBe(
      "think",
    );
  });

  it("surfaces turn errors as debug", () => {
    expect(resolveAgentGlyphStatus(input({ latestTurnState: "error" }))).toBe("debug");
    expect(resolveAgentGlyphStatus(input({ hasThreadError: true }))).toBe("debug");
  });

  it("treats send/connect as think without requiring a running session", () => {
    expect(resolveAgentGlyphStatus(input({ isPreparing: true }))).toBe("think");
  });
});

describe("resolveLastToolHint", () => {
  it("prefers the in-progress tool on the current turn", () => {
    const hint = resolveLastToolHint(
      [
        activity({
          summary: "old write",
          payload: { itemType: "file_change", status: "completed" },
        }),
        activity({
          summary: "vitest",
          payload: { itemType: "command_execution", status: "inProgress", command: "vitest" },
        }),
      ],
      TurnId.make("turn-1"),
    );
    expect(hint?.itemType).toBe("command_execution");
    expect(hint?.toolLifecycleStatus).toBe("inProgress");
  });
});

describe("lerpPose", () => {
  it("morphs numbers instead of swapping poses", () => {
    const mid = lerpPose(GLYPH_POSES.idle, GLYPH_POSES.work, 0.5);
    expect(mid.groupRotate).toBeCloseTo(GLYPH_POSES.work.groupRotate / 2);
    expect(poseDistance(mid, GLYPH_POSES.idle)).toBeGreaterThan(0);
    expect(poseDistance(mid, GLYPH_POSES.work)).toBeGreaterThan(0);
  });
});
