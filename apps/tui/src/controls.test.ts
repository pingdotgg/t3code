import { describe, expect, it } from "bun:test";

import type { OrchestrationThread } from "./connection.ts";
import {
  composerControls,
  getReasoningEffort,
  interactionModeLabel,
  runtimeModeLabel,
} from "./controls.ts";

describe("friendly labels", () => {
  it("maps runtime modes to the web's labels", () => {
    expect(runtimeModeLabel("approval-required")).toBe("Supervised");
    expect(runtimeModeLabel("auto-accept-edits")).toBe("Auto-accept edits");
    expect(runtimeModeLabel("full-access")).toBe("Full access");
  });

  it("maps interaction modes to Plan / Build", () => {
    expect(interactionModeLabel("plan")).toBe("Plan");
    expect(interactionModeLabel("default")).toBe("Build");
  });
});

describe("getReasoningEffort", () => {
  it("reads the reasoning option by any of its known ids", () => {
    expect(getReasoningEffort({ options: [{ id: "reasoningEffort", value: "high" }] } as never)).toBe(
      "high",
    );
    expect(getReasoningEffort({ options: [{ id: "effort", value: "max" }] } as never)).toBe("max");
  });

  it("returns null when there is no reasoning option", () => {
    expect(getReasoningEffort({ options: [{ id: "fastMode", value: true }] } as never)).toBeNull();
    expect(getReasoningEffort(null)).toBeNull();
  });
});

describe("composerControls", () => {
  it("Given a thread, then it derives the current control state", () => {
    const detail = {
      interactionMode: "plan",
      runtimeMode: "approval-required",
      modelSelection: { instanceId: "codex", model: "gpt-5", options: [{ id: "effort", value: "high" }] },
    } as unknown as OrchestrationThread;
    expect(composerControls(detail)).toEqual({
      interactionMode: "plan",
      runtimeMode: "approval-required",
      model: "gpt-5",
      reasoning: "high",
    });
  });

  it("Given no thread, then it falls back to Build / full-access", () => {
    expect(composerControls(null)).toEqual({
      interactionMode: "default",
      runtimeMode: "full-access",
      model: null,
      reasoning: null,
    });
  });
});
