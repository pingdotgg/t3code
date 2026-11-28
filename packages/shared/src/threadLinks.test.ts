import { describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { mFallback } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";
import remarkParse from "remark-parse";
import { unified } from "unified";

import {
  formatHostedThreadLink,
  formatThreadLink,
  guessThreadLinkRef,
  hostedThreadLink,
  parseThreadLinkHref,
  replaceThreadLinks,
  threadLinkCandidates,
  threadLinkRefs,
} from "./threadLinks.ts";
import { relabelThreadLinks } from "./threadLinksCopy.ts";

const ref = (environmentId: string, threadId = "chat-1") => ({
  environmentId: EnvironmentId.make(environmentId),
  threadId: ThreadId.make(threadId),
});
const v1 = (threadId: string) => ({ environmentId: null, threadId: ThreadId.make(threadId) });
const local = EnvironmentId.make("local");
const titlesIn =
  (titles: Record<string, Record<string, string>>) =>
  ({ environmentId, threadId }: ScopedThreadRef) =>
    titles[environmentId]?.[threadId];
const japanese: MFunctionType = (encodedMsg, options) => {
  const english = mFallback(encodedMsg, options);
  return (
    english === "Thread no longer available" ? "スレッドは利用できなくなりました" : english
  ) as typeof english;
};

describe("thread link destinations", () => {
  it("names a v1 link's thread in the message's environment, as written and then decoded", () => {
    expect(threadLinkCandidates(v1("provider%3A1"), local)).toEqual([
      ref("local", "provider%3A1"),
      ref("local", "provider:1"),
    ]);
  });

  it("opens the unique matching chat in another environment for a v1 link", () => {
    const destination = ref("remote");
    expect(guessThreadLinkRef(v1("chat-1"), [ref("local", "other-chat"), destination])).toEqual(
      destination,
    );
  });

  it("opens a v2 link only in its own environment", () => {
    const there = ref("there", "a%3A1");
    expect(threadLinkCandidates(there, local)).toEqual([there, ref("there", "a:1")]);
    expect(guessThreadLinkRef(there, [ref("elsewhere", "a%3A1"), ref("elsewhere", "a:1")])).toBe(
      null,
    );
  });

  it("leaves ambiguous or missing destinations unresolved", () => {
    const link = v1("provider%3A1");
    const literal = ref("remote", "provider%3A1");
    const decoded = ref("remote", "provider:1");
    expect(
      guessThreadLinkRef(link, [literal, ref("other-remote", literal.threadId), decoded]),
    ).toBeNull();
    expect(guessThreadLinkRef(link, [decoded, ref("other-remote", decoded.threadId)])).toBeNull();
    expect(guessThreadLinkRef(link, [ref("remote", "other-chat")])).toBeNull();
  });
});

describe("thread links", () => {
  it("takes the ids verbatim, percent escapes included", () => {
    expect(parseThreadLinkHref("t3-thread://v1/mcp:1234")).toEqual(v1("mcp:1234"));
    expect(parseThreadLinkHref("t3-thread://v1/thread:delegated-task:mcp%3A1")).toEqual(
      v1("thread:delegated-task:mcp%3A1"),
    );
    expect(parseThreadLinkHref("t3-thread://v2/env-1/thread:a/b%3A1")).toEqual(
      ref("env-1", "thread:a/b%3A1"),
    );
  });

  it("rejects other links and an empty id", () => {
    expect(parseThreadLinkHref("https://t3.codes")).toBeNull();
    expect(parseThreadLinkHref("t3-thread://v1/")).toBeNull();
    expect(parseThreadLinkHref("t3-thread://v1/ ")).toBeNull();
    expect(parseThreadLinkHref("t3-thread://v2/env-1")).toBeNull();
    expect(parseThreadLinkHref("t3-thread://v2/env-1/")).toBeNull();
    expect(parseThreadLinkHref("t3-thread://v2//chat-1")).toBeNull();
  });

  it("resolves a percent-encoded id when the id as written names no thread", () => {
    const title = titlesIn({ local: { "thread:project:1": "Decoded", "provider%3A1": "Literal" } });
    expect(
      relabelThreadLinks(
        "[a](t3-thread://v1/thread%3Aproject%3A1) [b](t3-thread://v1/provider%3A1)",
        local,
        title,
      ),
    ).toBe("[Decoded](t3-thread://v1/thread:project:1) [Literal](t3-thread://v1/provider%3A1)");
    const untitled = titlesIn({ local: { "a%3A1": "", "a:1": "Other" } });
    expect(relabelThreadLinks("[Kept](t3-thread://v1/a%3A1)", local, untitled)).toBe(
      "[Kept](t3-thread://v1/a%3A1)",
    );
  });

  it("titles a v2 link from its own environment and writes it with that title", () => {
    const title = titlesIn({ local: { t1: "Here" }, there: { t1: "There" } });
    expect(
      relabelThreadLinks(
        "<t3-thread://v2/there/t1> and [old](t3-thread://v2/local/t1)",
        local,
        title,
      ),
    ).toBe("[There](t3-thread://v2/there/t1) and [Here](t3-thread://v2/local/t1)");
  });

  it("reads an angle-bracketed destination as the labeled link, not an autolink", () => {
    const title = titlesIn({ local: { t1: "Here" }, there: { t1: "There" } });
    expect(
      relabelThreadLinks(
        "[old](<t3-thread://v2/there/t1>) and [older](<t3-thread://v2/local/t1>)",
        local,
        title,
      ),
    ).toBe("[There](t3-thread://v2/there/t1) and [Here](t3-thread://v2/local/t1)");
    expect(
      relabelThreadLinks("[Kept label](<t3-thread://v2/local/t1>)", local, () => undefined),
    ).toBe("Kept label");
    expect(threadLinkRefs("[a](<t3-thread://v2/there/t2>)", local)).toEqual([ref("there", "t2")]);
    for (const threadId of ["mcp:launch:qa(1)", "mcp:launch:qa)"]) {
      const thread = ref("there", threadId);
      const link = formatThreadLink(thread, "Original");
      expect(link).toBe(`[Original](<t3-thread://v2/there/${threadId}>)`);
      expect(threadLinkRefs(link, local)).toEqual([thread]);
      expect(relabelThreadLinks(link, local, () => "Renamed")).toBe(
        `[Renamed](<t3-thread://v2/there/${threadId}>)`,
      );
      expect(relabelThreadLinks(link, local, () => undefined)).toBe("Original");
    }
    for (const threadId of ["mcp:launch:qa(1)", "feature(a(b))"]) {
      const thread = ref("there", threadId);
      const unbracketed = `[Original](t3-thread://v2/there/${threadId})`;
      expect(threadLinkRefs(unbracketed, local)).toEqual([thread]);
      expect(relabelThreadLinks(unbracketed, local, () => "Renamed")).toBe(
        `[Renamed](<t3-thread://v2/there/${threadId}>)`,
      );
      expect(relabelThreadLinks(unbracketed, local, () => undefined)).toBe("Original");
    }
    expect(threadLinkRefs("[Original](t3-thread://v2/there/feature\\(test\\))", local)).toEqual([
      ref("there", "feature(test)"),
    ]);
    expect(
      relabelThreadLinks(
        "[Original](t3-thread://v2/there/feature\\(test\\))",
        local,
        () => undefined,
      ),
    ).toBe("Original");
    const unbalanced = "[Original](t3-thread://v2/there/feature(test)";
    expect(threadLinkRefs(unbalanced, local)).toEqual([]);
    expect(relabelThreadLinks(unbalanced, local, () => "Renamed")).toBe(unbalanced);
  });

  it("turns a v2 link it cannot resolve into plain text, never the raw link", () => {
    expect(
      relabelThreadLinks(
        "<t3-thread://v2/there/t1>, <t3-thread://v2/local/t1>, [Old title](t3-thread://v2/there/t1)",
        local,
        () => undefined,
      ),
    ).toBe("Thread on another machine, Thread no longer available, Old title");
    expect(relabelThreadLinks("[Old](t3-thread://v1/t1)", local, () => undefined)).toBe(
      "[Old](t3-thread://v1/t1)",
    );
    expect(relabelThreadLinks("See <t3-thread://v1/gone>", local, () => undefined, japanese)).toBe(
      "See スレッドは利用できなくなりました",
    );
  });

  it.each(["\r", "\r\n", "\n"])(
    "keeps BOM-prefixed thread link examples literal with %j line endings",
    (eol) => {
      const link = "<t3-thread://v2/local/t>";
      for (const fence of ["~~~", "```"]) {
        const example = [`\uFEFF${fence}`, link, fence].join(eol);
        expect(replaceThreadLinks(`${example}${eol}${link}`, () => "linked")).toBe(
          `${example}${eol}linked`,
        );
      }
    },
  );

  it.each([
    ["    ", ""],
    ["\t", ""],
    [">     ", "> "],
    ["-     ", ""],
  ])(
    "rewrites prose links after an indented code line that looks like a fence (%j)",
    (indent, prose) => {
      for (const bom of ["", "\uFEFF"]) {
        const example = `${bom}${indent}~~~\n${prose.trimEnd()}\n${prose}See `;
        expect(replaceThreadLinks(`${example}<t3-thread://v2/local/t>`, () => "linked")).toBe(
          `${example}linked`,
        );
      }
    },
  );

  it.each([
    ["a blank line", "Intro\n\n", "    ", "~~~", ""],
    ["an indented heading", "Intro\n  # Example\n", "    ", "~~~", ""],
    ["a closed fence", "Intro\n```\nexample\n```\n", "    ", "~~~", ""],
    ["a literal list marker", "# Example\n", "    ", "- ```md", ""],
    ["a heading in a quote", "> # Example\n", ">     ", "~~~", "> "],
  ])(
    "keeps indented code literal and rewrites prose after %s",
    (_name, before, indent, fence, quote) => {
      const inside = "<t3-thread://v2/local/code>";
      const outside = "<t3-thread://v2/local/prose>";
      const example = `${before}${indent}${fence}\n${indent}${inside}\n${quote.trimEnd()}\n${quote}See `;
      expect(replaceThreadLinks(`${example}${outside}`, () => "linked")).toBe(`${example}linked`);
    },
  );

  it.each([
    ["a paragraph with four spaces", "Intro\n    ~~~"],
    ["a paragraph with a tab", "Intro\n\t```"],
    ["a list paragraph", "- Intro\n      ~~~"],
    ["an HTML block", "<div>\n    ~~~\n</div>"],
    ["deeply nested quotes", ">".repeat(6000) + " text\n\n    ~~~"],
  ])("rewrites the prose link after %s", (_name, before) => {
    const prose = `${before}\n\nSee `;
    expect(replaceThreadLinks(`${prose}<t3-thread://v2/local/prose>`, () => "linked")).toBe(
      `${prose}linked`,
    );
  });

  it("rewrites a link in footnote prose before an indented fence", () => {
    const footnote = "Note[^n].\n\n[^n]: note\n\n    See ";
    expect(
      replaceThreadLinks(`${footnote}<t3-thread://v2/local/prose>\n\n    ~~~`, () => "linked"),
    ).toBe(`${footnote}linked\n\n    ~~~`);
  });

  it.each([
    ["a paragraph code span", "Intro\n    ```\n    <t3-thread://v2/local/code>\n    ```"],
    [
      "a fence with over-indented markers",
      "~~~\n    ~~~\n    ~~~\n<t3-thread://v2/local/code>\n~~~",
    ],
    [
      "a fence in a footnote",
      "Note[^n].\n\n[^n]: note\n\n    ~~~\n    <t3-thread://v2/local/code>\n    ~~~",
    ],
  ])("keeps links literal inside %s and rewrites the link after it", (_name, code) => {
    const prose = `${code}\n\nSee `;
    expect(replaceThreadLinks(`${prose}<t3-thread://v2/local/prose>`, () => "linked")).toBe(
      `${prose}linked`,
    );
  });

  it.each([
    ["4 spaces", "    ```md\n    <t3-thread://v1/abc>\n    ```", ""],
    ["tab", "\t```md\n\t<t3-thread://v1/abc>\n\t```", ""],
    ["list + 5 spaces", "-     ```md\n      <t3-thread://v1/abc>\n      ```", ""],
    ["nested list", "- a\n  -     ```md\n        <t3-thread://v1/abc>\n        ```", ""],
    ["nested list with tab", "-\t-     ~~~\n          <t3-thread://v1/abc>", ""],
    ["quote + 5 spaces", ">     ```md\n>     <t3-thread://v1/abc>\n>     ```", "> "],
    [
      "spaced nested quote + 5 spaces",
      ">    >     ```md\n>    >     <t3-thread://v1/abc>",
      ">    > ",
    ],
    ["quote + list + 5 spaces", "> -     ```md\n>       <t3-thread://v1/abc>\n>       ```", "> "],
    ["quote + space + tab + list", "> \t-     ```md\n>         <t3-thread://v1/abc>", "> "],
    [
      "quote + list after para",
      "> para\n> -     ```md\n>       <t3-thread://v1/abc>\n>       ```",
      "> ",
    ],
    ["1. after paragraph", "Intro\n1.     ```md\n       <t3-thread://v1/abc>\n       ```", ""],
    ["ordered list >= 2 after blank", "Intro\n\n2.     ```md\n       <t3-thread://v1/abc>", ""],
    [
      "quote after blank line past closer",
      "Example\n\n>       ~~~\n>       ~~~\n>       <t3-thread://v1/abc>",
      "> ",
    ],
    ["quote after autolink", "<https://example.com>\n>     ~~~\n>     <t3-thread://v1/abc>", "> "],
    ["blank line inside indented code", "    ```md\n\n    <t3-thread://v1/abc>", ""],
    ["quote after indented code", "    ```md\n>     ```\n>     <t3-thread://v1/abc>", "> "],
    ["4 spaces after closer", "    ```md\n    a\n    ```\n    <t3-thread://v1/abc>", ""],
    ["4 spaces with U+2028", "    ```\u2028<t3-thread://v1/t1>```", ""],
    ["hosted link", "    ```\n    https://app.t3.codes/threads/env/thr\n    ```", ""],
  ])(
    "keeps links inside fence-looking indented code blocks literal (%s)",
    (_name, block, prose) => {
      expect(replaceThreadLinks(block, () => "linked")).toBe(block);
      const after = `${block}\n${prose.trimEnd()}\n${prose}See `;
      expect(replaceThreadLinks(`${after}<t3-thread://v2/local/t>`, () => "linked")).toBe(
        `${after}linked`,
      );
    },
  );

  it("leaves links inside code spans and fences as written", () => {
    const markdown = [
      "Live [old](t3-thread://v1/t1), literal `[old](t3-thread://v1/t1)`.",
      "```md",
      "<t3-thread://v2/local/t1>",
      "```",
      "After <t3-thread://v2/local/t1>",
    ].join("\n");
    expect(relabelThreadLinks(markdown, local, () => "New")).toBe(
      [
        "Live [New](t3-thread://v1/t1), literal `[old](t3-thread://v1/t1)`.",
        "```md",
        "<t3-thread://v2/local/t1>",
        "```",
        "After [New](t3-thread://v2/local/t1)",
      ].join("\n"),
    );
    const nested = [
      "> > ```md",
      ">> <t3-thread://v2/local/t1>",
      ">>```",
      "> > <t3-thread://v2/local/t1>",
    ];
    expect(relabelThreadLinks(nested.join("\n"), local, () => "New")).toBe(
      [...nested.slice(0, 3), "> > [New](t3-thread://v2/local/t1)"].join("\n"),
    );
    const deepNested = "> > > > > ```\n> > > > > <t3-thread://v2/local/t1> ```";
    expect(relabelThreadLinks(deepNested, local, () => "New")).toBe(deepNested);
    const labels: Array<string | undefined> = [];
    const separated = "[Label\u2028> > example](t3-thread://v1/t1)";
    expect(replaceThreadLinks(separated, (_link, label) => void labels.push(label))).toBe(
      separated,
    );
    expect(labels).toEqual(["Label\u2028> > example"]);
    for (const escaped of ["\\``<t3-thread://v2/env-1/t1>`", "\\```<t3-thread://v2/env-1/t1>``"]) {
      expect(threadLinkRefs(escaped, local)).toEqual([]);
    }
    const indented = "    <t3-thread://v2/local/demo>\n\nSee <t3-thread://v2/local/prose>";
    expect(threadLinkRefs(indented, local)).toEqual([ref("local", "prose")]);
    expect(relabelThreadLinks(indented, local, () => "New")).toBe(
      "    <t3-thread://v2/local/demo>\n\nSee [New](t3-thread://v2/local/prose)",
    );
    expect(relabelThreadLinks("\t<t3-thread://v2/local/demo>", local, () => "New")).toBe(
      "\t<t3-thread://v2/local/demo>",
    );
    expect(relabelThreadLinks(">     <t3-thread://v2/local/demo>", local, () => "New")).toBe(
      ">     <t3-thread://v2/local/demo>",
    );
    expect(relabelThreadLinks("Intro\n    <t3-thread://v2/local/prose>", local, () => "New")).toBe(
      "Intro\n    [New](t3-thread://v2/local/prose)",
    );
  });

  it("ends code where CommonMark does, so a link after it stays live", () => {
    const after = "See <t3-thread://v2/env-1/t1>";
    const hidden = "<t3-thread://v2/local/in-code>";
    for (const markdown of [
      ["```ts", 'const fence = "```";', hidden, "```", after],
      ["> ```ts", '> const fence = "```";', `> ${hidden}`, "> ```", `> ${after}`],
      ["> ```", ` > ${hidden}`, "> ```", after],
      ["- ```bash", "  echo hi", "  ```", "", after],
      ["- ```text", `  ${hidden}`, "", after],
      ["- item", "", "  ```text", `  ${hidden}`, "", after],
      ["[^note]: - ```text", "      https://app.t3.codes/threads/local/in-code", "", after],
      [
        "[^outer]: [^inner]: - ```text",
        "          https://app.t3.codes/threads/local/in-code",
        "",
        after,
      ],
      ["- > ```md", `  > ${hidden}`, "  > ```", "", after],
      [">> ```md", `> > ${hidden}`, ">> ```", `> ${after}`],
      ["> > ~~~", `>> ${hidden}`, ">> ~~~", after],
      ["1. Run:", "", "    ```bash", '    echo "```"', `    ${hidden}`, "    ```", "", after],
      ["````md", "```", hidden, "````", after],
      ["Use ~~~ to mark it.", after],
      ["> para", ">     ~~~", `>     ${after}`],
      ["> para", `>     ~~~ ${after}`],
      ["- > para", "  >     ```md", `  >     ${after}`],
      [`Intro\u2028-     ~~~ ${after}`],
      ["Intro", `2.     ~~~ ${after}`],
      ["Intro", `2. -     ~~~ ${after}`],
      [">\t-     ```md", `>       ${after}`],
      ["> para", "lazy", ">     ~~~", `>     ${after}`],
      ["> para", "> 2. >", `> 2.     ~~~ ${after}`],
      ["> para\r", ">     ~~~\r", `>     ${after}`],
      [`> para\r\r>     ~~~\r>     ${hidden}\r> ${after}`],
      ["para", "    -     ```", `    ${after}`],
      ["para", "    -     ```", `          ${after}`],
      ["    ~~~", `-   ${after}`],
      ["    ~~~md", "    ~~~", "    ~~~", after],
      ["- item", "  >     ~~~", `  >     ${hidden}`, `    ${after}`],
      ["10. >     ```md", `    >     ${hidden} \`\`\``, "", after],
      ["  - >     ```md", `    >     ${hidden} \`\`\``, "", after],
      ["> - Run this:", ">", ">     ```bash", ">   echo hi", ">", ">     ```", `>     ${after}`],
      ["Example", "", ">     ~~~", ">\t\t~~~", `>     ${hidden}`, ">\t\t~~~", `> ${after}`],
      [after, ">     ~~~", `>     ${hidden}`],
      [`1.       \`\`\`md ${hidden}`, `   \t${after}`],
      [">      ```md", `> \t${after}`],
      [">     ```md", `>\t ${after}`],
      ["```" + hidden + "``` then", after],
      ["Use ```example", hidden, "end``` then", after],
      ["Stray ` tick", "", after, "and `code`"],
      ["Stray ` tick", `# ${after}`, "and `code`"],
      ["Stray ` tick", `- ${after}`, "and `code`"],
      ["Stray ` tick", `> ${after} and \`code\``],
      ["> Stray ` tick", `> > ${after} and \`code\``],
      ["- Stray ` tick", `  > ${after} and \`code\``],
      ["> Use `example", `> ${hidden} end\``, `> ${after}`],
      ["> > Use `example", `> > ${hidden} end\``, `> > ${after}`],
      ["> Use `example", `${hidden} end\``, after],
      ["Use `example", `    > ${hidden} end\``, after],
      ["> Use `example", `>     > ${hidden} end\``, `> ${after}`],
      ["> Intro", "Use `example", `> ${hidden} end\``, `> ${after}`],
      ["> > Intro", "> Use `example", `> > ${hidden} end\``, `> > ${after}`],
      ["1. Stray ` tick", `    > ${after} and \`code\``],
      ["1. Intro", "", "    Stray ` tick", `    > ${after} and \`code\``],
      ["- Intro", "", "Use `example", `    > ${hidden} end\``, after],
      ...["- - -", "* \t* *", "___", "===", "-"].flatMap((boundary) => [
        ["Stray ` tick", boundary, `${after} and \`code\``],
        ["> Stray ` tick", `> ${boundary}`, `> ${after} and \`code\``],
      ]),
      ["Stray ` tick\r", "  ---\r", `${after} and \`code\``],
      ["> Stray ` tick", "---", `${after} and \`code\``],
      ["Use `example", "```" + hidden + "`", after],
      ["\\\\``" + after + "`"],
      [`Use \`example\r${hidden} end\`. Stray \` tick\r\r${after}\rand \`code\``],
      [`Stray \` tick\r# ${after}\rand \`code\``],
    ]) {
      const joined = markdown.join("\n");
      expect(threadLinkRefs(joined, local)).toEqual([ref("env-1", "t1")]);
      expect(relabelThreadLinks(joined, local, () => "New")).toBe(
        joined.replace("<t3-thread://v2/env-1/t1>", "[New](t3-thread://v2/env-1/t1)"),
      );
    }
  });

  it("keeps multiline code literal when a line only resembles a block boundary", () => {
    for (const markdown of [
      ...["--- text", "== =", "-_*", "    ==="].map((line) => ["Use `example", line]),
      ["> Use `example", ">     ---"],
      ["> Use `example", "==="],
    ]) {
      const source = [...markdown, "<t3-thread://v2/local/t1> end`"].join("\n");
      expect(threadLinkRefs(source, local)).toEqual([]);
      expect(relabelThreadLinks(source, local, () => "New")).toBe(source);
    }
  });

  it("lists the threads a message's links can name, outside code", () => {
    expect(
      threadLinkRefs(
        "<t3-thread://v2/there/t1> [a](t3-thread://v1/t%3A2) `<t3-thread://v2/code/t3>`",
        local,
      ),
    ).toEqual([ref("there", "t1"), ref("local", "t%3A2"), ref("local", "t:2")]);
  });

  it("lists a message's thread links on runtimes whose matchAll omits named groups, such as Hermes", () => {
    const matchAll = String.prototype.matchAll;
    using _hermes = vi.spyOn(String.prototype, "matchAll").mockImplementation(function (
      this: string,
      regexp: RegExp,
    ) {
      return matchAll.call(this, regexp).map((match) => {
        delete match.groups;
        return match;
      });
    });
    expect(threadLinkRefs("<t3-thread://v2/local/t1> [a](t3-thread://v2/there/t2)", local)).toEqual(
      [ref("local", "t1"), ref("there", "t2")],
    );
  });

  it("writes a titleless autolink that opens that exact thread", () => {
    const link = formatThreadLink(ref("env-1", "thread:delegated-task:mcp%3A1"));
    expect(link).toBe("<t3-thread://v2/env-1/thread:delegated-task:mcp%3A1>");
    expect(parseThreadLinkHref(link.slice(1, -1))).toEqual(
      ref("env-1", "thread:delegated-task:mcp%3A1"),
    );
  });

  it("formats a label that would otherwise break the Markdown link", () => {
    expect(formatThreadLink(ref("e", "t1"), "Fix [ci] \\ build")).toBe(
      "[Fix ci build](t3-thread://v2/e/t1)",
    );
    expect(formatThreadLink(ref("e", "t1"), " ] ")).toBe("<t3-thread://v2/e/t1>");
  });
});

describe("hosted thread links", () => {
  it("escapes every id character a sentence or path could claim, and reads it back", () => {
    const thread = ref("env.1", "thread:delegated/mcp%3A1.");
    const link = hostedThreadLink(thread);
    expect(link).toBe("https://app.t3.codes/threads/env%2E1/thread%3Adelegated%2Fmcp%253A1%2E");
    expect(parseThreadLinkHref(link)).toEqual({ ...thread, hosted: true });
    expect(hostedThreadLink(thread, "https://preview.t3.codes/")).toMatch(
      /^https:\/\/preview\.t3\.codes\/threads\//,
    );

    const literal = ref("local", "task%3A1");
    const literalUrl = hostedThreadLink(literal);
    expect(literalUrl).toBe("https://app.t3.codes/threads/local/task%253A1");
    expect(threadLinkCandidates(parseThreadLinkHref(literalUrl)!, local)).toEqual([literal]);
    expect(threadLinkRefs(literalUrl, local)).toEqual([literal]);
    expect(relabelThreadLinks(literalUrl, local, titlesIn({ local: { "task:1": "Other" } }))).toBe(
      "Thread no longer available",
    );
    expect(
      relabelThreadLinks(
        literalUrl,
        local,
        titlesIn({ local: { "task%3A1": "Literal", "task:1": "Other" } }),
      ),
    ).toBe("[Literal](t3-thread://v2/local/task%3A1)");
  });

  it("reads only a bare thread path on the hosted app", () => {
    expect(parseThreadLinkHref("https://app.t3.codes/threads/env-1/thread-1")).toEqual({
      ...ref("env-1", "thread-1"),
      hosted: true,
    });
    expect(parseThreadLinkHref("https://app.t3.codes/threads/env-1/thread-1?prompt=go")).toBeNull();
    expect(parseThreadLinkHref("https://app.t3.codes/threads/env-1/thread-1/extra")).toBeNull();
    expect(parseThreadLinkHref("https://app.t3.codes/threads/env-1")).toBeNull();
    expect(parseThreadLinkHref("https://app.t3.codes/env-1/thread-1")).toBeNull();
    expect(parseThreadLinkHref("https://evil.test/threads/env-1/thread-1")).toBeNull();
  });

  it("writes a copied link a reader can follow, labeled when it has a title", () => {
    expect(formatHostedThreadLink(ref("e", "t1"), "Fix [ci]")).toBe(
      "[Fix ci](https://app.t3.codes/threads/e/t1)",
    );
    expect(formatHostedThreadLink(ref("e", "t1"), " ")).toBe("https://app.t3.codes/threads/e/t1");
  });

  it("titles hosted links in every Markdown form and writes them as v2 links", () => {
    const title = titlesIn({ there: { t1: "There" } });
    expect(
      relabelThreadLinks(
        [
          "See https://app.t3.codes/threads/there/t1.",
          "[old](https://app.t3.codes/threads/there/t1)",
          "<https://app.t3.codes/threads/there/t1>",
          "`https://app.t3.codes/threads/there/t1`",
          "https://app.t3.codes/threads/there/t1?prompt=go",
        ].join("\n"),
        local,
        title,
      ),
    ).toBe(
      [
        "See [There](t3-thread://v2/there/t1).",
        "[There](t3-thread://v2/there/t1)",
        "[There](t3-thread://v2/there/t1)",
        "`https://app.t3.codes/threads/there/t1`",
        "https://app.t3.codes/threads/there/t1?prompt=go",
      ].join("\n"),
    );
    expect(
      relabelThreadLinks("https://app.t3.codes/threads/there/t1", local, () => undefined),
    ).toBe("Thread on another machine");
    expect(threadLinkRefs("Open https://app.t3.codes/threads/there/t%3A1", local)).toEqual([
      ref("there", "t:1"),
    ]);
  });

  it("leaves a hosted link that is part of another link as written", () => {
    const hosted = "https://app.t3.codes/threads/there/t1";
    const relabeled = "[There](t3-thread://v2/there/t1)";
    const title = titlesIn({ there: { t1: "There" } });
    for (const [markdown, expected] of [
      [`https://example.com/?next=${hosted}`],
      [`[Example](https://example.com/?next=${hosted})`],
      [`[ ${hosted} ](https://example.com)`],
      [`[${hosted}](<https://example.com/a b> "Title")`],
      [`[${hosted}](t3-thread://v2/local/id "Title")`],
      [`[a](https://example.com/x_(y)) ${hosted}`, `[a](https://example.com/x_(y)) ${relabeled}`],
      [`(${hosted}) **${hosted}**`, `(${relabeled}) **${relabeled}**`],
      [`[[[ [old](${hosted})`, `[[[ ${relabeled}`],
      [`\\\\[old](${hosted})`, `\\\\${relabeled}`],
      [`\\\\\\\\[old](${hosted})`, `\\\\\\\\${relabeled}`],
      [`\\[old](${hosted})`, `\\[old](${relabeled})`],
      [`\\[ ${hosted} ](https://example.com)`, `\\[ ${relabeled} ](https://example.com)`],
      ["\\[old](t3-thread://v2/there/t1) \\<t3-thread://v2/there/t1>"],
    ] as const) {
      expect(relabelThreadLinks(markdown, local, title)).toBe(expected ?? markdown);
      expect(threadLinkRefs(markdown, local)).toEqual(
        expected === undefined ? [] : [ref("there", "t1")],
      );
    }
  });

  it("keeps Markdown reference link definitions intact when relabeling", () => {
    const hosted = "https://app.t3.codes/threads/local/demo";
    for (const markdown of [
      `[Review][thread]\n\n[thread]: ${hosted}`,
      `[Review][thread]\n\n[thread]:${hosted}`,
      `[Review][thread]\n\n[thread]: <${hosted}>`,
      `[Review][thread]\n\n[thread]: <t3-thread://v2/local/demo>`,
      `[Review][thread]\n\n[thread]:\n  ${hosted}`,
      `[Review][thread]\n\n  [thread]: ${hosted} "Demo"`,
      `> [Review][thread]\n>\n> [thread]: ${hosted}`,
    ]) {
      for (const title of [() => "Demo", () => undefined]) {
        expect(relabelThreadLinks(markdown, local, title)).toBe(markdown);
      }
    }

    const withLiveAfter = `[Review][thread]\n\n[thread]: ${hosted}\n\nSee ${hosted}`;
    expect(relabelThreadLinks(withLiveAfter, local, () => "Demo")).toBe(
      `[Review][thread]\n\n[thread]: ${hosted}\n\nSee [Demo](t3-thread://v2/local/demo)`,
    );

    const paragraphContinuation = `Intro\n[thread]: ${hosted}`;
    expect(relabelThreadLinks(paragraphContinuation, local, () => "Demo")).toBe(
      `Intro\n[thread]: [Demo](t3-thread://v2/local/demo)`,
    );
  });

  it("keeps relabeled links navigable when the thread id contains a space", () => {
    const linkUrl = (markdown: string) => {
      const paragraph = unified().use(remarkParse).parse(markdown).children[0];
      const node = paragraph?.type === "paragraph" ? paragraph.children[0] : undefined;
      return node?.type === "link" ? node.url : undefined;
    };
    const thread = ref("local", "work item");
    const titles = titlesIn({ local: { "work item": "Review", "work%20item": "Encoded" } });

    const relabeled = relabelThreadLinks(hostedThreadLink(thread), local, titles);
    expect(parseThreadLinkHref(linkUrl(relabeled) ?? "")).toEqual({ ...thread, hosted: true });
    expect(threadLinkRefs(relabeled, local)).toEqual([thread]);

    const v1Relabeled = relabelThreadLinks("[old](t3-thread://v1/work%20item)", local, titles);
    expect(linkUrl(v1Relabeled)).toBe("t3-thread://v1/work%20item");
    expect(formatThreadLink(v1("work item"))).toBe("<t3-thread://v1/work%20item>");
  });
});
