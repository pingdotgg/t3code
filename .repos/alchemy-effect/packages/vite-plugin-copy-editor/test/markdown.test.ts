import { describe, expect, test } from "bun:test";
import { markdownDialect, markdownRuns } from "../src/markdown.ts";
import { applyRuns } from "../src/text.ts";

const edit = (md: string, before: string[], after: string[], options = {}) =>
  applyRuns(
    md,
    markdownRuns(md, 0, md.length, options),
    markdownDialect(options),
    {
      before,
      after,
    },
  );

describe("markdownRuns", () => {
  test("splits at inline syntax the way it renders", () => {
    const md = "Use `foo` with **bold** and [a link](/x) or _em_.";
    const runs = markdownRuns(md, 0, md.length).map((r) =>
      md.slice(r.start, r.end),
    );
    expect(runs.filter(Boolean)).toEqual([
      "Use ",
      "foo",
      " with ",
      "bold",
      " and ",
      "a link",
      " or ",
      "em",
      ".",
    ]);
  });

  test("keeps intraword underscores and lone asterisks as text", () => {
    const md = "snake_case_name and 5 * 3";
    const runs = markdownRuns(md, 0, md.length).filter((r) => r.end > r.start);
    expect(runs).toHaveLength(1);
  });

  test("treats bare URLs as generated text", () => {
    const md = "see https://alchemy.run/docs. now";
    const runs = markdownRuns(md, 0, md.length);
    expect(runs.find((r) => r.kind === "locked")?.expected).toBe(
      "https://alchemy.run/docs",
    );
  });
});

describe("markdown edits", () => {
  test("rewrites only the changed words, keeping syntax", () => {
    const md = "Use `foo` with **bold** text.";
    const out = edit(
      md,
      ["Use ", "foo", " with ", "bold", " text."],
      ["Use ", "foo", " with ", "bold", " prose."],
    );
    expect(out).toBe("Use `foo` with **bold** prose.");
  });

  test("matches smart punctuation against straight source", () => {
    const md = 'It\'s "quoted" -- fine...';
    const rendered = ["It’s “quoted” – fine…"];
    const out = edit(md, rendered, ["It’s “quoted” – great…"]);
    expect(out).toBe('It\'s "quoted" -- great...');
  });

  test("escapes markdown syntax in typed text", () => {
    const md = "plain words";
    const out = edit(md, ["plain words"], ["plain *starred* [x] words"]);
    expect(out).toBe("plain \\*starred\\* \\[x\\] words");
  });

  test("escapes block syntax at the start of a line", () => {
    const md = "first\nsecond";
    const out = edit(md, ["first\nsecond"], ["first\n#second"]);
    expect(out).toBe("first\n\\#second");
  });

  test("never writes */ into prose", () => {
    const md = "a b";
    const out = edit(md, ["a b"], ["a */ b"]);
    expect(out).not.toContain("*/");
  });

  test("honors a line prefix (JSDoc continuation lines)", () => {
    const md = "An S3 bucket for\n   * storing objects.";
    const options = { linePrefix: "[ \\t]*\\*(?!/)[ \\t]?" };
    const out = edit(
      md,
      ["An S3 bucket for\nstoring objects."],
      ["An S3 bucket for\nstoring files."],
      options,
    );
    expect(out).toBe("An S3 bucket for\n   * storing files.");
  });

  test("rejects edits to generated text", () => {
    const md = "see https://alchemy.run now";
    expect(() =>
      edit(
        md,
        ["see ", "https://alchemy.run", " now"],
        ["see ", "https://x.dev", " now"],
      ),
    ).toThrow(/generated/);
  });

  test("edits inside a code span", () => {
    const md = "run `bun dev` first";
    const out = edit(
      md,
      ["run ", "bun dev", " first"],
      ["run ", "bun start", " first"],
    );
    expect(out).toBe("run `bun start` first");
  });
});
