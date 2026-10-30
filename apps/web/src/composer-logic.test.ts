import { filterComposerPullRequestMatches } from "@t3tools/shared/composerPullRequestMatches";
import { EnvironmentId, MessageId, ThreadId, type AssistantCitation } from "@t3tools/contracts";
import {
  collectAssistantCitations,
  expandAssistantCitationsForProvider,
  serializeAssistantCitation,
} from "@t3tools/shared/assistantCitations";
import {
  DEFAULT_RESOLVED_KEYBINDINGS,
  compileResolvedKeybindingsConfig,
  mergeWithDefaultKeybindings,
} from "@t3tools/shared/keybindings";
import { describe, expect, it } from "vite-plus/test";
import { formatNativeAppMention } from "@t3tools/shared/nativeAppMentions";

import {
  clampCollapsedComposerCursor,
  collapseExpandedComposerCursor,
  composerSubmissionIntentForKey,
  composerStateAtPromptEnd,
  detectComposerTrigger,
  expandCollapsedComposerCursor,
  extendReplacementRangeForTrailingSpace,
  formatAssistantCitationForComposer,
  isPathSuggestionCurrent,
  replaceTextRange,
} from "./composer-logic";

import { carryDisplacedCustomAnswerIntoPrompt } from "./pendingUserInput";
import { formatTerminalContextReference } from "./lib/terminalContext";

it("treats an application chip as one cursor position", () => {
  const source = formatNativeAppMention({ name: "Helium" }, "host");
  expect(collapseExpandedComposerCursor(`${source} x`, source.length)).toBe(1);
  expect(expandCollapsedComposerCursor(`${source} x`, 1)).toBe(source.length);
});

const terminalReference = formatTerminalContextReference({
  id: "ctx-1",
  terminalLabel: "Terminal 1",
  lineStart: 3,
  lineEnd: 4,
});

const citation: AssistantCitation = {
  version: 1,
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
  messageId: MessageId.make("message-1"),
  text: "Keep Unicode 👋 and punctuation (here).",
  start: 3,
  end: 40,
  prefix: "前: ",
  suffix: " 後",
};
const citationSource = serializeAssistantCitation(citation).replaceAll("+", "%20");

describe("isPathSuggestionCurrent", () => {
  const searchedTarget = {
    environmentId: EnvironmentId.make("local"),
    cwd: "/repo",
    query: "alpha",
  };

  it("allows a file suggestion matching the live search", () => {
    expect(
      isPathSuggestionCurrent(
        searchedTarget,
        detectComposerTrigger("@alpha", 6),
        searchedTarget.environmentId,
        searchedTarget.cwd,
      ),
    ).toBe(true);
  });

  it.each([
    ["query", { ...searchedTarget, query: "beta" }],
    ["cwd", { ...searchedTarget, cwd: "/other-repo" }],
    ["environment", { ...searchedTarget, environmentId: EnvironmentId.make("remote") }],
  ] as const)("rejects a visible file suggestion after the live %s changes", (_change, current) => {
    const prompt = `@${current.query}`;
    expect(
      isPathSuggestionCurrent(
        searchedTarget,
        detectComposerTrigger(prompt, prompt.length),
        current.environmentId,
        current.cwd,
      ),
    ).toBe(false);
  });
});

describe("formatAssistantCitationForComposer", () => {
  it("binds a multiline comment to its citation without adding standalone prompt text", () => {
    const comment = 'What does "keep" mean? 👋\n  Please show an example.';
    const text = formatAssistantCitationForComposer(citation, `  ${comment}\n`);
    const boundCitation = { ...citation, comment };
    expect(text).toBe(`${serializeAssistantCitation(boundCitation)} `);
    expect(collectAssistantCitations(text).map((entry) => entry.citation)).toEqual([boundCitation]);
    expect(expandAssistantCitationsForProvider(text)).toMatch(/^\[assistant-quote-1\] \n\n/);
  });
});

