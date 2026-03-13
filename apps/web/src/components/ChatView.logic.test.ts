import { describe, expect, it } from "vitest";
import { resolveComposerReasoningEffort } from "./ChatView.logic";

describe("resolveComposerReasoningEffort", () => {
  it("prefers the thread draft effort over the global codex fallback", () => {
    expect(
      resolveComposerReasoningEffort({
        composerDraftEffort: "high",
        provider: "codex",
        defaultCodexReasoningEffort: "low",
      }),
    ).toBe("high");
  });

  it("uses the global last-used codex reasoning effort", () => {
    expect(
      resolveComposerReasoningEffort({
        composerDraftEffort: null,
        provider: "codex",
        defaultCodexReasoningEffort: "low",
      }),
    ).toBe("low");
  });
});
