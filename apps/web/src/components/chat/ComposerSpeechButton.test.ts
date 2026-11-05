import { expect, it } from "vite-plus/test";

import { shouldShowComposerFooter } from "./ComposerSpeechButton";

it.each(["preparing", "recording", "transcribing", "post-processing", "error"] as const)(
  "keeps voice controls visible in a collapsed composer during %s",
  (phase) => {
    expect(shouldShowComposerFooter(true, phase)).toBe(true);
  },
);
it("keeps the idle collapsed footer hidden", () => {
  expect(shouldShowComposerFooter(true, "idle")).toBe(false);
});