describe("composerSubmissionIntentForKey", () => {
  const input = {
    keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
    platform: "Linux",
    isSoftwareKeyboardOpen: false,
    isDraftThread: false,
  };
  const enter = { key: "Enter", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false };

  it.each([
    ["enter", "one line", false, "foreground"],
    ["enter", "two\nlines", false, "foreground"],
    ["mod-enter-multiline", "one line", false, "foreground"],
    ["mod-enter-multiline", "two\nlines", false, null],
    ["mod-enter-multiline", "two\nlines", true, "foreground"],
    ["mod-enter", "one line", false, null],
    ["mod-enter", "one line", true, "foreground"],
  ] as const)("honors %s for %j", (sendShortcut, prompt, ctrlKey, expected) => {
    expect(
      composerSubmissionIntentForKey({
        ...input,
        event: { ...enter, ctrlKey },
        sendShortcut,
        prompt,
      }),
    ).toBe(expected);
  });

  it("honors the send preference with an existing install's saved alternate binding", () => {
    const keybindings = mergeWithDefaultKeybindings(
      compileResolvedKeybindingsConfig([
        {
          key: "mod+enter",
          command: "composer.sendAlternate",
          when: "composerFocus && turnRunning",
        },
      ]),
    );
    const running = { ...input, keybindings, isRunning: true, sendShortcut: "mod-enter" as const };
    expect(composerSubmissionIntentForKey({ ...running, event: { ...enter, ctrlKey: true } })).toBe(
      "foreground",
    );
    expect(
      composerSubmissionIntentForKey({
        ...running,
        event: { ...enter, ctrlKey: true, shiftKey: true },
      }),
    ).toBe("alternate");
  });

  it.each(["enter", "mod-enter", "mod-enter-multiline"] as const)(
    "uses remapped keys and removes the old action bindings with %s",
    (sendShortcut) => {
      const keybindings = mergeWithDefaultKeybindings(
        compileResolvedKeybindingsConfig([
          {
            key: "alt+q",
            command: "composer.sendAlternate",
            when: "composerFocus && turnRunning",
          },
          {
            key: "alt+b",
            command: "composer.sendBackground",
            when: "composerFocus && draftThreadRoute",
          },
        ]),
      );
      const custom = { ...input, keybindings, sendShortcut, prompt: "two\nlines" };
      expect(
        composerSubmissionIntentForKey({
          ...custom,
          isRunning: true,
          event: { ...enter, key: "q", altKey: true },
        }),
      ).toBe("alternate");
      expect(
        composerSubmissionIntentForKey({
          ...custom,
          isDraftThread: true,
          event: { ...enter, key: "b", altKey: true },
        }),
      ).toBe("background");
      expect(
        composerSubmissionIntentForKey({
          ...custom,
          isRunning: true,
          event: { ...enter, ctrlKey: true },
        }),
      ).toBe("foreground");
      expect(
        composerSubmissionIntentForKey({
          ...custom,
          isDraftThread: true,
          event: { ...enter, ctrlKey: true, shiftKey: true },
        }),
      ).toBeNull();
      expect(
        composerSubmissionIntentForKey({
          ...custom,
          isRunning: true,
          event: { ...enter, ctrlKey: true, shiftKey: true },
        }),
      ).toBeNull();
      expect(
        composerSubmissionIntentForKey({ ...custom, event: { ...enter, key: "b", altKey: true } }),
      ).toBeNull();
    },
  );

  it.each(["MacIntel", "Win32", "Linux"])(
    "keeps modifier submission available with the software keyboard open on %s",
    (platform) => {
      const modEnter = {
        ...enter,
        metaKey: platform === "MacIntel",
        ctrlKey: platform !== "MacIntel",
      };
      const keyboardOpen = { ...input, platform, isSoftwareKeyboardOpen: true };
      expect(composerSubmissionIntentForKey({ ...keyboardOpen, event: modEnter })).toBe(
        "foreground",
      );
      expect(
        composerSubmissionIntentForKey({ ...keyboardOpen, isRunning: true, event: modEnter }),
      ).toBe("alternate");
      expect(
        composerSubmissionIntentForKey({ ...keyboardOpen, isDraftThread: true, event: modEnter }),
      ).toBe("background");
    },
  );

  it.each([
    { isSoftwareKeyboardOpen: true },
    { event: { ...enter, isComposing: true } },
    { event: { ...enter, keyCode: 229 } },
    { event: { ...enter, repeat: true } },
  ])("does not submit with %j", (override) => {
    expect(composerSubmissionIntentForKey({ ...input, event: enter, ...override })).toBeNull();
  });
});

