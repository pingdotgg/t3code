import { describe, expect, it, vi } from "vitest";
import { expandMobileComposerForKeyboard } from "./mobileComposerFocus";

describe("expandMobileComposerForKeyboard", () => {
  it("focuses after the expanded composer is committed and before release is scheduled", () => {
    const calls: string[] = [];

    expandMobileComposerForKeyboard({
      cancelPendingRelease: vi.fn(() => calls.push("cancel-release")),
      primeExpandedState: vi.fn(() => calls.push("prime-expanded")),
      focusEditorAtEnd: vi.fn(() => calls.push("focus")),
      scheduleRelease: vi.fn(() => calls.push("schedule-release")),
    });

    expect(calls).toEqual(["cancel-release", "prime-expanded", "focus", "schedule-release"]);
  });
});
