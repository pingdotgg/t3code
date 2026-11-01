import { EnvironmentId, TaskDocumentId } from "@t3tools/contracts";
import { remarkNormalizeListItemIndentation } from "@t3tools/shared/markdownListIndentation";
import { expect, it } from "vite-plus/test";
import type { Root } from "mdast";
import remarkParse from "remark-parse";
import { type Plugin, unified } from "unified";

import { taskWikiLinkIdFromNode, remarkTaskWikiLinks } from "./taskWikiLinks";

type Node = {
  type: string;
  value?: string;
  url?: string;
  children?: Node[];
};

const environmentId = EnvironmentId.make("test-environment");
const parentId = TaskDocumentId.make("18000000-0000-4000-8000-000000000001");
const duplicateId = TaskDocumentId.make("18000000-0000-4000-8000-000000000002");
const readmeId = TaskDocumentId.make("18000000-0000-4000-8000-000000000003");
const windowsId = TaskDocumentId.make("18000000-0000-4000-8000-000000000004");

const parent = {
  canonicalPath: "/vault/tasks/Parent decision.md",
  taskDocumentId: parentId,
  title: "Parent decision",
};
const duplicate = {
  canonicalPath: "/vault/other/Parent decision.md",
  taskDocumentId: duplicateId,
  title: "Parent decision",
};
const readme = {
  canonicalPath: "/vault/tasks/Readme.md",
  taskDocumentId: readmeId,
  title: "Readme",
};
const windowsTask = {
  canonicalPath: "C:\\vault\\tasks\\Windows item.md",
  taskDocumentId: windowsId,
  title: "Windows item",
};

function renderTree(
  markdown: string,
  taskTargets: ReadonlyArray<typeof parent> = [parent],
  normalizeLists = false,
) {
  const processor = unified().use(remarkParse);
  if (normalizeLists) {
    processor.use(remarkNormalizeListItemIndentation as unknown as Plugin<[], Root>);
  }
  processor.use(remarkTaskWikiLinks(taskTargets, environmentId, markdown));
  return processor.runSync(processor.parse(markdown), { value: markdown }) as Node;
}

function links(node: Node): Array<{ url: string | undefined; label: string }> {
  if (node.type === "link") {
    return [
      {
        url: node.url,
        label: node.children?.map((child) => child.value ?? "").join("") ?? "",
      },
    ];
  }
  return node.children?.flatMap(links) ?? [];
}

function text(node: Node): string {
  if (node.value) return node.value;
  return node.children?.map(text).join("") ?? "";
}

it("renders registered task wikilinks as app links with aliases and default labels", () => {
  const tree = renderTree("See [[Parent decision|the parent]] and [[Parent decision]].");

  expect(links(tree)).toEqual([
    { url: `/task/test-environment/${parentId}`, label: "the parent" },
    { url: `/task/test-environment/${parentId}`, label: "Parent decision" },
  ]);
});

it("handles only links marked at a wikilink source position", () => {
  const markdown = "[[Parent decision]]";
  const markedLink = {
    properties: { dataTaskDocumentId: parentId },
    position: { start: { offset: 0 }, end: { offset: markdown.length } },
  };
  expect(taskWikiLinkIdFromNode(markedLink, markdown)).toBe(parentId);

  const authoredAnchor = `<a data-task-document-id="${parentId}" href="/task/test-environment/${parentId}">Parent</a>`;
  expect(
    taskWikiLinkIdFromNode(
      {
        properties: { dataTaskDocumentId: parentId },
        position: { start: { offset: 0 }, end: { offset: authoredAnchor.length } },
      },
      authoredAnchor,
    ),
  ).toBeNull();
  expect(taskWikiLinkIdFromNode({ ...markedLink, properties: {} }, markdown)).toBeNull();
});

it("leaves unknown, ambiguous, code, nested, embed, raw HTML, and escaped syntax untouched", () => {
  const tree = renderTree(
    "[[Missing task]] and `[[Parent decision]]`\n\n```md\n[[Parent decision]]\n```",
  );

  expect(links(tree)).toEqual([]);
  expect(text(tree)).toContain("[[Missing task]]");
  expect(text(tree)).toContain("[[Parent decision]]");

  expect(links(renderTree("[[Parent decision]]", [parent, duplicate]))).toEqual([]);
  expect(links(renderTree("[Outer [[Parent decision]]](https://example.test)"))).toEqual([
    { url: "https://example.test", label: "Outer [[Parent decision]]" },
  ]);
  expect(links(renderTree("![[Parent decision]]"))).toEqual([]);
  expect(
    links(
      renderTree(
        '<a href="/task/test-environment/18000000-0000-4000-8000-000000000001">Parent</a>',
      ),
    ),
  ).toEqual([]);
  expect(links(renderTree("\\[\\[Parent decision\\]\\]"))).toEqual([]);
  expect(links(renderTree("\\[\\[Parent decision\\]\\] and [[Parent decision]]"))).toEqual([
    { url: `/task/test-environment/${parentId}`, label: "Parent decision" },
  ]);
});

it("resolves relative paths using host path case rules", () => {
  expect(links(renderTree("[[tasks/Parent decision.md]]"))).toEqual([
    { url: `/task/test-environment/${parentId}`, label: "Parent decision" },
  ]);
  expect(links(renderTree("[[tasks/README.md]]", [readme]))).toEqual([]);
  expect(links(renderTree("[[tasks/Readme.md]]", [readme]))).toEqual([
    { url: `/task/test-environment/${readmeId}`, label: "Readme" },
  ]);
  expect(links(renderTree("[[c:/VAULT/TASKS/WINDOWS ITEM.md]]", [windowsTask]))).toEqual([
    { url: `/task/test-environment/${windowsId}`, label: "Windows item" },
  ]);
});

it("resolves task links in recovered over-indented list prose", () => {
  const markdown =
    "A long preceding paragraph moves the recovered list past its synthetic child offsets.\n\n" +
    "-       see [[Parent decision]]";
  expect(links(renderTree(markdown, [parent], true))).toEqual([
    { url: `/task/test-environment/${parentId}`, label: "Parent decision" },
  ]);
});