describe("detectComposerTrigger", () => {
  it.each([
    ["Run /tmp/build.sh", "Run /tmp/build.sh".length],
    ["/etc/hosts", "/etc/hosts".length],
    ["Use /etc/hosts now", "Use /et".length],
  ])("keeps the path in %j out of the slash menu", (text, cursor) => {
    expect(detectComposerTrigger(text, cursor)).toBeNull();
  });

  it.each(["Use ", "Use\t", "Use\n  "])("detects inline slash skills after %j", (prefix) => {
    const text = `${prefix}/skill:review later`;
    const cursor = `${prefix}/skill:review`.length;
    expect(detectComposerTrigger(text, cursor)).toEqual({
      kind: "slash-command",
      query: "skill:review",
      rangeStart: prefix.length,
      rangeEnd: cursor,
    });
  });

  it.each(["Use/review", "https://example.com/review", "Use /review "])(
    "does not trigger for %j",
    (text) => expect(detectComposerTrigger(text, text.length)).toBeNull(),
  );

  it("does not keep a subcommand trigger active after /model arguments", () => {
    const text = "/model spark";
    const trigger = detectComposerTrigger(text, text.length);

    expect(trigger).toBeNull();
  });

  it.each([
    "It costs $5",
    "budget $9.99",
    "only $.99",
    "about €20",
    "raise $10k",
    "raise $10k.",
    "is it $5?",
  ])("does not detect a skill trigger for the amount in %j", (text) => {
    expect(detectComposerTrigger(text, text.length)).toBeNull();
  });

  it("detects a pull request number at a token boundary", () => {
    const text = "Compare this with #8737";

    expect(detectComposerTrigger(text, text.length)).toEqual({
      kind: "pull-request",
      query: "8737",
      rangeStart: "Compare this with ".length,
      rangeEnd: text.length,
    });
  });

  it("does not keep pull request completion active for headings or embedded hashes", () => {
    expect(detectComposerTrigger("# Heading", "# Heading".length)).toBeNull();
    expect(detectComposerTrigger("issue#123", "issue#123".length)).toBeNull();
  });

  // regression: #936 @file autocomplete used the wrong cursor when typing mid-text
  it("detects @path trigger in the middle of existing text", () => {
    const text = "Please inspect @in this sentence";
    const cursorAfterAt = "Please inspect @".length;

    const trigger = detectComposerTrigger(text, cursorAfterAt);
    expect(trigger).toEqual({
      kind: "path",
      query: "",
      rangeStart: "Please inspect ".length,
      rangeEnd: cursorAfterAt,
    });
  });
});

describe("filterComposerPullRequestMatches", () => {
  const entries = [
    {
      number: 7,
      projectId: "project-1",
      repository: "t3tools/t3code",
      updatedAt: "2026-09-01T12:00:00.000Z",
    },
    {
      number: 8987,
      projectId: "project-1",
      repository: "T3Tools/T3Code",
      updatedAt: "2026-09-03T12:00:00.000Z",
    },
    {
      number: 27,
      projectId: "project-1",
      repository: "t3tools/t3code",
      updatedAt: "2026-09-02T12:00:00.000Z",
    },
    {
      number: 27,
      projectId: "project-1",
      repository: "t3tools/t3code",
      updatedAt: "2026-09-01T13:00:00.000Z",
    },
    {
      number: 70,
      projectId: "project-2",
      repository: "t3tools/other",
      updatedAt: "2026-09-04T12:00:00.000Z",
    },
  ];

  it("matches and de-duplicates number fragments within one repository, exact match first", () => {
    expect(
      filterComposerPullRequestMatches({
        entries,
        projectId: "project-1",
        repository: "t3tools/t3code",
        query: "7",
        limit: 10,
      }).map((entry) => entry.number),
    ).toEqual([7, 8987, 27]);
  });

  it("keeps an older exact match when newer substring matches would fill the limit", () => {
    const exact = {
      number: 7,
      projectId: "project-1",
      repository: "t3tools/t3code",
      updatedAt: "2020-01-01T00:00:00.000Z",
    };
    const newerSubstringMatches = Array.from({ length: 12 }, (_unused, index) => ({
      number: 700 + index,
      projectId: "project-1",
      repository: "t3tools/t3code",
      updatedAt: `2026-09-${String(index + 1).padStart(2, "0")}T12:00:00.000Z`,
    }));
    const matches = filterComposerPullRequestMatches({
      entries: [...newerSubstringMatches, exact],
      projectId: "project-1",
      repository: "t3tools/t3code",
      query: "7",
      limit: 10,
    });
    expect(matches[0]?.number).toBe(7);
    expect(matches).toHaveLength(10);
  });
});

