import { describe, expect, it } from "vite-plus/test";
import { resolveThreadComposerPrimaryAction } from "./threadPresentation";

describe("resolveThreadComposerPrimaryAction", () => {
  it("continues an interrupted turn when the composer is empty", () => {
    expect(
      resolveThreadComposerPrimaryAction({
        hasContent: false,
        latestTurnState: "interrupted",
        sessionStatus: "ready",
      }),
    ).toBe("continue");
  });

  it("sends draft content instead of continuing", () => {
    expect(
      resolveThreadComposerPrimaryAction({
        hasContent: true,
        latestTurnState: "interrupted",
        sessionStatus: "ready",
      }),
    ).toBe("send");
  });

  it("keeps stop ahead of continue while the session is running", () => {
    expect(
      resolveThreadComposerPrimaryAction({
        hasContent: false,
        latestTurnState: "interrupted",
        sessionStatus: "running",
      }),
    ).toBe("stop");
  });
});
