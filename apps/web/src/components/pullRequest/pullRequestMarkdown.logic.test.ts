import {
  changeRequestLinkResolver,
  changeRequestReferenceAutolinker,
} from "@t3tools/client-runtime/pull-request-markdown";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { describe, expect, it } from "vite-plus/test";

import {
  remarkPullRequestAutolinks,
  remarkPullRequestRelativeUrls,
} from "./pullRequestMarkdown.logic";

type Node = {
  type: string;
  value?: string;
  url?: string;
  data?: { hProperties?: Record<string, unknown> };
  children?: Node[];
};

function links(markdown: string) {
  const autolinks = changeRequestReferenceAutolinker({
    provider: "github",
    url: "https://github.com/team/repo/pull/8",
  })!;
  const tree = unified().use(remarkParse).parse(markdown) as Node;
  remarkPullRequestAutolinks({ autolinks })(tree as never);
  const found: Array<[string | undefined, string | undefined, unknown]> = [];
  const visit = (node: Node) => {
    if (node.type === "link") {
      found.push([
        node.children?.[0]?.value,
        node.url,
        node.data?.hProperties?.["dataPullRequestAutolink"],
      ]);
    }
    node.children?.forEach(visit);
  };
  visit(tree);
  return found;
}

describe("remarkPullRequestAutolinks", () => {
  it("links the host's references in prose and leaves links and code alone", () => {
    expect(links("Fixes #12 in **abcdef1**. [#13](https://example.com) `#14`")).toEqual([
      ["#12", "https://github.com/team/repo/issues/12", "reference"],
      ["abcdef1", "https://github.com/team/repo/commit/abcdef1", "commit"],
      ["#13", "https://example.com", undefined],
    ]);
  });
});

describe("remarkPullRequestRelativeUrls", () => {
  const uuid = "8e603325-bb2b-4e32-a9bc-f1fa20b6c40b";
  const upload = `/attachments/${uuid}`;
  const resolved = `https://git.example.test/attachments/${uuid}`;
  const resolveUrl = changeRequestLinkResolver({
    provider: "forgejo",
    url: "https://git.example.test/team/repo/pulls/7",
  })!;

  function rendered(markdown: string) {
    const tree = unified().use(remarkParse).parse(markdown) as Node;
    remarkPullRequestRelativeUrls({ resolveUrl })(tree as never);
    const found = { urls: [] as string[], html: [] as string[], code: [] as string[] };
    const visit = (node: Node) => {
      if (node.url !== undefined) found.urls.push(node.url);
      if (node.type === "html") found.html.push(node.value!);
      if (node.type === "code" || node.type === "inlineCode") found.code.push(node.value!);
      node.children?.forEach(visit);
    };
    visit(tree);
    return found;
  }

  it("links a pasted upload wherever the markdown shows it as an image", () => {
    for (const markdown of [
      `![shot](${upload})`,
      `![shot](<${upload}> "title")`,
      `![shot][s]\n\n[s]: ${upload}`,
      `1. Open settings\n\n    ![shot](${upload})`,
      `- Step one\n\n    ![shot](${upload})`,
      `- Step one\n\n\t![shot](${upload})`,
      `Press the \` key first.\n\n![shot](${upload})\n\nThen run \`make\`.`,
      `Use \\\` then ![shot](${upload}) then \\\`.`,
    ]) {
      expect(rendered(markdown).urls, markdown).toEqual([resolved]);
    }
    expect(rendered(`<img width="300" alt="shot" src="${upload}">`).html).toEqual([
      `<img width="300" alt="shot" src="${resolved}">`,
    ]);
    expect(rendered(`![kept](https://cdn.example.test${upload})`).urls).toEqual([
      `https://cdn.example.test${upload}`,
    ]);
  });

  it("keeps an upload written as code or escaped as it was written", () => {
    const pasted = `![shot](${upload})`;
    for (const markdown of [
      `\`\`\`md\n${pasted}\n\`\`\``,
      `Before\n\n    ${pasted}`,
      `Paste writes \`${pasted}\`.`,
      `Or \`\`<img src="${upload}">\`\`.`,
      `A \\\` literal, then \`${pasted}\`.`,
    ]) {
      const found = rendered(markdown);
      expect(found.urls, markdown).toEqual([]);
      expect(found.code.join("\n"), markdown).toContain(upload);
    }
    for (const markdown of [`\\[shot\\](${upload})`, `&lt;img src="${upload}"&gt;`]) {
      expect(rendered(markdown), markdown).toEqual({ urls: [], html: [], code: [] });
    }
  });
});