describe("expandCollapsedComposerCursor", () => {
  it("maps collapsed mention cursor to expanded text cursor", () => {
    const text = "what's in my @AGENTS.md fsfdas";
    const collapsedCursorAfterMention = "what's in my ".length + 2;
    const expandedCursorAfterMention = "what's in my @AGENTS.md ".length;

    expect(expandCollapsedComposerCursor(text, collapsedCursorAfterMention)).toBe(
      expandedCursorAfterMention,
    );
  });

  // regression: #2625 cursor mapping broke for quoted mentions containing spaces
  it("maps collapsed quoted mention cursor to expanded text cursor", () => {
    const text = 'what is in @"My File.md" please';
    const collapsedCursorAfterMention = "what is in ".length + 2;
    const expandedCursorAfterMention = 'what is in @"My File.md" '.length;

    expect(expandCollapsedComposerCursor(text, collapsedCursorAfterMention)).toBe(
      expandedCursorAfterMention,
    );
  });

  it("maps collapsed markdown file links to their expanded source offsets", () => {
    const text = "what's in [AGENTS.md](AGENTS.md) please";
    const collapsedCursorAfterMention = "what's in ".length + 2;
    const expandedCursorAfterMention = "what's in [AGENTS.md](AGENTS.md) ".length;

    expect(expandCollapsedComposerCursor(text, collapsedCursorAfterMention)).toBe(
      expandedCursorAfterMention,
    );
  });

  it("allows path trigger detection to close after selecting a mention", () => {
    const text = "what's in my @AGENTS.md ";
    const collapsedCursorAfterMention = "what's in my ".length + 2;
    const expandedCursor = expandCollapsedComposerCursor(text, collapsedCursorAfterMention);

    expect(detectComposerTrigger(text, expandedCursor)).toBeNull();
  });
});

describe("composerStateAtPromptEnd", () => {
  it("collapses mention chips so the next keystroke lands after the draft", () => {
    const prompt = carryDisplacedCustomAnswerIntoPrompt("", "see @AGENTS.md please");

    expect(composerStateAtPromptEnd(prompt).cursor).toBe("see ".length + 1 + " please".length);
    expect(composerStateAtPromptEnd(prompt).cursor).not.toBe(0);
    expect(composerStateAtPromptEnd(prompt).cursor).not.toBe(prompt.length);
  });

  it("keeps a trailing mention trigger when the restored draft ends with @", () => {
    const prompt = "look at @";

    expect(composerStateAtPromptEnd(prompt)).toEqual({
      cursor: prompt.length,
      trigger: { kind: "path", query: "", rangeStart: "look at ".length, rangeEnd: prompt.length },
    });
  });
});

describe("collapseExpandedComposerCursor", () => {
  it("keeps package-like text expanded when another mention already exists earlier", () => {
    const text = "open @AGENTS.md then @src/index.ts ";
    const expandedCursor = text.length;
    const collapsedCursor = collapseExpandedComposerCursor(text, expandedCursor);

    expect(collapsedCursor).toBe("open ".length + 1 + " then @src/index.ts ".length);
    expect(expandCollapsedComposerCursor(text, collapsedCursor)).toBe(expandedCursor);
  });
});

it("preserves the caret before trailing text after mixed-width skill chips", () => {
  const text = "𑿝ui a $review tail";
  const expanded = "𑿝ui a $review ".length;
  expect(collapseExpandedComposerCursor(text, expanded)).toBe(6);
  expect(expandCollapsedComposerCursor(text, 6)).toBe(expanded);
});

