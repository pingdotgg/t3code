/**
 * Parity test: for commits whose scopes contain no `/`, `renderMarkdown`
 * must produce byte-identical output to `changelogithub.generateMarkdown`.
 * This guards against accidentally regressing the existing release-notes
 * format for all historical content that predates `/`-style scopes.
 */
import { describe, expect, test } from "bun:test";
import { generateMarkdown, type Commit } from "changelogithub";
import { renderMarkdown, type RenderConfig } from "./render.ts";

const config = {
  titles: { breakingChanges: "🚨 Breaking Changes" },
  types: {
    feat: { title: "🚀 Features" },
    fix: { title: "🐞 Bug Fixes" },
    perf: { title: "🏎 Performance" },
  },
  capitalize: true,
  emoji: true,
  baseUrl: "github.com",
  repo: "alchemy-run/alchemy-effect",
  from: "v1",
  to: "v2",
  group: true,
  scopeMap: {},
  contributors: true,
  tag: "v%s",
} as unknown as RenderConfig & Parameters<typeof generateMarkdown>[1];

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

describe("render.ts / changelogithub parity for non-`/` scopes", () => {
  test("single commit, single scope", () => {
    const commits = [
      makeCommit({
        type: "fix",
        scope: "Cloudflare",
        description: "apply access headers",
        hash: "fd329e70",
        pr: "#160",
        authors: [{ login: "jj", name: "JJ" }],
      }),
    ];
    expect(renderMarkdown(commits, config)).toBe(
      generateMarkdown(commits, config),
    );
  });

  test("multiple commits sharing a single-segment scope", () => {
    const commits = [
      makeCommit({
        type: "fix",
        scope: "core",
        description: "first",
        hash: "1111111",
      }),
      makeCommit({
        type: "fix",
        scope: "core",
        description: "second",
        hash: "2222222",
      }),
      makeCommit({
        type: "fix",
        scope: "core",
        description: "third",
        hash: "3333333",
      }),
    ];
    expect(renderMarkdown(commits, config)).toBe(
      generateMarkdown(commits, config),
    );
  });

  test("mixed types, scopes, unscoped, and breaking changes", () => {
    const commits = [
      makeCommit({
        type: "feat",
        description: "unscoped feature",
        hash: "aaa0000",
      }),
      makeCommit({
        type: "feat",
        scope: "api",
        description: "new endpoint",
        hash: "bbb0000",
      }),
      makeCommit({
        type: "fix",
        scope: "core",
        description: "core fix one",
        hash: "ccc0000",
        pr: "#100",
      }),
      makeCommit({
        type: "fix",
        scope: "core",
        description: "core fix two",
        hash: "ddd0000",
      }),
      makeCommit({
        type: "fix",
        scope: "website",
        description: "solo website fix",
        hash: "eee0000",
        authors: [{ login: "alice", name: "Alice" }, { name: "Bob" }],
      }),
      makeCommit({
        type: "feat",
        scope: "api",
        description: "breaking api change",
        hash: "fff0000",
        isBreaking: true,
      }),
    ];
    expect(renderMarkdown(commits, config)).toBe(
      generateMarkdown(commits, config),
    );
  });

  test("empty commit list", () => {
    expect(renderMarkdown([], config)).toBe(generateMarkdown([], config));
  });

  test("perf type section", () => {
    const commits = [
      makeCommit({
        type: "perf",
        scope: "runtime",
        description: "faster",
        hash: "ppp0000",
      }),
    ];
    expect(renderMarkdown(commits, config)).toBe(
      generateMarkdown(commits, config),
    );
  });
});
