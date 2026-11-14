import { describe, expect, it } from "vite-plus/test";

import { previewPromptText } from "./previewPromptText";

describe("browser prompt response", () => {
  const prompt = { type: "prompt" as const, message: "Your name?", defaultValue: "Guest" };

  it("preserves a typed response across repeated control broadcasts", () => {
    expect(previewPromptText(prompt, { ...prompt }, "Alice")).toBe("Alice");
  });

  it("resets when the message changes", () => {
    expect(previewPromptText(prompt, { ...prompt, message: "Next name?" }, "Alice")).toBe("Guest");
  });

  it("clears a closed dialog and initializes an identical reopened prompt", () => {
    const cleared = previewPromptText(prompt, null, "Alice");
    expect(cleared).toBe("");
    expect(previewPromptText(null, prompt, cleared)).toBe("Guest");
  });
});