describe("assistant citation cursor offsets", () => {
  it("roundtrips every collapsed offset across citations, mentions, skills, and Unicode", () => {
    const prefix = "👋(";
    const between = "),雪";
    const after = " @AGENTS.md $review ";
    const text = `${prefix}${citationSource}${between}${citationSource}${after}${terminalReference}!`;
    const collapsedLength = `${prefix}□${between}□ □ □ □!`.length;
    const boundaries = [
      [prefix.length, prefix.length],
      [prefix.length + 1, prefix.length + citationSource.length],
      [prefix.length + 1 + between.length, prefix.length + citationSource.length + between.length],
      [
        prefix.length + 2 + between.length,
        prefix.length + citationSource.length * 2 + between.length,
      ],
      [collapsedLength, text.length],
    ] as const;

    for (const [collapsed, expanded] of boundaries) {
      expect(expandCollapsedComposerCursor(text, collapsed)).toBe(expanded);
      expect(collapseExpandedComposerCursor(text, expanded)).toBe(collapsed);
    }
    for (let cursor = 0; cursor <= collapsedLength; cursor += 1) {
      expect(
        collapseExpandedComposerCursor(text, expandCollapsedComposerCursor(text, cursor)),
      ).toBe(cursor);
    }
    expect(clampCollapsedComposerCursor(text, Number.POSITIVE_INFINITY)).toBe(collapsedLength);
  });

  it("snaps serialized offsets inside a citation to the end of its chip", () => {
    const prefix = "前👋";
    const text = `${prefix}${citationSource}.`;

    for (const offset of [1, citationSource.length - 1, citationSource.length]) {
      expect(collapseExpandedComposerCursor(text, prefix.length + offset)).toBe(prefix.length + 1);
    }
  });

  it("deletes one collapsed citation without changing its neighbor or surrounding punctuation", () => {
    const text = `(${citationSource}),${citationSource}!`;
    const result = replaceTextRange(
      text,
      expandCollapsedComposerCursor(text, 1),
      expandCollapsedComposerCursor(text, 2),
      "",
    );

    expect(result).toEqual({ text: `(),${citationSource}!`, cursor: 1 });
    expect(collapseExpandedComposerCursor(result.text, result.text.length)).toBe("(),□!".length);
  });
});

describe("literal editor answer cursor state", () => {
  const prefill = "- [X] done $my-skill ";

  it("keeps character positions after token-like text for inserted lines and replacements", () => {
    for (const replacement of ["\n", "\t", "edited\n  "]) {
      const next = replaceTextRange(prefill, prefill.length, prefill.length, replacement);
      const cursor = collapseExpandedComposerCursor(next.text, next.cursor, true);
      expect(next.text).toBe(prefill + replacement);
      expect(cursor).toBe(next.text.length);
      expect(expandCollapsedComposerCursor(next.text, cursor, true)).toBe(next.cursor);
      expect(clampCollapsedComposerCursor(next.text, cursor, true)).toBe(next.cursor);
    }
    const replaced = replaceTextRange(prefill, 11, 20, "$another-skill");
    const cursor = collapseExpandedComposerCursor(replaced.text, replaced.cursor, true);
    expect(replaced.text).toBe("- [X] done $another-skill ");
    expect(cursor).toBe(25);
    expect(expandCollapsedComposerCursor(replaced.text, cursor, true)).toBe(25);
  });

  it("does not open a skill or path menu when restoring an editor answer", () => {
    for (const value of ["- [X] done $my-skill", "Use @README", ""]) {
      expect(composerStateAtPromptEnd(value, true)).toEqual({
        cursor: value.length,
        trigger: null,
      });
    }
    expect(composerStateAtPromptEnd("Use $my").trigger?.kind).toBe("skill");
  });
});

describe("extendReplacementRangeForTrailingSpace", () => {
  it("swallows one existing space after the range when the replacement ends with one", () => {
    expect(extendReplacementRangeForTrailingSpace("@fi rest", 3, "@file ")).toBe(4);
    expect(extendReplacementRangeForTrailingSpace("@firest", 3, "@file ")).toBe(3);
    expect(extendReplacementRangeForTrailingSpace("@fi rest", 3, "@file")).toBe(3);
    expect(extendReplacementRangeForTrailingSpace("@fi", 3, "@file ")).toBe(3);
  });
});
