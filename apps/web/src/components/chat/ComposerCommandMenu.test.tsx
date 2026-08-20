import { renderToStaticMarkup } from "react-dom/server";
import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { ComposerCommandMenu } from "./ComposerCommandMenu";

describe("ComposerCommandMenu", () => {
  it("renders slash-command results as an attached composer drawer", () => {
    const markup = renderToStaticMarkup(
      <ComposerCommandMenu
        items={[]}
        resolvedTheme="dark"
        isLoading={false}
        triggerKind="slash-command"
        activeItemId={null}
        onHighlightedItemChange={() => {}}
        onSelect={() => {}}
      />,
    );

    expect(markup).toContain('data-composer-command-drawer="true"');
    expect(markup).toContain("chat-composer-drawer-surface");
    expect(markup).toContain("chat-composer-drawer-attached");
    expect(markup).not.toContain("dropdown-glass");
  });

  it("renders commands without a category heading or invented icons", () => {
    const markup = renderToStaticMarkup(
      <ComposerCommandMenu
        items={[
          {
            id: "slash:model",
            type: "slash-command",
            command: "model",
            label: "/model",
            description: "Switch response model for this thread",
          },
        ]}
        resolvedTheme="dark"
        isLoading={false}
        triggerKind="slash-command"
        activeItemId="slash:model"
        onHighlightedItemChange={() => {}}
        onSelect={() => {}}
      />,
    );

    expect(markup).toContain("/model");
    expect(markup).toContain("Switch response model for this thread");
    expect(markup).not.toContain("Built-in");
    expect(markup).not.toContain("<svg");
    expect(markup).toContain("font-sans text-xs font-medium");
    expect(markup).not.toContain("font-mono");
    expect(markup).toContain("text-right");
  });

  it("renders a skill source icon with an accessible source label", () => {
    const markup = renderToStaticMarkup(
      <ComposerCommandMenu
        items={[
          {
            id: "skill:codex:browser",
            type: "skill",
            provider: ProviderDriverKind.make("codex"),
            skill: {
              name: "browser",
              path: "/Users/maria/.codex/plugins/browser/skills/browser/SKILL.md",
              scope: "user",
              enabled: true,
            },
            label: "Browser",
            description: "Open and control the in-app browser",
          },
        ]}
        resolvedTheme="dark"
        isLoading={false}
        triggerKind="skill"
        activeItemId="skill:codex:browser"
        onHighlightedItemChange={() => {}}
        onSelect={() => {}}
      />,
    );

    expect(markup).toContain("Browser");
    expect(markup).toContain('<span class="sr-only">App skill</span>');
    expect(markup).toContain("<svg");
    expect(markup).toContain("text-icon-muted");
  });
});
