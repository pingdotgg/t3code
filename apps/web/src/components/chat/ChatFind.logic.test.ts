import { describe, expect, it } from "vite-plus/test";
import { MessageId, TurnId } from "@t3tools/contracts";

import type { TimelineEntry } from "../../session-logic";
import {
  buildChatFindPattern,
  chatFindEntrySource,
  collectChatFindMatches,
  findPatternSpans,
  formatChatFindCount,
  markdownSearchText,
  resolveActiveMatchIndex,
  stepChatFindIndex,
} from "./ChatFind.logic";

const at = "2026-01-01T00:00:00.000Z";

function message(
  id: string,
  text: string,
  options: { turnId?: string | null; role?: "user" | "assistant" | "reasoning" | "system" } = {},
): TimelineEntry {
  const turnId = options.turnId === undefined ? "turn-1" : options.turnId;
  return {
    id,
    kind: "message",
    createdAt: at,
    message: {
      id: MessageId.make(id),
      role: options.role ?? "user",
      text,
      turnId: turnId === null ? null : TurnId.make(turnId),
      streaming: false,
      createdAt: at,
      updatedAt: at,
    },
  };
}

function plan(id: string, planMarkdown: string): TimelineEntry {
  return {
    id,
    kind: "proposed-plan",
    createdAt: at,
    proposedPlan: {
      id,
      turnId: TurnId.make("plan-turn"),
      planMarkdown,
      implementedAt: null,
      implementationThreadId: null,
      createdAt: at,
      updatedAt: at,
    },
  };
}

describe("buildChatFindPattern", () => {
  it("returns null for blank queries", () => {
    expect(buildChatFindPattern("")).toBeNull();
    expect(buildChatFindPattern("   ")).toBeNull();
  });

  it("matches literally and case-insensitively", () => {
    const pattern = buildChatFindPattern("a.b(c)")!;
    expect(findPatternSpans("x A.B(C) y a.b(c)", pattern)).toEqual([
      { start: 2, end: 8 },
      { start: 11, end: 17 },
    ]);
    expect(findPatternSpans("axb(c)", pattern)).toEqual([]);
  });

  it("lets query whitespace match any whitespace run", () => {
    const pattern = buildChatFindPattern("  hello   world ")!;
    expect(findPatternSpans("hello\n  world", pattern)).toEqual([{ start: 0, end: 13 }]);
    expect(findPatternSpans("helloworld", pattern)).toEqual([]);
  });
});

describe("markdownSearchText", () => {
  it("drops delimiters and link targets but keeps their text", () => {
    expect(
      markdownSearchText("Use **bold** and _em_ with `code` and [docs](https://x.test/a)."),
    ).toBe("Use bold and em with code and docs.");
    // Images render no text, so their alt is not counted.
    expect(markdownSearchText("![alt text](https://x.test/i.png) <https://x.test>").trim()).toBe(
      "https://x.test",
    );
  });

  it("keeps escaped punctuation and character references as rendered", () => {
    expect(
      markdownSearchText("**MAX\\_RETRIES** and \\*not em\\* &lt;div&gt; &amp; &#39;x&#39; &#x41;"),
    ).toBe("MAX_RETRIES and *not em* <div> & 'x' A");
  });

  it("drops table pipes but keeps cell text", () => {
    const text = markdownSearchText("| a | b |\n|---|---|\n| alpha | beta |");
    expect(text.replace(/\s+/g, " ").trim()).toBe("a b alpha beta");
    expect(text).not.toContain("|");
  });

  it("restores code that was captured inside another fence", () => {
    const text = markdownSearchText("~~~~\n```sh\nnpm install\n```\n~~~~");
    expect(text).toContain("npm install");
    expect(text).not.toContain("\uE000");
  });

  it("keeps raw HTML literal when the renderer does", () => {
    expect(markdownSearchText("Why does <Suspense> fail?", { rawHtml: false })).toBe(
      "Why does <Suspense> fail?",
    );
    expect(markdownSearchText("Why does <Suspense> fail?")).toBe("Why does  fail?");
  });

  it("replaces file paths with the chip label the renderer shows", () => {
    expect(
      markdownSearchText("I changed `apps/web/src/ChatView.tsx` and `src/wsServer.ts:120`.", {
        cwd: "/repo",
      }),
    ).toBe("I changed ChatView.tsx and wsServer.ts · L120.");
    expect(
      markdownSearchText("see [the file](</repo/src/bar.ts>) and [docs](https://x.test)"),
    ).toBe("see bar.ts and docs");
    // Without a workspace, a relative path is plain code.
    expect(markdownSearchText("run `src/index.ts`")).toBe("run src/index.ts");
  });

  it("drops block markers but keeps content", () => {
    const text = markdownSearchText(
      "# Title\n\n> quoted\n\n- [ ] task one\n1. step\n\n```ts\nconst a = 1;\n```",
    );
    // Whitespace runs collapse in the pattern, so only the words matter here.
    expect(text.replace(/\s+/g, " ").trim()).toBe("Title quoted task one step const a = 1;");
  });

  it("keeps HTML-shaped text inside code while dropping real tags", () => {
    const text = markdownSearchText(
      "Use `<div>` here\n\n```html\n<p>hi **there**</p>\n```\n\n<span>real</span>",
    );
    expect(text.replace(/\s+/g, " ").trim()).toBe("Use <div> here <p>hi **there**</p> real");
  });

  it("keeps code inside fences longer than three delimiters", () => {
    const text = markdownSearchText(
      "````md\n```js\nrun **now**\n```\n````\n\n~~~~\n<b>hi</b>\n~~~~\n\n**after**",
    );
    expect(text.replace(/\s+/g, " ").trim()).toBe("```js run **now** ``` <b>hi</b> after");
  });

  it("does not count a delimiter-only query", () => {
    const entries = [message("m1", "Use **bold** here")];
    expect(collectChatFindMatches(entries, buildChatFindPattern("**"))).toEqual([]);
    expect(collectChatFindMatches(entries, buildChatFindPattern("bold"))).toHaveLength(1);
  });
});

