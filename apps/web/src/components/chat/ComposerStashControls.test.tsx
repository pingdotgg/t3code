import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ComposerStashBadge } from "./ComposerStashBadge";
import { ComposerStashMenu } from "./ComposerStashMenu";

describe("ComposerStashMenu", () => {
  it("always renders a close control", () => {
    const markup = renderToStaticMarkup(
      <ComposerStashMenu
        entries={[]}
        onRestore={() => {}}
        onDelete={() => {}}
        onClose={() => {}}
      />,
    );

    expect(markup).toContain('aria-label="Close stashed prompts"');
  });
});

describe("ComposerStashBadge", () => {
  it("does not render while the stash menu is open", () => {
    const markup = renderToStaticMarkup(
      <ComposerStashBadge
        count={1}
        pulseKey={0}
        pulsing={false}
        menuOpen
        onToggleMenu={() => {}}
      />,
    );

    expect(markup).toBe("");
  });

  it("renders when there are stashed prompts and the menu is closed", () => {
    const markup = renderToStaticMarkup(
      <ComposerStashBadge
        count={1}
        pulseKey={0}
        pulsing={false}
        menuOpen={false}
        onToggleMenu={() => {}}
      />,
    );

    expect(markup).toContain('data-prompt-stash-badge="true"');
  });
});
