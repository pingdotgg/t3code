import { renderToStaticMarkup } from "react-dom/server";
import { formatIssueReference, type IssueListEntry, ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildComposerPathMenuItems,
  ComposerCommandMenu,
  composerSuggestionOptionId,
  isComposerPathMenuLoading,
  serializeComposerIssueMention,
} from "./ComposerCommandMenu";

const issue = {
  provider: "github",
  referenceStyle: "hash",
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

describe("composerSuggestionOptionId", () => {
  it("keeps whitespace, escape-like paths, and malformed UTF-16 distinct", () => {
    const paths = [
      "docs/my file.md",
      "docs/my_file.md",
      "docs/my%20file.md",
      "docs/my\tfile.md",
      "docs/\ud800.md",
      "docs/\ud801.md",
      "docs/\udc00.md",
      "docs/\ufffd.md",
      "docs/\\ud800.md",
      "docs/\ud83d\ude80.md",
    ];
    const ids = paths.map((path) => composerSuggestionOptionId("suggestions", `path:file:${path}`));

    expect(new Set(ids).size).toBe(paths.length);
    for (const id of ids) expect(id).not.toMatch(/\s|[\ud800-\udfff]/u);
    expect(composerSuggestionOptionId("other-composer", paths[0]!)).not.toBe(
      composerSuggestionOptionId("suggestions", paths[0]!),
    );
  });
});

describe("ComposerCommandMenu", () => {
  it("renders slash commands with their descriptions", () => {
    const markup = renderToStaticMarkup(
      <ComposerCommandMenu
        listId="test-suggestions"
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
  });

  it("shows the app source for an app skill", () => {
    const markup = renderToStaticMarkup(
      <ComposerCommandMenu
        listId="test-suggestions"
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
    expect(markup).toContain("<svg");
  });

  it("shows the repo source for a slash skill", () => {
    const markup = renderToStaticMarkup(
      <ComposerCommandMenu
        listId="test-suggestions"
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
  });

  it.each([
    { entry: issue, expected: "acme/app#12" },
    {
      entry: { ...issue, provider: "linear", referenceStyle: "key-number", repository: "ENG" },
      expected: "ENG-12",
    },
    {
      entry: {
        ...issue,
        provider: "another-tracker",
        referenceStyle: "key-number",
        repository: "APP",
      },
      expected: "APP-12",
    },
  ] as const)("formats host-native issue reference $expected", ({ entry, expected }) => {
    expect(formatIssueReference(entry)).toBe(expected);
  });

  it("serializes an issue mention with its exact URL", () => {
    expect(serializeComposerIssueMention(issue)).toBe(
      "[@acme/app#12](https://github.com/acme/app/issues/12) ",
    );
  });

  it("renders issue results with their state and reference", () => {
    const markup = renderToStaticMarkup(
      <ComposerCommandMenu
        listId="test-suggestions"
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

  it("waits on issues and files only once the path query has text", () => {
    expect(isComposerPathMenuLoading({ query: "", issuesPending: true, filesPending: true })).toBe(
      false,
    );
    expect(
      isComposerPathMenuLoading({ query: "src", issuesPending: true, filesPending: false }),
    ).toBe(true);
    expect(
      isComposerPathMenuLoading({ query: "src", issuesPending: false, filesPending: true }),
    ).toBe(true);
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