describe("collectChatFindMatches", () => {
  it("lists one match per occurrence in timeline order, for messages and plans", () => {
    const entries = [
      message("m1", "Fix the login bug", { turnId: "t1" }),
      message("m2", "No match here", { turnId: "t1", role: "assistant" }),
      plan("p1", "# Plan\n\n1. Reproduce the login bug\n2. Fix login"),
      message("m3", "login", { turnId: null }),
    ];
    expect(collectChatFindMatches(entries, buildChatFindPattern("LOGIN"))).toEqual([
      { entryId: "m1", turnId: TurnId.make("t1"), occurrence: 0 },
      { entryId: "p1", turnId: TurnId.make("plan-turn"), occurrence: 0 },
      { entryId: "p1", turnId: TurnId.make("plan-turn"), occurrence: 1 },
      { entryId: "m3", turnId: null, occurrence: 0 },
    ]);
  });

  it("returns nothing without a pattern", () => {
    expect(collectChatFindMatches([message("m1", "text")], null)).toEqual([]);
  });

  it("skips entries that are not messages or plans", () => {
    expect(chatFindEntrySource({ kind: "work" } as unknown as TimelineEntry)).toBeNull();
  });

  it("counts user text the way the user row renders it", () => {
    const entries = [
      message("u1", "Why does <Suspense> not catch it? [ctx](t3-context://v1/file/abc123)"),
    ];
    expect(collectChatFindMatches(entries, buildChatFindPattern("suspense"))).toHaveLength(1);
    // Context chips are buttons with no text.
    expect(collectChatFindMatches(entries, buildChatFindPattern("ctx"))).toEqual([]);
  });

  it("counts Codex file citations by the chip label they render as", () => {
    const entries = [
      message("a1", 'See :codex-file-citation{path="/repo/apps/web/src/lib/bar.ts"} now.', {
        role: "assistant",
      }),
    ];
    expect(collectChatFindMatches(entries, buildChatFindPattern("bar.ts"))).toHaveLength(1);
    expect(collectChatFindMatches(entries, buildChatFindPattern("src"))).toEqual([]);
  });

  it("counts a plan as its card shows it: title, then body without the title heading", () => {
    const entries = [plan("p1", "# Fix login\n\n## Summary\n\nDo X to fix login")];
    expect(collectChatFindMatches(entries, buildChatFindPattern("fix login"))).toHaveLength(2);
    expect(collectChatFindMatches(entries, buildChatFindPattern("summary"))).toEqual([]);
    expect(
      collectChatFindMatches([plan("p2", "Just do it")], buildChatFindPattern("proposed plan")),
    ).toHaveLength(1);
  });

  it("reuses the normalized text while an entry is unchanged", () => {
    const entry = message("m1", "**bold** text");
    const first = chatFindEntrySource(entry)!.text;
    expect(chatFindEntrySource(entry)!.text).toBe(first);
    expect(
      chatFindEntrySource({ ...entry, message: { ...entry.message, text: "plain" } })!.text,
    ).toBe("plain");
  });

  it("skips thinking and system messages, which have no row of their own", () => {
    const entries = [
      message("r1", "login thoughts", { role: "reasoning" }),
      message("s1", "login system note", { role: "system" }),
      message("a1", "login answer", { role: "assistant" }),
    ];
    expect(collectChatFindMatches(entries, buildChatFindPattern("login"))).toEqual([
      { entryId: "a1", turnId: TurnId.make("turn-1"), occurrence: 0 },
    ]);
  });
});

describe("active match selection", () => {
  const matches = collectChatFindMatches(
    [message("m1", "a a"), message("m2", "a")],
    buildChatFindPattern("a"),
  );

  it("keeps the active match by identity when the list shifts", () => {
    const active = matches[2]!;
    const prepended = collectChatFindMatches(
      [message("m0", "a"), message("m1", "a a"), message("m2", "a")],
      buildChatFindPattern("a"),
    );
    expect(resolveActiveMatchIndex(prepended, active)).toBe(3);
  });

  it("falls back to the first match when the active one is gone", () => {
    expect(resolveActiveMatchIndex(matches, { entryId: "gone", turnId: null, occurrence: 0 })).toBe(
      0,
    );
    expect(resolveActiveMatchIndex(matches, null)).toBe(0);
    expect(resolveActiveMatchIndex([], matches[0]!)).toBe(-1);
  });

  it("steps with wrap-around", () => {
    expect(stepChatFindIndex(0, 3, 1)).toBe(1);
    expect(stepChatFindIndex(2, 3, 1)).toBe(0);
    expect(stepChatFindIndex(0, 3, -1)).toBe(2);
    expect(stepChatFindIndex(-1, 3, -1)).toBe(2);
    expect(stepChatFindIndex(0, 0, 1)).toBe(-1);
  });

  it("formats the counter", () => {
    expect(formatChatFindCount(-1, 0)).toBe("No results");
    expect(formatChatFindCount(1, 3)).toBe("2/3");
  });
});
