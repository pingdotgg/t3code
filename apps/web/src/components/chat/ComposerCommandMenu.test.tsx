import { renderToStaticMarkup } from "react-dom/server";
import { type IssueListEntry, ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildComposerPathMenuItems,
  ComposerCommandMenu,
  composerIssueReference,
  serializeComposerIssueMention,
} from "./ComposerCommandMenu";

const issue = {
  provider: "github",
  host: "github.com",
  projectId: "project-1" as IssueListEntry["projectId"],
  projectTitle: "Acme",
  repository: "acme/app",
  number: 12,
  title: "Fix session refresh",
  url: "https://github.com/acme/app/issues/12",
  author: null,
  state: "open",
  stateReason: null,
  createdAt: "2026-08-20T10:00:00Z",
  updatedAt: "2026-08-20T11:00:00Z",
  closedAt: null,
  assignees: [],
  labels: [],
  milestone: null,
  commentCount: 0,
} satisfies IssueListEntry;

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
    expect(markup).not.toContain("grid-cols-");
    expect(markup).toContain("max-w-[45%]");
    expect(markup).toContain("text-left");
  });

  it("renders the skill source icon inside its badge", () => {
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
    expect(markup).toContain('data-slot="badge"');
    expect(markup).toContain(">App Skill</span>");
    expect(markup).toContain("Open and control the in-app browser");
    expect(markup).toContain("max-w-[48ch]");
    expect(markup).toContain("text-secondary-label text-xs");
    expect(markup).toContain("ms-auto");
    expect(markup).toContain("text-current");
    expect(markup.indexOf("Open and control the in-app browser")).toBeLessThan(
      markup.indexOf(">App Skill</span>"),
    );
    expect(markup).toContain("<svg");
    expect(markup.indexOf('data-slot="badge"')).toBeLessThan(markup.indexOf("<svg"));
  });

  it("keeps slash skills aligned with the source icon inside the badge", () => {
    const markup = renderToStaticMarkup(
      <ComposerCommandMenu
        items={[
          {
            id: "skill:codex:ask-matt",
            type: "skill",
            provider: ProviderDriverKind.make("codex"),
            skill: {
              name: "ask-matt",
              displayName: "Ask Matt",
              path: "/skills/ask-matt/SKILL.md",
              scope: "repo",
              enabled: true,
            },
            label: "/skill:ask-matt",
            description: "Find the right skill or workflow",
          },
        ]}
        resolvedTheme="dark"
        isLoading={false}
        triggerKind="slash-command"
        activeItemId="skill:codex:ask-matt"
        onHighlightedItemChange={() => {}}
        onSelect={() => {}}
      />,
    );

    expect(markup).toContain('<span class="text-secondary-label">/skill:</span>Ask Matt');
    expect(markup).toContain('data-slot="badge"');
    expect(markup).toContain("lucide-folder");
    expect(markup).toContain(">Repo</span>");
    expect(markup).toContain("Find the right skill or workflow");
    expect(markup).not.toContain("font-medium text-secondary-label");
  });

  it.each([
    { entry: issue, expected: "acme/app#12" },
    { entry: { ...issue, provider: "linear", repository: "ENG" }, expected: "ENG-12" },
  ] as const)("formats host-native issue reference $expected", ({ entry, expected }) => {
    expect(composerIssueReference(entry)).toBe(expected);
  });

  it("serializes an issue mention with its exact URL", () => {
    expect(serializeComposerIssueMention(issue)).toBe(
      "[@acme/app#12](https://github.com/acme/app/issues/12) ",
    );
  });

  it("renders issue results with their state and reference", () => {
    const markup = renderToStaticMarkup(
      <ComposerCommandMenu
        items={[
          {
            id: "issue:github:acme/app:12",
            type: "issue",
            issue,
            label: issue.title,
            description: "acme/app#12",
          },
        ]}
        resolvedTheme="dark"
        isLoading={false}
        triggerKind="path"
        activeItemId="issue:github:acme/app:12"
        onHighlightedItemChange={() => {}}
        onSelect={() => {}}
      />,
    );

    expect(markup).toContain("Fix session refresh");
    expect(markup).toContain("acme/app#12");
    expect(markup).toContain('aria-label="Open"');
    expect(markup).toContain("min-w-0 flex-1 truncate");
    expect(markup).toContain("text-right text-secondary-label text-xs shrink-0");
  });

  it("keeps file results first while a new issue query is settling", () => {
    const pathItem = {
      id: "path:file:src/app.ts",
      type: "path" as const,
      path: "src/app.ts",
      pathKind: "file" as const,
      label: "app.ts",
      description: "src",
    };

    expect(
      buildComposerPathMenuItems({
        issues: [issue],
        pathItems: [pathItem],
        query: "src",
        settledIssueQuery: "",
      }),
    ).toEqual([pathItem]);
  });

  it("keeps issue hosts in result identity when the query is settled", () => {
    const items = buildComposerPathMenuItems({
      issues: [issue, { ...issue, host: "github.acme.test" }],
      pathItems: [],
      query: "session",
      settledIssueQuery: "session",
    });

    expect(items.map((item) => item.id)).toEqual([
      "issue:github:github.com:project-1:acme/app:12",
      "issue:github:github.acme.test:project-1:acme/app:12",
    ]);
  });
});
