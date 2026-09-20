import { filterComposerPullRequestMatches } from "@t3tools/shared/composerPullRequestMatches";
import { parseSideChatPrompt } from "./composer-logic";
import { EnvironmentId, MessageId, ThreadId, type AssistantCitation } from "@t3tools/contracts";
import {
  collectAssistantCitations,
  expandAssistantCitationsForProvider,
  serializeAssistantCitation,
} from "@t3tools/shared/assistantCitations";
import { describe, expect, it } from "vite-plus/test";

import {
  clampCollapsedComposerCursor,
  collapseExpandedComposerCursor,
  composerStateAtPromptEnd,
  composerSubmissionIntentForEnter,
  detectComposerTrigger,
  expandCollapsedComposerCursor,
  formatAssistantCitationForComposer,
  isCollapsedCursorAdjacentToInlineToken,
  parseStandaloneComposerSlashCommand,
  replaceTextRange,
} from "./composer-logic";
import { carryDisplacedCustomAnswerIntoPrompt } from "./pendingUserInput";
import { formatTerminalContextReference } from "./lib/terminalContext";

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

describe("formatAssistantCitationForComposer", () => {
  it.each([undefined, "", " \n\t "])(
    "keeps citation-only insertion for a blank comment %j",
    (comment) => {
      expect(formatAssistantCitationForComposer(citation, comment)).toBe(
        `${serializeAssistantCitation(citation)} `,
      );
    },
  );

  it("binds a multiline comment to its citation without adding standalone prompt text", () => {
    const comment = 'What does "keep" mean? 👋\n  Please show an example.';
    const text = formatAssistantCitationForComposer(citation, `  ${comment}\n`);
    const boundCitation = { ...citation, comment };
    expect(text).toBe(`${serializeAssistantCitation(boundCitation)} `);
    expect(collectAssistantCitations(text).map((entry) => entry.citation)).toEqual([boundCitation]);
    expect(expandAssistantCitationsForProvider(text)).toMatch(/^\[assistant-quote-1\] \n\n/);
  });
});

describe("composerSubmissionIntentForEnter", () => {
  it.each([
    ["enter", "one line", false, "foreground"],
    ["enter", "two\nlines", false, "foreground"],
    ["mod-enter-multiline", "one line", false, "foreground"],
    ["mod-enter-multiline", "two\nlines", false, null],
    ["mod-enter-multiline", "two\nlines", true, "foreground"],
    ["mod-enter", "one line", false, null],
    ["mod-enter", "one line", true, "foreground"],
  ] as const)("uses %s for %j with modifier=%s", (sendShortcut, prompt, modifierKey, expected) => {
    expect(
      composerSubmissionIntentForEnter({
        isMobileViewport: false,
        shiftKey: false,
        modifierKey,
        isDraftThread: false,
        sendShortcut,
        prompt,
      }),
    ).toBe(expected);
  });

  it.each([
    ["enter", false, "alternate"],
    ["enter", true, null],
    ["mod-enter-multiline", false, "foreground"],
    ["mod-enter-multiline", true, "alternate"],
    ["mod-enter", false, "foreground"],
    ["mod-enter", true, "alternate"],
  ] as const)(
    "resolves running follow-ups with %s and shift=%s",
    (sendShortcut, shiftKey, expected) => {
      expect(
        composerSubmissionIntentForEnter({
          isMobileViewport: false,
          shiftKey,
          modifierKey: true,
          isDraftThread: false,
          isRunning: true,
          sendShortcut,
          prompt: "two\nlines",
        }),
      ).toBe(expected);
    },
  );

  it("submits plain Enter on desktop", () => {
    expect(
      composerSubmissionIntentForEnter({
        isMobileViewport: false,
        shiftKey: false,
        modifierKey: false,
        isDraftThread: true,
      }),
    ).toBe("foreground");
  });

  it("inserts a newline for plain Enter on mobile", () => {
    expect(
      composerSubmissionIntentForEnter({
        isMobileViewport: true,
        shiftKey: false,
        modifierKey: false,
        isDraftThread: true,
      }),
    ).toBeNull();
  });

  it("inserts a newline for Shift+Enter", () => {
    expect(
      composerSubmissionIntentForEnter({
        isMobileViewport: false,
        shiftKey: true,
        modifierKey: false,
        isDraftThread: true,
      }),
    ).toBeNull();
  });

  it("submits a new thread in the background with Mod+Enter", () => {
    expect(
      composerSubmissionIntentForEnter({
        isMobileViewport: false,
        shiftKey: false,
        modifierKey: true,
        isDraftThread: true,
      }),
    ).toBe("background");
  });

  it("keeps Mod+Enter in the foreground for an active thread", () => {
    expect(
      composerSubmissionIntentForEnter({
        isMobileViewport: false,
        shiftKey: false,
        modifierKey: true,
        isDraftThread: false,
      }),
    ).toBe("foreground");
  });
});

