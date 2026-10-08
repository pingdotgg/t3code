import type { IssueLink } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  mergeIssueLinks,
  parseIssueReferences,
  unlinkedIssueReferences,
  type IssueReferenceSource,
} from "./issueReferences.ts";

function parsed(source: Partial<IssueReferenceSource>): ReadonlyArray<string> {
  return parseIssueReferences({
    kind: "github",
    host: "github.com",
    repository: "acme/web",
    title: "",
    body: "",
    ...source,
  }).map((reference) => `${reference.repository}#${reference.number}`);
}

function link(entry: Partial<IssueLink>): IssueLink {
  return {
    repository: "acme/web",
    number: 12,
    title: "The dialog closes on the wrong click",
    url: "https://github.com/acme/web/issues/12",
    state: "open",
    closesIssue: false,
    ...entry,
  };
}

describe("parseIssueReferences", () => {
  it("reads a bare number as the change request's own repository, in title and body", () => {
    expect(parsed({ title: "Fix the dialog (#12)", body: "Part of #34." })).toEqual([
      "acme/web#12",
      "acme/web#34",
    ]);
  });

  it("reads a qualified reference and a full issue URL on the same host", () => {
    expect(
      parsed({
        body: "Part of acme/design#7 and see https://github.com/acme/web/issues/9.",
      }),
    ).toEqual(["acme/web#9", "acme/design#7"]);
  });

  it("reads a nested GitLab project, and the `-/issues/` URL its web app writes", () => {
    expect(
      parsed({
        kind: "gitlab",
        host: "gitlab.com",
        repository: "acme/web",
        body: "Part of acme/tools/cli#7, see https://gitlab.com/acme/web/-/issues/9",
      }),
    ).toEqual(["acme/web#9", "acme/tools/cli#7"]);
  });

  it("refuses a path GitHub cannot name a repository with", () => {
    // Prose is full of things shaped like a path; only `owner/repo` is one on GitHub.
    expect(parsed({ body: "apps/server/src#12 changed" })).toEqual([]);
  });

  it("refuses a number that is part of a longer word, a colour, or a heading", () => {
    expect(parsed({ body: "abc#123, #1234ab and ##7" })).toEqual([]);
    expect(parsed({ body: "# 12 things to do\n\n### 34 more" })).toEqual([]);
  });

  it("refuses a number no host would issue", () => {
    expect(parsed({ body: "#0 and #1234567890123" })).toEqual([]);
  });

  it("refuses everything inside a fenced block or an inline span", () => {
    expect(
      parsed({
        body: ["Look at `#12` first.", "", "```sh", "grep -n '#34' file", "```", "", "#56"].join(
          "\n",
        ),
      }),
    ).toEqual(["acme/web#56"]);
  });

  it("keeps an unclosed fence closed to the end, the way a Markdown reader does", () => {
    expect(parsed({ body: ["~~~", "#12", "", "#34"].join("\n") })).toEqual([]);
  });

  describe.each(["github", "gitlab"] as const)("%s code examples", (kind) => {
    it.each([
      ["list fence", "- ```text\n  #12\n  ```"],
      ["quote fence", "> ```text\n> #12\n> ```"],
      ["nested quote and list fence", "> - ~~~~text\n>   #12\n>   ~~~\n>   #34\n>   ~~~~"],
      ["nested list fence", "- item\n  - ```text\n    #12\n    ```"],
      ["list indented code", "- item\n\n      #12"],
      ["quote indented code", ">     #12"],
      ["list multiline span", "- Example: ``#12\n  #34``"],
      ["quote multiline span", "> Example: ``#12\n> #34``"],
    ])("masks code inside a %s", (_, example) => {
      expect(parsed({ kind, body: `${example}\n\nSee #56` })).toEqual(["acme/web#56"]);
    });

    it.each(["``", "```"])("masks nested backticks inside a %s inline span", (ticks) => {
      expect(parsed({ kind, body: `Example: ${ticks} \`sample\` #12 ${ticks}.\n\n#56` })).toEqual([
        "acme/web#56",
      ]);
    });

    it.each(["    ", "\t"])("masks an indented block with prefix %j", (indent) => {
      expect(parsed({ kind, body: `Example:\n\n${indent}#12\n\n${indent}#34\n\n#56` })).toEqual([
        "acme/web#56",
      ]);
    });

    it("keeps indented paragraph continuations as prose", () => {
      expect(parsed({ kind, body: "See #56\n    and #12" })).toEqual([
        "acme/web#56",
        "acme/web#12",
      ]);
    });

    it.each(["# Heading #56", "   ###### Heading #56", "Heading #56\n===", "Heading #56\n---"])(
      "masks an indented block directly after the heading %j",
      (heading) => {
        expect(parsed({ kind, body: `${heading}\n    #123\n#34` })).toEqual([
          "acme/web#56",
          "acme/web#34",
        ]);
      },
    );

    it.each(["#Heading #56", "####### Heading #56", "="])(
      "keeps an indented continuation after non-heading %j",
      (line) => {
        expect(parsed({ kind, body: `${line}\n    #123` })).toContain("acme/web#123");
      },
    );

    it.each(["```", "~~~"])("refuses text after a closing %s fence", (fence) => {
      expect(
        parsed({ kind, body: `${fence}text\n${fence} trailing text\n#12\n${fence}\n\n#56` }),
      ).toEqual(["acme/web#56"]);
    });

    it("closes only on the same fence kind with enough markers and trailing space", () => {
      expect(
        parsed({ kind, body: "````text\r\n~~~\r\n#12\r\n```\r\n#34\r\n   ````` \t\r\n#56" }),
      ).toEqual(["acme/web#56"]);
    });

    it("preserves citations after unmatched inline backticks", () => {
      expect(parsed({ kind, body: "See `#12 and ``#34" })).toEqual(["acme/web#12", "acme/web#34"]);
    });

    it("allows inline code across a line break but not across paragraphs", () => {
      expect(parsed({ kind, body: "See ``#12\n#34`` and #56" })).toEqual(["acme/web#56"]);
      expect(parsed({ kind, body: "See `#12\n\n#34`" })).toEqual(["acme/web#12", "acme/web#34"]);
    });

    it("keeps prose after a line with backticks in its fence info", () => {
      expect(parsed({ kind, body: "``` sample ```\n\n#56" })).toEqual(["acme/web#56"]);
    });
  });

  it("refuses a URL that names something other than an issue", () => {
    expect(
      parsed({
        body: [
          "https://github.com/acme/web/pull/12",
          "https://example.com/palette#1234",
          "[the section](https://docs.example.com/guide#12)",
          "https://ghe.example.com/acme/web/issues/34",
        ].join("\n"),
      }),
    ).toEqual([]);
  });

  it("counts the same issue once, however many ways it is written", () => {
    expect(
      parsed({
        title: "Closes #12",
        body: "See #12, ACME/Web#12 and https://github.com/acme/web/issues/12",
      }),
    ).toEqual(["acme/web#12"]);
  });

  it("keeps every unique reference so providers can detect lookup overflow", () => {
    const body = Array.from({ length: 50 }, (_, index) => `#${index + 1}`).join(", ");
    expect(parsed({ body })).toHaveLength(50);
  });
});

describe("unlinkedIssueReferences", () => {
  it("drops what the host already reported, whatever case the body wrote it in", () => {
    expect(
      unlinkedIssueReferences(
        [
          { repository: "ACME/Web", number: 12 },
          { repository: "acme/web", number: 34 },
        ],
        [link({ number: 12, closesIssue: true })],
      ),
    ).toEqual([{ repository: "acme/web", number: 34 }]);
  });
});

describe("mergeIssueLinks", () => {
  it("keeps the host's own link over a parsed one for the same issue", () => {
    // Only the host can say that merging closes an issue, so its claim is the one that survives.
    expect(
      mergeIssueLinks(
        [link({ number: 12, closesIssue: true })],
        [link({ repository: "ACME/Web", number: 12 }), link({ number: 34 })],
      ).map((entry) => [entry.repository, entry.number, entry.closesIssue]),
    ).toEqual([
      ["acme/web", 12, true],
      ["acme/web", 34, false],
    ]);
  });
});
