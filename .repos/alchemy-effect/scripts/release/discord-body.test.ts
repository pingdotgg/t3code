import { describe, expect, test } from "bun:test";
import type { Commit } from "changelogithub";
import { extractTagBody, toDiscordBody } from "./discord-body.ts";
import { renderMarkdown, type RenderConfig } from "./render.ts";

const baseConfig: RenderConfig = {
  titles: { breakingChanges: "🚨 Breaking Changes" },
  types: {
    feat: { title: "🚀 Features" },
    fix: { title: "🐞 Bug Fixes" },
    perf: { title: "🏎 Performance" },
  } as RenderConfig["types"],
  capitalize: true,
  emoji: true,
  baseUrl: "github.com",
  repo: "alchemy-run/alchemy-effect",
  from: "v1",
  to: "v2",
};

function makeCommit(input: {
  type: string;
  scope?: string;
  description: string;
  hash?: string;
  pr?: string;
  authors?: Array<{ login?: string; name: string }>;
  isBreaking?: boolean;
}): Commit {
  const references: Commit["references"] = [];
  if (input.hash) references.push({ type: "hash", value: input.hash });
  if (input.pr) references.push({ type: "pull-request", value: input.pr });
  return {
    message: `${input.type}${input.scope ? `(${input.scope})` : ""}: ${input.description}`,
    body: "",
    shortHash: (input.hash ?? "").slice(0, 7),
    author: { name: "t", email: "t@t" },
    authors: [],
    description: input.description,
    type: input.type,
    scope: input.scope ?? "",
    references,
    isBreaking: input.isBreaking ?? false,
    resolvedAuthors: input.authors,
  } as Commit;
}

