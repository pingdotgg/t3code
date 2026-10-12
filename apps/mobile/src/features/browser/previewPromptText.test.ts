import { describe, expect, it } from "vite-plus/test";

import { previewPromptText } from "./previewPromptText";

describe("browser prompt response", () => {
  const prompt = { type: "prompt" as const, message: "Your name?", defaultValue: "Guest" };

  it("preserves a typed response across repeated control broadcasts", () => {
    expect(previewPromptText(prompt, { ...prompt }, "Alice")).toBe("Alice");
  });

  it("preserves an intentionally empty response", () => {
    expect(previewPromptText(prompt, { ...prompt }, "")).toBe("");
  });

  it("initializes a newly opened prompt", () => {
    expect(previewPromptText(null, prompt, "")).toBe("Guest");
  });

  it("resets a stale draft after reconnecting without dialog history", () => {
    expect(previewPromptText(null, prompt, "Alice")).toBe("Guest");
  });

  it("resets when the message changes", () => {
    expect(previewPromptText(prompt, { ...prompt, message: "Next name?" }, "Alice")).toBe("Guest");
  });

  it("resets when the default value changes", () => {
    expect(previewPromptText(prompt, { ...prompt, defaultValue: "Bob" }, "Alice")).toBe("Bob");
  });

  it("resets when the dialog type changes with matching message and default", () => {
    expect(previewPromptText(prompt, { ...prompt, type: "confirm" }, "Alice")).toBe("Guest");
  });

  it("clears a closed dialog and initializes an identical reopened prompt", () => {
    const cleared = previewPromptText(prompt, null, "Alice");
    expect(cleared).toBe("");
    expect(previewPromptText(null, prompt, cleared)).toBe("Guest");
  });
});
