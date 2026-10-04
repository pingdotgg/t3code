import { describe, expect, it } from "vite-plus/test";
import remarkParse from "remark-parse";
import { unified } from "unified";

import { bitbucketMentionDisplayBody } from "./bitbucketMentions.ts";

const id = "712020:11111111-2222-4333-8444-555555555555";
const token = `@{${id}}`;
const mention = (label = "@Alex Smith", accountId = id) =>
  `<span class="ap-mention" data-atlassian-id="${accountId}">${label}</span>`;

describe("Bitbucket mention display", () => {
  it("replaces repeated prose mentions without reformatting Markdown", () => {
    const body = `## Review\n\n**Thanks ${token}**\n\n> ${token}, looks good.`;
    expect(bitbucketMentionDisplayBody(body, mention())).toBe(
      "## Review\n\n**Thanks @Alex Smith**\n\n> @Alex Smith, looks good.",
    );
  });

  it("keeps code, escaped tokens and authored links unchanged", () => {
    const literals = [
      `\`${token}\``,
      `\`\`\`text\n${token}\n\`\`\``,
      `    ${token}`,
      `\\${token}`,
      `[${token}](https://example.com/${token})`,
      `https://example.com/${token}`,
      `<span>${token}</span>`,
    ];
    for (const literal of literals) {
      const body = `${token}\n\n${literal}`;
      expect(bitbucketMentionDisplayBody(body, mention())).toBe(`@Alex Smith\n\n${literal}`);
    }
  });

  it("decodes entities and escapes mention labels as literal Markdown", () => {
    expect(bitbucketMentionDisplayBody(token, mention("@A_[B]*`\\ &amp; &lt;name&gt;"))).toBe(
      "@A\\_\\[B\\]\\*\\`\\\\ \\& \\<name\\>",
    );
    expect(bitbucketMentionDisplayBody(token, mention("@<strong>Alex</strong> Smith"))).toBe(
      "@Alex Smith",
    );
  });

  it.each([
    [`${token} <br> thanks`, "@Alex Smith <br> thanks"],
    [`Thanks <strong>everyone</strong> ${token}`, "Thanks <strong>everyone</strong> @Alex Smith"],
    [`${token} <!-- note --> thanks`, "@Alex Smith <!-- note --> thanks"],
    [`${token} <span>${token}</span> ${token}`, `@Alex Smith <span>${token}</span> @Alex Smith`],
    [
      `${token} <span><em>${token}</em></span> ${token}`,
      `@Alex Smith <span><em>${token}</em></span> @Alex Smith`,
    ],
    [
      `${token} <span title="${token}">literal</span>`,
      `@Alex Smith <span title="${token}">literal</span>`,
    ],
    [`\`<span>\` ${token} <br> thanks`, "`<span>` @Alex Smith <br> thanks"],
    [`${token} <span>${token}`, `@Alex Smith <span>${token}`],
  ])("resolves prose beside HTML while preserving contained literals: %s", (body, expected) => {
    expect(bitbucketMentionDisplayBody(body, mention())).toBe(expected);
  });

  it("preserves literal entity text in a resolved name", () => {
    const display = bitbucketMentionDisplayBody(token, mention("@A &amp;copy;"));
    expect(unified().use(remarkParse).parse(display!).children).toMatchObject([
      { type: "paragraph", children: [{ type: "text", value: "@A &copy;" }] },
    ]);
  });

  it("supports UUID mention identifiers", () => {
    const uuid = "11111111-2222-4333-8444-555555555555";
    expect(bitbucketMentionDisplayBody(`@{${uuid}}`, mention("@Alex Smith", uuid))).toBe(
      "@Alex Smith",
    );
  });

  it("keeps unresolved mentions when HTML is absent or has no matching mention", () => {
    for (const html of [
      undefined,
      null,
      "",
      "<p>@Alex Smith</p>",
      mention("@Alex Smith", "another-id"),
    ]) {
      expect(bitbucketMentionDisplayBody(token, html)).toBeUndefined();
    }
    expect(bitbucketMentionDisplayBody(`${token} @{unknown}`, mention())).toBe(
      "@Alex Smith @{unknown}",
    );
  });

  it("ignores empty, conflicting or code-only mention metadata", () => {
    for (const html of [
      mention(""),
      mention("@"),
      mention("Alex"),
      `<code>${mention()}</code>`,
      mention() + mention("@Someone Else"),
    ]) {
      expect(bitbucketMentionDisplayBody(token, html)).toBeUndefined();
    }
  });

  it("tolerates malformed HTML and ignores unrelated markup", () => {
    expect(bitbucketMentionDisplayBody(token, `<p>${mention()}<p>Unclosed`)).toBe("@Alex Smith");
    expect(bitbucketMentionDisplayBody("No mentions", mention())).toBeUndefined();
  });
});
