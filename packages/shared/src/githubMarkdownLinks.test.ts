import { describe, expect, it } from "vite-plus/test";
import { azureDevOpsMarkdownLinks, githubMarkdownLinks } from "./githubMarkdownLinks.ts";
import { unified } from "unified";
import remarkParse from "remark-parse";

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

describe("Azure DevOps references", () => {
  const repo = "https://dev.azure.com/acme/project/_git/repo";
  it("keeps unmatched parentheses in Azure link destinations", () => {
    const repository = "https://dev.azure.com/acme/project)/_git/repo(";
    const markdown = azureDevOpsMarkdownLinks("!34", repository);
    expect(unified().use(remarkParse).parse(markdown).children[0]).toMatchObject({
      children: [{ type: "link", url: `${repository}/pullrequest/34` }],
    });
  });
  it("distinguishes work items, pull requests, and native mentions", () => {
    const identity = "abcdef01-1234-5678-1234-abcdef012345";
    const result = azureDevOpsMarkdownLinks(`See #12, !34 and @<${identity}>.`, repo, {
      [identity]: "A [reviewer]",
    });
    expect(result).toContain("[#12](<https://dev.azure.com/acme/project/_workitems/edit/12>)");
    expect(result).toContain(
      "[!34](<https://dev.azure.com/acme/project/_git/repo/pullrequest/34>)",
    );
    expect(result).toContain("@A \\[reviewer\\]");
    expect(result).not.toContain("@<");
    const commit = "0123456789abcdef0123456789abcdef01234567";
    expect(azureDevOpsMarkdownLinks(`Fixed in ${commit}`, repo)).toBe(
      `Fixed in [0123456](<${repo}/commit/${commit}>)`,
    );
  });
  it("leaves code, authored links, escaped references and HTML code unchanged", () => {
    const text = "`#12 !34` [#12](https://example.com) <code>#12</code> \\#12\n\n```\n!34\n```";
    expect(azureDevOpsMarkdownLinks(text, repo)).toBe(text);
  });
});
