import { changeRequestReferenceAutolinker } from "@t3tools/client-runtime/pull-request-references";
import { describe, expect, it } from "vite-plus/test";

import { nativePullRequestMarkdown } from "./pullRequestAutolinks";

const github = changeRequestReferenceAutolinker({
  provider: "github",
  url: "https://github.com/team/repo/pull/8",
});

describe("nativePullRequestMarkdown", () => {
  it("links the host's references in prose", () => {
    expect(nativePullRequestMarkdown("Closes #123, see @julius", github, false).markdown).toBe(
      "Closes [#123](https://github.com/team/repo/issues/123), see [@julius](https://github.com/julius)",
    );
  });

  it("leaves code, links, images, escapes and definitions alone", () => {
    const text =
      "`#123 @person abc1234`\n\n```\n#123\n```\n\n[#123](https://example.com) ![#123](image.png) https://example.com/#123 user@example.com \\#123 1234567\n\n[ref]: https://example.com/#123";
    expect(nativePullRequestMarkdown(text, github, false).markdown).toBe(text);
  });

  it("does not nest links inside HTML anchors or code", () => {
    const text = 'See <a href="https://example.com">#12</a> and <code>#13</code>, then #14.';
    expect(nativePullRequestMarkdown(text, github, false).markdown).toBe(
      'See <a href="https://example.com">#12</a> and <code>#13</code>, then [#14](https://github.com/team/repo/issues/14).',
    );
  });

  it("leaves markdown unchanged for a host that links nothing", () => {
    const forgejo = changeRequestReferenceAutolinker({
      provider: "forgejo",
      url: "https://codeberg.org/acme/web/pulls/7",
    });
    expect(nativePullRequestMarkdown("Closes #123", forgejo, false).markdown).toBe("Closes #123");
  });

  it("expands GitHub emoji aliases in prose and link labels, mapping offsets back", () => {
    const text =
      "- [ ] Ship :tada: #1 `:tada:`\n- [ ] [:+1: docs](https://x.dev/:tada:) https://x.dev/:tada: :asterisk:";
    const native = nativePullRequestMarkdown(text, github, true);
    expect(native.markdown).toBe(
      "- [ ] Ship 🎉 [#1](https://github.com/team/repo/issues/1) `:tada:`\n- [ ] [👍 docs](https://x.dev/:tada:) https://x.dev/:tada: \\*️⃣",
    );
    const marker = native.markdown.lastIndexOf("[ ]");
    expect(native.sourceOffset(marker)).toBe(text.lastIndexOf("[ ]"));
  });
});
