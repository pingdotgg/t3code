import { changeRequestReferenceAutolinker } from "@t3tools/client-runtime/pull-request-markdown";
import { describe, expect, it } from "vite-plus/test";

import { linkReferenceAutolinks } from "./pullRequestAutolinks";

const github = changeRequestReferenceAutolinker({
  provider: "github",
  url: "https://github.com/team/repo/pull/8",
});

describe("linkReferenceAutolinks", () => {
  it("links the host's references in prose", () => {
    expect(linkReferenceAutolinks("Closes #123, see @julius", github)).toBe(
      "Closes [#123](https://github.com/team/repo/issues/123), see [@julius](https://github.com/julius)",
    );
  });

  it("leaves code, links, images, escapes and definitions alone", () => {
    const text =
      "`#123 @person abc1234`\n\n```\n#123\n```\n\n[#123](https://example.com) ![#123](image.png) https://example.com/#123 user@example.com \\#123 1234567\n\n[ref]: https://example.com/#123";
    expect(linkReferenceAutolinks(text, github)).toBe(text);
    for (const html of ["<!DOCTYPE html>", "<?xml version='1.0'?>", "<![CDATA[@reader]]>"]) {
      expect(linkReferenceAutolinks(html, github)).toBe(html);
    }
  });

  it.each([
    [
      'See <a href="https://example.com">#12</a> and <code>#13</code>, then #14.',
      'See <a href="https://example.com">#12</a> and <code>#13</code>, then [#14](https://github.com/team/repo/issues/14).',
    ],
    [
      '<details><summary>@reader</summary>Thanks @reader <code>@code</code><!-- @hidden --> `@span` [#12](https://example.com) <img alt="a>b" src="@image"></details>',
      '<details><summary>[@reader](https://github.com/reader)</summary>Thanks [@reader](https://github.com/reader) <code>@code</code><!-- @hidden --> `@span` [#12](https://example.com) <img alt="a>b" src="@image"></details>',
    ],
  ])(
    "links HTML text without nesting links inside anchors, code or comments: %s",
    (text, linked) => {
      expect(linkReferenceAutolinks(text, github)).toBe(linked);
    },
  );

  it("leaves markdown unchanged for a host that links nothing", () => {
    const forgejo = changeRequestReferenceAutolinker({
      provider: "forgejo",
      url: "https://codeberg.org/acme/web/pulls/7",
    });
    expect(linkReferenceAutolinks("Closes #123", forgejo)).toBe("Closes #123");
  });
});
