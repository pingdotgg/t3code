import { describe, expect, it } from "vite-plus/test";
import { githubMarkdownLinks } from "./githubMarkdownLinks.ts";

const url = "https://github.com/team/repo/pull/8";
describe("githubMarkdownLinks", () => {
  it("links closing references, cross-repository references, commits and mentions", () => {
    expect(
      githubMarkdownLinks(
        "Closes #123, fixes other/project#9; other#4 @julius @team/mobile abc1234 other/project@abcdef1",
        url,
      ),
    ).toBe(
      "Closes [#123](https://github.com/team/repo/issues/123), fixes [other/project#9](https://github.com/other/project/issues/9); [other#4](https://github.com/other/repo/issues/4) [@julius](https://github.com/julius) [@team/mobile](https://github.com/orgs/team/teams/mobile) [abc1234](https://github.com/team/repo/commit/abc1234) [other/project@abcdef1](https://github.com/other/project/commit/abcdef1)",
    );
  });
  it("leaves code, links, images, URLs, escapes, emails, and plain numbers alone", () => {
    const text =
      "`#123 @person abc1234`\n\n```\n#123\n```\n\n[#123](https://example.com) ![#123](image.png) https://example.com/#123 user@example.com \\#123 1234567\n\n[ref]: https://example.com/#123";
    expect(githubMarkdownLinks(text, url)).toBe(text);
  });
  it("does not nest links inside HTML anchors or code", () => {
    const text = 'See <a href="https://example.com">#12</a> and <code>#13</code>, then #14.';
    expect(githubMarkdownLinks(text, url)).toBe(
      'See <a href="https://example.com">#12</a> and <code>#13</code>, then [#14](https://github.com/team/repo/issues/14).',
    );
  });
});