describe("detectComposerTrigger", () => {
  it("detects @path trigger at cursor", () => {
    const text = "Please check @src/com";
    const trigger = detectComposerTrigger(text, text.length);

    expect(trigger).toEqual({
      kind: "path",
      query: "src/com",
      rangeStart: "Please check ".length,
      rangeEnd: text.length,
    });
  });

  it("detects slash command token while typing command name", () => {
    const text = "/mo";
    const trigger = detectComposerTrigger(text, text.length);

    expect(trigger).toEqual({
      kind: "slash-command",
      query: "mo",
      rangeStart: 0,
      rangeEnd: text.length,
    });
  });

  it("keeps /model as a slash command item", () => {
    const text = "/model";
    const trigger = detectComposerTrigger(text, text.length);

    expect(trigger).toEqual({
      kind: "slash-command",
      query: "model",
      rangeStart: 0,
      rangeEnd: text.length,
    });
  });

  it("does not keep a subcommand trigger active after /model arguments", () => {
    const text = "/model spark";
    const trigger = detectComposerTrigger(text, text.length);

    expect(trigger).toBeNull();
  });

  it("detects non-model slash commands while typing", () => {
    const text = "/pl";
    const trigger = detectComposerTrigger(text, text.length);

    expect(trigger).toEqual({
      kind: "slash-command",
      query: "pl",
      rangeStart: 0,
      rangeEnd: text.length,
    });
  });

  it("keeps slash command detection active for provider commands", () => {
    const text = "/rev";
    const trigger = detectComposerTrigger(text, text.length);

    expect(trigger).toEqual({
      kind: "slash-command",
      query: "rev",
      rangeStart: 0,
      rangeEnd: text.length,
    });
  });

  it.each(["$", "€", "£", "¥", "₹", "₩", "₿", "𑿝"])(
    "detects %sskill trigger at cursor",
    (prefix) => {
      const text = `Use ${prefix}gh-fi`;
      const trigger = detectComposerTrigger(text, text.length);

      expect(trigger).toEqual({
        kind: "skill",
        query: "gh-fi",
        rangeStart: "Use ".length,
        rangeEnd: text.length,
      });
    },
  );

  it("detects a pull request number at a token boundary", () => {
    const text = "Compare this with #8737";

    expect(detectComposerTrigger(text, text.length)).toEqual({
      kind: "pull-request",
      query: "8737",
      rangeStart: "Compare this with ".length,
      rangeEnd: text.length,
    });
  });

  it("opens pull request completion from a bare hash", () => {
    const text = "Compare with #";

    expect(detectComposerTrigger(text, text.length)).toEqual({
      kind: "pull-request",
      query: "",
      rangeStart: "Compare with ".length,
      rangeEnd: text.length,
    });
  });

  it("detects a one-word pull request search", () => {
    const text = "Compare with #composer";

    expect(detectComposerTrigger(text, text.length)).toEqual({
      kind: "pull-request",
      query: "composer",
      rangeStart: "Compare with ".length,
      rangeEnd: text.length,
    });
  });

  it("supports hyphenated pull request search terms", () => {
    const text = "Find #inline-context";

    expect(detectComposerTrigger(text, text.length)).toEqual({
      kind: "pull-request",
      query: "inline-context",
      rangeStart: "Find ".length,
      rangeEnd: text.length,
    });
  });

  it("does not keep pull request completion active for headings or embedded hashes", () => {
    expect(detectComposerTrigger("# Heading", "# Heading".length)).toBeNull();
    expect(detectComposerTrigger("issue#123", "issue#123".length)).toBeNull();
  });

  it("detects @path trigger in the middle of existing text", () => {
    // User typed @ between "inspect " and "in this sentence"
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

  it("detects @path trigger with query typed mid-text", () => {
    // User typed @sr between "inspect " and "in this sentence"
    const text = "Please inspect @srin this sentence";
    const cursorAfterQuery = "Please inspect @sr".length;

    const trigger = detectComposerTrigger(text, cursorAfterQuery);
    expect(trigger).toEqual({
      kind: "path",
      query: "sr",
      rangeStart: "Please inspect ".length,
      rangeEnd: cursorAfterQuery,
    });
  });

  it("detects trigger with true cursor even when regex-based mention detection would false-match", () => {
    // MENTION_TOKEN_REGEX can false-match plain text like "@in" as a mention.
    // The fix bypasses it by computing the expanded cursor from the Lexical node tree.
    const text = "Please inspect @in this sentence";
    const cursorAfterAt = "Please inspect @".length;

    const trigger = detectComposerTrigger(text, cursorAfterAt);
    expect(trigger).not.toBeNull();
    expect(trigger?.kind).toBe("path");
    expect(trigger?.query).toBe("");
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

  it("uses an empty query for a capped recent list", () => {
    expect(
      filterComposerPullRequestMatches({
        entries,
        projectId: "project-1",
        repository: "t3tools/t3code",
        query: "",
        limit: 2,
      }).map((entry) => entry.number),
    ).toEqual([8987, 27]);
  });
});

describe("replaceTextRange", () => {
  it("replaces a text range and returns new cursor", () => {
    const replaced = replaceTextRange("hello @src", 6, 10, "");
    expect(replaced).toEqual({
      text: "hello ",
      cursor: 6,
    });
  });
});

describe("expandCollapsedComposerCursor", () => {
  it("keeps cursor unchanged when no mention segment is present", () => {
    expect(expandCollapsedComposerCursor("plain text", 5)).toBe(5);
  });

  it("maps collapsed mention cursor to expanded text cursor", () => {
    const text = "what's in my @AGENTS.md fsfdas";
    const collapsedCursorAfterMention = "what's in my ".length + 2;
    const expandedCursorAfterMention = "what's in my @AGENTS.md ".length;

    expect(expandCollapsedComposerCursor(text, collapsedCursorAfterMention)).toBe(
      expandedCursorAfterMention,
    );
  });

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

  it.each(["$", "€", "𑿝"])("maps collapsed %s skill cursor to expanded text cursor", (prefix) => {
    const text = `run ${prefix}review-follow-up then`;
    const collapsedCursorAfterSkill = "run ".length + 2;
    const expandedCursorAfterSkill = `run ${prefix}review-follow-up `.length;

    expect(expandCollapsedComposerCursor(text, collapsedCursorAfterSkill)).toBe(
      expandedCursorAfterSkill,
    );
  });
});

describe("composerStateAtPromptEnd", () => {
  it("puts the caret at the end of a restored parked draft", () => {
    const prompt = carryDisplacedCustomAnswerIntoPrompt("first half\n", "second half");

    expect(composerStateAtPromptEnd(prompt)).toEqual({
      cursor: prompt.length,
      trigger: null,
    });
  });

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
  it("keeps cursor unchanged when no mention segment is present", () => {
    expect(collapseExpandedComposerCursor("plain text", 5)).toBe(5);
  });

  it("maps expanded mention cursor back to collapsed cursor", () => {
    const text = "what's in my @AGENTS.md fsfdas";
    const collapsedCursorAfterMention = "what's in my ".length + 2;
    const expandedCursorAfterMention = "what's in my @AGENTS.md ".length;

    expect(collapseExpandedComposerCursor(text, expandedCursorAfterMention)).toBe(
      collapsedCursorAfterMention,
    );
  });

  it("maps expanded quoted mention cursor back to collapsed cursor", () => {
    const text = 'what is in @"My File.md" please';
    const collapsedCursorAfterMention = "what is in ".length + 2;
    const expandedCursorAfterMention = 'what is in @"My File.md" '.length;

    expect(collapseExpandedComposerCursor(text, expandedCursorAfterMention)).toBe(
      collapsedCursorAfterMention,
    );
  });

  it("maps expanded markdown file link cursors back to collapsed offsets", () => {
    const text = "what's in [AGENTS.md](AGENTS.md) please";
    const collapsedCursorAfterMention = "what's in ".length + 2;
    const expandedCursorAfterMention = "what's in [AGENTS.md](AGENTS.md) ".length;

    expect(collapseExpandedComposerCursor(text, expandedCursorAfterMention)).toBe(
      collapsedCursorAfterMention,
    );
  });

  it("keeps package-like text expanded when another mention already exists earlier", () => {
    const text = "open @AGENTS.md then @src/index.ts ";
    const expandedCursor = text.length;
    const collapsedCursor = collapseExpandedComposerCursor(text, expandedCursor);

    expect(collapsedCursor).toBe("open ".length + 1 + " then @src/index.ts ".length);
    expect(expandCollapsedComposerCursor(text, collapsedCursor)).toBe(expandedCursor);
  });

  it("collapses only genuine mentions when package-like text exists earlier", () => {
    const text = "install @scope/pkg then @README.md ";
    const expandedCursor = text.length;
    const collapsedCursor = collapseExpandedComposerCursor(text, expandedCursor);

    expect(collapsedCursor).toBe("install @scope/pkg then ".length + 1 + " ".length);
    expect(expandCollapsedComposerCursor(text, collapsedCursor)).toBe(expandedCursor);
  });

  it.each(["$", "€", "𑿝"])("maps expanded %s skill cursor back to collapsed cursor", (prefix) => {
    const text = `run ${prefix}review-follow-up then`;
    const collapsedCursorAfterSkill = "run ".length + 2;
    const expandedCursorAfterSkill = `run ${prefix}review-follow-up `.length;

    expect(collapseExpandedComposerCursor(text, expandedCursorAfterSkill)).toBe(
      collapsedCursorAfterSkill,
    );
  });
});

it("preserves the caret before trailing text after mixed-width skill chips", () => {
  const text = "𑿝ui a $review tail";
  const expanded = "𑿝ui a $review ".length;
  expect(collapseExpandedComposerCursor(text, expanded)).toBe(6);
  expect(expandCollapsedComposerCursor(text, 6)).toBe(expanded);
});

describe("clampCollapsedComposerCursor", () => {
  it("clamps to collapsed prompt length when mentions are present", () => {
    const text = "open @AGENTS.md then ";

    expect(clampCollapsedComposerCursor(text, text.length)).toBe(
      "open ".length + 1 + " then ".length,
    );
    expect(clampCollapsedComposerCursor(text, Number.POSITIVE_INFINITY)).toBe(
      "open ".length + 1 + " then ".length,
    );
  });
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
    expect(isCollapsedCursorAdjacentToInlineToken(text, prefix.length, "right")).toBe(true);
    expect(isCollapsedCursorAdjacentToInlineToken(text, prefix.length + 1, "left")).toBe(true);
    expect(isCollapsedCursorAdjacentToInlineToken(text, prefix.length + 2, "left")).toBe(false);
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

describe("replaceTextRange trailing space consumption", () => {
  it("double space after insertion when replacement ends with space", () => {
    // Simulates: "and then |@AG| summarize" where | marks replacement range
    // The replacement is "@AGENTS.md " (with trailing space)
    // But if we don't extend rangeEnd, the existing space stays
    const text = "and then @AG summarize";
    const rangeStart = "and then ".length;
    const rangeEnd = "and then @AG".length;

    // Without consuming trailing space: double space
    const withoutConsume = replaceTextRange(text, rangeStart, rangeEnd, "@AGENTS.md ");
    expect(withoutConsume.text).toBe("and then @AGENTS.md  summarize");

    // With consuming trailing space: single space
    const extendedEnd = text[rangeEnd] === " " ? rangeEnd + 1 : rangeEnd;
    const withConsume = replaceTextRange(text, rangeStart, extendedEnd, "@AGENTS.md ");
    expect(withConsume.text).toBe("and then @AGENTS.md summarize");
  });
});

describe("isCollapsedCursorAdjacentToInlineToken", () => {
  it("returns false when no mention exists", () => {
    expect(isCollapsedCursorAdjacentToInlineToken("plain text", 6, "left")).toBe(false);
    expect(isCollapsedCursorAdjacentToInlineToken("plain text", 6, "right")).toBe(false);
  });

  it("keeps @query typing non-adjacent while no mention pill exists", () => {
    const text = "hello @pac";
    expect(isCollapsedCursorAdjacentToInlineToken(text, text.length, "left")).toBe(false);
    expect(isCollapsedCursorAdjacentToInlineToken(text, text.length, "right")).toBe(false);
  });

  it("detects left adjacency only when cursor is directly after a mention", () => {
    const text = "open @AGENTS.md next";
    const mentionStart = "open ".length;
    const mentionEnd = mentionStart + 1;

    expect(isCollapsedCursorAdjacentToInlineToken(text, mentionEnd, "left")).toBe(true);
    expect(isCollapsedCursorAdjacentToInlineToken(text, mentionStart, "left")).toBe(false);
    expect(isCollapsedCursorAdjacentToInlineToken(text, mentionEnd + 1, "left")).toBe(false);
  });

  it("detects right adjacency only when cursor is directly before a mention", () => {
    const text = "open @AGENTS.md next";
    const mentionStart = "open ".length;
    const mentionEnd = mentionStart + 1;

    expect(isCollapsedCursorAdjacentToInlineToken(text, mentionStart, "right")).toBe(true);
    expect(isCollapsedCursorAdjacentToInlineToken(text, mentionEnd, "right")).toBe(false);
    expect(isCollapsedCursorAdjacentToInlineToken(text, mentionStart - 1, "right")).toBe(false);
  });

  it("treats context reference pills as inline tokens for adjacency checks", () => {
    const text = `open ${terminalReference} next`;
    const tokenStart = "open ".length;
    const tokenEnd = tokenStart + 1;

    expect(isCollapsedCursorAdjacentToInlineToken(text, tokenEnd, "left")).toBe(true);
    expect(isCollapsedCursorAdjacentToInlineToken(text, tokenStart, "right")).toBe(true);
  });

  it("treats skill pills as inline tokens for adjacency checks", () => {
    const text = "run $review-follow-up next";
    const tokenStart = "run ".length;
    const tokenEnd = tokenStart + 1;

    expect(isCollapsedCursorAdjacentToInlineToken(text, tokenEnd, "left")).toBe(true);
    expect(isCollapsedCursorAdjacentToInlineToken(text, tokenStart, "right")).toBe(true);
  });
});

describe("parseStandaloneComposerSlashCommand", () => {
  it("parses standalone /plan command", () => {
    expect(parseStandaloneComposerSlashCommand(" /plan ")).toBe("plan");
  });

  it("parses standalone /default command", () => {
    expect(parseStandaloneComposerSlashCommand("/default")).toBe("default");
  });

  it("ignores slash commands with extra message text", () => {
    expect(parseStandaloneComposerSlashCommand("/plan explain this")).toBeNull();
  });
});

describe("local side chat commands", () => {
  it("opens an empty side chat or carries a question into its composer", () => {
    expect(parseSideChatPrompt("/side")).toBe("");
    expect(parseSideChatPrompt("  /side explain the last step\nand its tradeoffs  ")).toBe(
      "explain the last step\nand its tradeoffs",
    );
  });
  it("does not intercept similarly named commands or a mention in ordinary prose", () => {
    expect(parseSideChatPrompt("/sideshow")).toBeNull();
    expect(parseSideChatPrompt("What does /side mean?")).toBeNull();
    expect(parseSideChatPrompt("/side-effect test")).toBeNull();
  });
});

it("keeps pull-request completion and inline context intact within a side prompt", () => {
  const prompt = "/side compare [Terminal 1](t3-context://v1/terminal/terminal-one) with #42";
  const trigger = detectComposerTrigger(prompt, prompt.length)!;
  expect(trigger.kind).toBe("pull-request");
  const selected = replaceTextRange(
    prompt,
    trigger.rangeStart,
    trigger.rangeEnd,
    "[#42](t3-context://v1/review-comment/pr-42)",
  );
  expect(parseSideChatPrompt(selected.text)).toBe(
    "compare [Terminal 1](t3-context://v1/terminal/terminal-one) with [#42](t3-context://v1/review-comment/pr-42)",
  );
  expect(parseStandaloneComposerSlashCommand(selected.text)).toBeNull();
});

it("carries inline context payloads into the plain-text side composer", () => {
  const prompt = parseSideChatPrompt(
    "/side explain [terminal](t3-context://v1/terminal/terminal-one)",
    [
      {
        version: 1,
        contextId: "terminal-one" as never,
        kind: "terminal",
        label: "terminal",
        terminalId: "default",
        terminalLabel: "Terminal 1",
        lineStart: 1,
        lineEnd: 1,
        text: "build failure details",
      },
    ],
  );
  expect(prompt).toContain("build failure details");
  expect(prompt).not.toContain("t3-context://");
});

it("preserves a commented assistant citation when transferring a multiline side question", () => {
  const quoted = { ...citation, comment: "Explain the tradeoff\nand the alternative." };
  const prompt = `/side ${serializeAssistantCitation(quoted)}\nHow does this affect the fix?`;
  const sidePrompt = parseSideChatPrompt(prompt)!;
  expect(collectAssistantCitations(sidePrompt).map((entry) => entry.citation)).toEqual([quoted]);
  expect(expandAssistantCitationsForProvider(sidePrompt)).toContain(JSON.stringify(quoted.comment));
  expect(expandAssistantCitationsForProvider(sidePrompt)).toContain(
    "How does this affect the fix?",
  );
  expect(
    composerSubmissionIntentForEnter({
      isMobileViewport: false,
      shiftKey: false,
      modifierKey: false,
      isDraftThread: false,
      sendShortcut: "mod-enter-multiline",
      prompt,
    }),
  ).toBeNull();
});
