import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ComposerDictationButton } from "./ComposerDictationButton";

describe("ComposerDictationButton", () => {
  it("disables the button while requesting the microphone", () => {
    const markup = renderToStaticMarkup(
      <ComposerDictationButton phase="requesting" disabled={false} onToggle={() => {}} />,
    );
    expect(markup).toContain("disabled");
    expect(markup).toContain('aria-label="Waiting for microphone..."');
  });

  it("keeps the stop affordance while recording", () => {
    const markup = renderToStaticMarkup(
      <ComposerDictationButton phase="recording" disabled={false} onToggle={() => {}} />,
    );
    expect(markup).not.toMatch(/<button[^>]*\sdisabled[=>\s]/);
    expect(markup).toContain('aria-pressed="true"');
  });
});
