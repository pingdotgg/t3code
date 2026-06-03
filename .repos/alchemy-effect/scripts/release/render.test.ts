import { describe, expect, test } from "bun:test";
import type { Commit } from "changelogithub";
import { renderMarkdown, type RenderConfig } from "./render.ts";

// Minimal config that matches the defaults used by `release-notes.ts`.
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

const COMPARE_LINE =
  "##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy-effect/compare/v1...v2)";

describe("renderMarkdown", () => {
  test("renders empty when no commits", () => {
    const md = renderMarkdown([], baseConfig);
    expect(md).toBe(`*No significant changes*\n\n${COMPARE_LINE}`);
  });

  test("nests commits that share a top-level scope via `/`", () => {
    const commits = [
      makeCommit({
        type: "fix",
        scope: "aws/lambda",
        description: "scope public url invokes",
        hash: "abcdef123456",
      }),
      makeCommit({
        type: "fix",
        scope: "aws/lambda",
        description: "second lambda fix",
        hash: "1111111111",
      }),
      makeCommit({
        type: "fix",
        scope: "aws/s3",
        description: "handle presigned URLs",
        hash: "2222222222",
      }),
      makeCommit({
        type: "fix",
        scope: "aws",
        description: "top-level aws fix",
        hash: "3333333333",
      }),
    ];

    const md = renderMarkdown(commits, baseConfig);

    // Single shared `aws` header for all four commits.
    expect(md.match(/- \*\*aws\*\*:/g) ?? []).toHaveLength(1);
    // `lambda` has two commits -> nested list with header.
    expect(md).toContain("  - **lambda**:\n");
    expect(md).toContain("    - Second lambda fix");
    expect(md).toContain("    - Scope public url invokes");
    // `s3` also emits a header + nested bullet (matches changelogithub's
    // `group: true` default: if any sibling has >1 commits, every sibling
    // gets a header for visual alignment).
    expect(md).toContain("  - **s3**:\n    - Handle presigned URLs");
    // Plain `fix(aws)` shows as a bare bullet under the aws header.
    expect(md).toContain("  - Top-level aws fix");
    // No stray flat `**aws/lambda**` or `**aws/s3**` groups.
    expect(md).not.toContain("**aws/lambda**");
    expect(md).not.toContain("**aws/s3**");
  });

  test("keeps single-segment scopes flat (byte-compatible with changelogithub)", () => {
    const commits = [
      makeCommit({
        type: "fix",
        scope: "Cloudflare",
        description: "apply Cloudflare Access headers to HTTP requests",
        hash: "fd329e70aaaa",
        pr: "#160",
        authors: [{ login: "jacobiajohnson", name: "jj" }],
      }),
    ];

    const md = renderMarkdown(commits, baseConfig);

    expect(md).toContain(
      "- **Cloudflare**: Apply Cloudflare Access headers to HTTP requests &nbsp;-&nbsp; by @jacobiajohnson in https://github.com/alchemy-run/alchemy-effect/issues/160 [<samp>(fd329)</samp>](https://github.com/alchemy-run/alchemy-effect/commit/fd329e70aaaa)",
    );
    expect(md).not.toContain("- **Cloudflare**:\n");
  });

  test("nests multi-commit single-segment scopes with a header", () => {
    const commits = [
      makeCommit({
        type: "fix",
        scope: "Cloudflare",
        description: "first",
        hash: "aaaaaaa",
      }),
      makeCommit({
        type: "fix",
        scope: "Cloudflare",
        description: "second",
        hash: "bbbbbbb",
      }),
    ];

    const md = renderMarkdown(commits, baseConfig);

    expect(md).toContain("- **Cloudflare**:\n");
    expect(md).toMatch(/- \*\*Cloudflare\*\*:\n\s+- Second[\s\S]+- First/);
  });

  test("renders unscoped commits as plain bullets at the top of their type", () => {
    const commits = [
      makeCommit({ type: "fix", description: "no scope", hash: "abcabca" }),
      makeCommit({
        type: "fix",
        scope: "core",
        description: "core thing",
        hash: "deadbee",
      }),
    ];

    const md = renderMarkdown(commits, baseConfig);

    const bugFixesBlock = md.slice(md.indexOf("🐞 Bug Fixes"));
    const noScopeIdx = bugFixesBlock.indexOf("- No scope");
    const coreIdx = bugFixesBlock.indexOf("- **core**:");
    expect(noScopeIdx).toBeGreaterThan(-1);
    expect(coreIdx).toBeGreaterThan(-1);
    expect(noScopeIdx).toBeLessThan(coreIdx);
  });

  test("groups types under their titles and partitions breaking changes", () => {
    const commits = [
      makeCommit({
        type: "feat",
        scope: "api",
        description: "new endpoint",
        hash: "feat0000",
      }),
      makeCommit({
        type: "fix",
        scope: "api",
        description: "bug",
        hash: "fix00000",
      }),
      makeCommit({
        type: "feat",
        scope: "api",
        description: "breaking change",
        hash: "brk00000",
        isBreaking: true,
      }),
    ];

    const md = renderMarkdown(commits, baseConfig);

    const breakingIdx = md.indexOf("🚨 Breaking Changes");
    const featuresIdx = md.indexOf("🚀 Features");
    const fixesIdx = md.indexOf("🐞 Bug Fixes");
    expect(breakingIdx).toBeGreaterThan(-1);
    expect(featuresIdx).toBeGreaterThan(breakingIdx);
    expect(fixesIdx).toBeGreaterThan(featuresIdx);
    // Breaking change must not also appear under Features.
    const featuresBlock = md.slice(featuresIdx, fixesIdx);
    expect(featuresBlock).not.toContain("Breaking change");
  });

  test("honors scopeMap before splitting on `/`", () => {
    const commits = [
      makeCommit({
        type: "fix",
        scope: "aws-lambda",
        description: "mapped",
        hash: "map00000",
      }),
    ];

    const md = renderMarkdown(commits, {
      ...baseConfig,
      scopeMap: { "aws-lambda": "aws/lambda" },
    });

    expect(md).toContain("- **aws**:");
    expect(md).toContain("  - **lambda**: Mapped");
  });

  test("splits scopes with leading/trailing whitespace and empty segments", () => {
    const commits = [
      makeCommit({
        type: "fix",
        scope: " aws / lambda ",
        description: "trims segments",
        hash: "trim0000",
      }),
      makeCommit({
        type: "fix",
        scope: "aws//s3",
        description: "skips empty segments",
        hash: "skip0000",
      }),
    ];

    const md = renderMarkdown(commits, baseConfig);
    expect(md).toContain("- **aws**:");
    // Both children are single-commit leaves with no other siblings forcing
    // a header, so they collapse inline.
    expect(md).toContain("  - **lambda**: Trims segments");
    expect(md).toContain("  - **s3**: Skips empty segments");
  });

  test("collapses single-commit scopes inline when no sibling forces a header", () => {
    const commits = [
      makeCommit({
        type: "fix",
        scope: "core",
        description: "just one",
        hash: "core0000",
      }),
      makeCommit({
        type: "fix",
        scope: "website",
        description: "also one",
        hash: "web00000",
      }),
    ];
    const md = renderMarkdown(commits, baseConfig);
    expect(md).toContain("- **core**: Just one");
    expect(md).toContain("- **website**: Also one");
    expect(md).not.toContain("- **core**:\n");
  });

  test("forces headers on all siblings when any has multiple commits", () => {
    // `group: true` default behavior: `website` is a single-commit leaf but
    // gets a header because `core` has multiple commits in the same section.
    const commits = [
      makeCommit({
        type: "fix",
        scope: "core",
        description: "first core",
        hash: "c1c1c1c",
      }),
      makeCommit({
        type: "fix",
        scope: "core",
        description: "second core",
        hash: "c2c2c2c",
      }),
      makeCommit({
        type: "fix",
        scope: "website",
        description: "solo website",
        hash: "w1w1w1w",
      }),
    ];
    const md = renderMarkdown(commits, baseConfig);
    expect(md).toContain("- **core**:\n");
    expect(md).toContain("- **website**:\n");
    expect(md).not.toContain("- **website**: Solo website");
  });

  test("renders three-level nesting", () => {
    const commits = [
      makeCommit({
        type: "fix",
        scope: "aws/lambda/urls",
        description: "first",
        hash: "aaa0000",
      }),
      makeCommit({
        type: "fix",
        scope: "aws/lambda/urls",
        description: "second",
        hash: "bbb0000",
      }),
    ];

    const md = renderMarkdown(commits, baseConfig);

    expect(md).toContain("- **aws**:");
    expect(md).toContain("  - **lambda**:");
    expect(md).toContain("    - **urls**:");
    expect(md).toContain("      - First");
    expect(md).toContain("      - Second");
  });

  test("formats multiple authors with `and`", () => {
    const commits = [
      makeCommit({
        type: "fix",
        scope: "core",
        description: "thing",
        hash: "a1b2c3d",
        authors: [{ login: "alice", name: "Alice" }, { name: "Bob" }],
      }),
    ];

    const md = renderMarkdown(commits, baseConfig);
    expect(md).toContain("by @alice and **Bob**");
  });

  test("strips emojis from section titles when emoji=false", () => {
    const commits = [
      makeCommit({ type: "fix", description: "x", hash: "1234567" }),
    ];
    const md = renderMarkdown(commits, { ...baseConfig, emoji: false });
    expect(md).toContain("### &nbsp;&nbsp;&nbsp;Bug Fixes");
    expect(md).not.toContain("🐞");
  });

  test("respects capitalize=false", () => {
    const commits = [
      makeCommit({
        type: "fix",
        scope: "core",
        description: "lowercase description",
        hash: "1234567",
      }),
    ];
    const md = renderMarkdown(commits, { ...baseConfig, capitalize: false });
    expect(md).toContain("- **core**: lowercase description");
  });
});
