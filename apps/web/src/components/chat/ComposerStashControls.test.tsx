import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ComposerStashBadge } from "./ComposerStashBadge";
import { ComposerStashMenu } from "./ComposerStashMenu";

describe("ComposerStashMenu", () => {
  it("renders the close control outside the scrollable list", () => {
    const markup = renderToStaticMarkup(
      <ComposerStashMenu
        entries={[]}
        onRestore={() => {}}
        onDelete={() => {}}
        onClose={() => {}}
        focusCloseOnMount={false}
      />,
    );

    expect(markup).toContain('aria-label="Close stashed prompts"');
    expect(markup.indexOf('aria-label="Close stashed prompts"')).toBeLessThan(
      markup.indexOf('data-slot="command-list"'),
    );
  });
});

describe("ComposerStashBadge", () => {
  it("does not render without stashed prompts", () => {
    const markup = renderToStaticMarkup(
      <ComposerStashBadge count={0} pulseKey={0} pulsing={false} onToggleMenu={() => {}} />,
    );

    expect(markup).toBe("");
  });

  it("renders when there are stashed prompts", () => {
    const markup = renderToStaticMarkup(
      <ComposerStashBadge count={1} pulseKey={0} pulsing={false} onToggleMenu={() => {}} />,
    );

    expect(markup).toContain('data-prompt-stash-badge="true"');
  });
});