describe("toDiscordBody", () => {
  test("replaces every &nbsp; with a plain space", () => {
    const input =
      "### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes\n- foo &nbsp;-&nbsp; by @bar";
    const out = toDiscordBody(input);
    expect(out).not.toContain("&nbsp;");
    // The heading regex further collapses the leading whitespace run.
    expect(out).toContain("### 🐞 Bug Fixes");
    // Inline `&nbsp;-&nbsp;` separators become ` - ` (with surrounding spaces).
    expect(out).toContain("- foo  -  by @bar");
  });

  test("converts <samp>...</samp> to backticks", () => {
    const input =
      "- foo [<samp>(abcde)</samp>](https://example.com/commit/abcdef1)";
    expect(toDiscordBody(input)).toContain("[`(abcde)`](https://example.com");
    expect(toDiscordBody(input)).not.toMatch(/<\/?samp>/);
  });

  test("collapses indented ### headings to `### ` so Discord renders them", () => {
    const input = "###    🐞 Bug Fixes";
    expect(toDiscordBody(input)).toBe("### 🐞 Bug Fixes");
  });

  test("strips #### / ##### / ###### heading markers entirely", () => {
    const input =
      "##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://example.com)";
    const out = toDiscordBody(input);
    expect(out.startsWith("[View changes on GitHub]")).toBe(true);
    expect(out).not.toMatch(/^#{4,6}/m);
  });

  test("preserves # / ## / ### headings (Discord renders these)", () => {
    const input = "# Title\n## Subtitle\n### Section";
    expect(toDiscordBody(input)).toBe("# Title\n## Subtitle\n### Section");
  });

  test("strips stray HTML tags other than <samp>", () => {
    expect(toDiscordBody("<b>bold</b> and <i>italic</i>")).toBe(
      "bold and italic",
    );
    expect(toDiscordBody('<a href="x">link</a>')).toBe("link");
  });

  test("leaves plain markdown untouched", () => {
    const input = "- **scope**: description [link](https://example.com)";
    expect(toDiscordBody(input)).toBe(input);
  });

  test("is idempotent", () => {
    const input =
      "### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes\n- foo &nbsp;-&nbsp; [<samp>(abc)</samp>](https://x/)\n##### [View](https://y/)";
    const once = toDiscordBody(input);
    expect(toDiscordBody(once)).toBe(once);
  });
});

describe("extractTagBody", () => {
  const changelog = `## v1.2.0

### &nbsp;&nbsp;&nbsp;🚀 Features

- Shiny new thing

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://x/)

---

## v1.1.0

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- Old fix

---
`;

  test("extracts the entry body for the given tag", () => {
    const body = extractTagBody(changelog, "v1.2.0");
    expect(body).toBeDefined();
    expect(body).toContain("Shiny new thing");
    expect(body).not.toContain("v1.1.0");
    expect(body).not.toContain("Old fix");
  });

  test("returns undefined for an unknown tag", () => {
    expect(extractTagBody(changelog, "v9.9.9")).toBeUndefined();
  });

  test("falls back to next `## ` heading when no `---` separator exists", () => {
    const noSep = `## v1.2.0\n\nBody line\n\n## v1.1.0\n\nOther\n`;
    expect(extractTagBody(noSep, "v1.2.0")).toBe("Body line");
  });

  test("reads to end of file for the last entry", () => {
    const single = `## v1.2.0\n\nOnly body\n`;
    expect(extractTagBody(single, "v1.2.0")).toBe("Only body");
  });
});

describe("toDiscordBody(renderMarkdown(...))", () => {
  // End-to-end coverage: whatever `render.ts` emits today must survive the
  // `discord-notify.ts` cleanup pipeline without leaking HTML entities, raw
  // `<samp>` tags, or `####+` heading markers into Discord.
  const commits = [
    makeCommit({
      type: "feat",
      scope: "aws/lambda",
      description: "scope public url invokes",
      hash: "abcdef1234",
      pr: "#42",
      authors: [{ login: "sam", name: "Sam" }],
    }),
    makeCommit({
      type: "fix",
      scope: "aws/s3",
      description: "handle presigned URLs",
      hash: "1111111111",
    }),
    makeCommit({
      type: "fix",
      scope: "aws",
      description: "top-level aws fix",
      hash: "2222222222",
    }),
    makeCommit({
      type: "fix",
      scope: "Cloudflare",
      description: "apply cloudflare access",
      hash: "3333333333",
      pr: "#160",
    }),
  ];

  const md = renderMarkdown(commits, baseConfig);
  const discord = toDiscordBody(md);

  test("rendered markdown contains the intentional GitHub-flavored markup", () => {
    // These MUST be present in CHANGELOG.md for GitHub Releases to render
    // nicely. If someone removes them from render.ts this assertion will
    // fail and force an intentional decision.
    expect(md).toContain("&nbsp;");
    expect(md).toContain("<samp>");
    expect(md).toContain(
      "##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub]",
    );
  });

  test("discord output has no HTML entities", () => {
    expect(discord).not.toContain("&nbsp;");
    expect(discord).not.toMatch(/&[a-z]+;/i);
  });

  test("discord output has no raw HTML tags", () => {
    expect(discord).not.toMatch(/<\/?samp>/);
    expect(discord).not.toMatch(/<[a-z][^>]*>/i);
  });

  test("discord output has no #### / ##### / ###### heading markers", () => {
    const deepHeading = discord
      .split("\n")
      .find((line) => /^#{4,6}\s/.test(line));
    expect(deepHeading).toBeUndefined();
  });

  test("discord output preserves the nested scope structure", () => {
    expect(discord).toContain("- **aws**:");
    expect(discord).toContain("  - **lambda**: Scope public url invokes");
    expect(discord).toContain("  - **s3**: Handle presigned URLs");
    expect(discord).toContain("  - Top-level aws fix");
  });

  test("discord output preserves commit hash links as backtick-wrapped text", () => {
    expect(discord).toMatch(
      /\[`\(abcde\)`\]\(https:\/\/github\.com\/alchemy-run\/alchemy-effect\/commit\/abcdef1234\)/,
    );
  });

  test("discord output preserves the `[View changes on GitHub]` link as plain text", () => {
    expect(discord).toContain(
      "[View changes on GitHub](https://github.com/alchemy-run/alchemy-effect/compare/v1...v2)",
    );
  });
});
