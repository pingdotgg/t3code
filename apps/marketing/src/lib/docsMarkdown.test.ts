import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  extractDocMeta,
  parseDocsIndex,
  preprocessDocMarkdown,
  rewriteDocLink,
} from "./docsMarkdown";
import { GITHUB_REPOSITORY_URL } from "./site";

describe("rewriteDocLink", () => {
  it("rewrites sibling user docs and preserves hashes", () => {
    expect(rewriteDocLink("./install.md")).toBe("/docs/install");
    expect(rewriteDocLink("./install.md#providers")).toBe("/docs/install#providers");
    expect(rewriteDocLink("remote-access.md#t3-connect-recommended")).toBe(
      "/docs/remote-access#t3-connect-recommended",
    );
    expect(rewriteDocLink("./README.md")).toBe("/docs");
    expect(rewriteDocLink("./README.md#quickstart")).toBe("/docs#quickstart");
  });

  it("rewrites repo links outside docs/user/ to GitHub", () => {
    expect(rewriteDocLink("../operations/00_development.md#first-checkout")).toBe(
      `${GITHUB_REPOSITORY_URL}/blob/main/docs/operations/00_development.md#first-checkout`,
    );
    expect(rewriteDocLink("../../LICENSE")).toBe(`${GITHUB_REPOSITORY_URL}/blob/main/LICENSE`);
    expect(rewriteDocLink("../../TRADEMARK.md")).toBe(
      `${GITHUB_REPOSITORY_URL}/blob/main/TRADEMARK.md`,
    );
  });

  it("leaves external, root-relative, and in-page links untouched", () => {
    expect(rewriteDocLink("https://t3.codes/download")).toBe("https://t3.codes/download");
    expect(rewriteDocLink("/download")).toBe("/download");
    expect(rewriteDocLink("#section")).toBe("#section");
  });
});

describe("preprocessDocMarkdown", () => {
  it("strips the first H1 and rewrites links outside code blocks and inline code", () => {
    const input = `# Title

See [Install](./install.md#providers) and \`[literal](./install.md)\`.

\`\`\`md
# Not stripped
[code](./install.md)
\`\`\`

[ref]: ./remote-access.md
`;

    expect(preprocessDocMarkdown(input))
      .toBe(`See [Install](/docs/install#providers) and \`[literal](./install.md)\`.

\`\`\`md
# Not stripped
[code](./install.md)
\`\`\`

[ref]: /docs/remote-access
`);
  });
});

describe("extractDocMeta", () => {
  it("extracts H1 title and first plain paragraph stripped of markdown syntax", () => {
    const meta = extractDocMeta(
      `# Built-in browser

T3 Code includes a **built-in** [preview browser](./browser.md) using \`preview_*\` tools.

## Open
`,
      "browser",
    );

    expect(meta).toEqual({
      title: "Built-in browser",
      description: "T3 Code includes a built-in preview browser using preview_* tools.",
    });
  });
});

describe("parseDocsIndex", () => {
  it("parses docs/user/README.md and covers every user doc file", () => {
    const docsUserDir = NodePath.resolve(import.meta.dirname, "../../../../docs/user");
    const readme = NodeFS.readFileSync(NodePath.join(docsUserDir, "README.md"), "utf8");
    const groups = parseDocsIndex(readme);

    expect(groups.length).toBeGreaterThanOrEqual(5);
    const indexedSlugs = new Set(groups.flatMap((g) => g.items.map((item) => item.slug)));

    const diskSlugs = NodeFS.readdirSync(docsUserDir)
      .filter((name) => name.endsWith(".md") && name !== "README.md")
      .map((name) => name.slice(0, -3));

    for (const slug of diskSlugs) {
      expect(indexedSlugs, `Expected ${slug}.md to be listed in docs/user/README.md`).toContain(
        slug,
      );
    }
  });
});
