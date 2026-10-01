import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import { isSafeLinkHref, parseInlines, parseMarkdown, splitLinkTarget } from "./markdown.ts";

/** All user-visible text in an inline tree, in render order. */
const inlineText = (nodes) =>
  nodes
    .map((node) => {
      switch (node.type) {
        case "text":
        case "code":
          return node.text;
        case "break":
          return "\n";
        case "image":
          return `[image:${node.alt}]`;
        default:
          return inlineText(node.children);
      }
    })
    .join("");

/** All user-visible text in a block tree (the safety oracle). */
const blockText = (blocks) =>
  blocks
    .map((block) => {
      switch (block.type) {
        case "heading":
        case "paragraph":
          return inlineText(block.children);
        case "code":
          return block.info ? `${block.info}\n${block.text}` : block.text;
        case "quote":
          return blockText(block.children);
        case "list":
          return block.items.map((item) => blockText(item.children)).join("\n");
        case "rule":
          return "---";
      }
    })
    .join("\n");

const kinds = (blocks) => blocks.map((block) => block.type);

NodeTest.describe("parseMarkdown blocks", () => {
  NodeTest.it("parses ATX and setext headings", () => {
    NodeAssert.deepEqual(parseMarkdown("# Title"), [
      { type: "heading", level: 1, children: [{ type: "text", text: "Title" }] },
    ]);
    NodeAssert.deepEqual(kinds(parseMarkdown("### h3\nBody\n====\nnext\n---")), [
      "heading",
      "heading",
      "heading",
    ]);
    const setext = parseMarkdown("Underlined\n===");
    NodeAssert.equal(setext[0].type, "heading");
    NodeAssert.equal(setext[0].level, 1);
  });

  NodeTest.it("treats seven or more # characters as a paragraph", () => {
    NodeAssert.equal(parseMarkdown("####### not a heading")[0].type, "paragraph");
  });

  NodeTest.it("parses fenced code with info string and tolerates unclosed fences", () => {
    const fenced = parseMarkdown("```ts\nconst x = 1;\n```\nafter");
    NodeAssert.deepEqual(fenced[0], { type: "code", text: "const x = 1;", info: "ts" });
    NodeAssert.equal(fenced[1].type, "paragraph");
    const unclosed = parseMarkdown("```\nruns to end");
    NodeAssert.deepEqual(unclosed, [{ type: "code", text: "runs to end", info: "" }]);
  });

  NodeTest.it("parses indented code blocks", () => {
    NodeAssert.deepEqual(parseMarkdown("    indented()\n    more()"), [
      { type: "code", text: "indented()\nmore()", info: "" },
    ]);
  });

  NodeTest.it("parses unordered, ordered, nested and task lists", () => {
    const blocks = parseMarkdown(
      "- a\n- b\n  - nested\n\n1. one\n2. two\n\n- [x] done\n- [ ] todo",
    );
    NodeAssert.equal(blocks[0].type, "list");
    NodeAssert.equal(blocks[0].ordered, false);
    NodeAssert.equal(blocks[0].items.length, 2);
    const nested = blocks[0].items[1].children;
    NodeAssert.equal(nested[1].type, "list");
    NodeAssert.equal(blocks[1].type, "list");
    NodeAssert.equal(blocks[1].ordered, true);
    NodeAssert.equal(blocks[2].type, "list");
    NodeAssert.deepEqual(blocks[2].items[0].task, { checked: true });
    NodeAssert.deepEqual(blocks[2].items[1].task, { checked: false });
  });

  NodeTest.it("parses blockquotes recursively and horizontal rules", () => {
    const blocks = parseMarkdown("> quoted **bold**\n>\n> second para\n\n---");
    NodeAssert.equal(blocks[0].type, "quote");
    NodeAssert.equal(blocks[0].children.length, 2);
    NodeAssert.equal(blocks[0].children[0].children[1].type, "strong");
    NodeAssert.equal(blocks[1].type, "rule");
  });

  NodeTest.it("keeps paragraphs apart at blank lines", () => {
    NodeAssert.deepEqual(kinds(parseMarkdown("one\n\n two")), ["paragraph", "paragraph"]);
  });

  NodeTest.it("bounds quote recursion with the same depth cap", () => {
    const blocks = parseMarkdown("> ".repeat(200) + "deep");
    let depth = 0;
    let node = blocks[0];
    while (node !== undefined && node.type === "quote") {
      depth += 1;
      node = node.children[0];
    }
    NodeAssert.ok(depth <= 64, `quote depth ${depth} exceeds the cap`);
  });
});

NodeTest.describe("parseInlines", () => {
  NodeTest.it("parses strong, em, del and code spans", () => {
    NodeAssert.deepEqual(parseInlines("**b** *i* ~~d~~ `c`"), [
      { type: "strong", children: [{ type: "text", text: "b" }] },
      { type: "text", text: " " },
      { type: "em", children: [{ type: "text", text: "i" }] },
      { type: "text", text: " " },
      { type: "delete", children: [{ type: "text", text: "d" }] },
      { type: "text", text: " " },
      { type: "code", text: "c" },
    ]);
  });

  NodeTest.it("parses links and marks only safe schemes navigable", () => {
    const safe = parseInlines("[label](https://example.com/p)");
    NodeAssert.equal(safe[0].type, "link");
    NodeAssert.equal(safe[0].href, "https://example.com/p");
    NodeAssert.equal(safe[0].safe, true);
    for (const href of [
      "javascript:alert(1)",
      "data:text/html,<script>",
      "vbscript:msg",
      "file:///etc/passwd",
      "./relative",
      "x y",
    ]) {
      const parsed = parseInlines(`[l](${href})`);
      const link = parsed.find((node) => node.type === "link");
      NodeAssert.ok(link === undefined || link.safe === false, `unsafe href navigable: ${href}`);
    }
  });

  NodeTest.it("parses autolinks and keeps raw tags literal", () => {
    const auto = parseInlines("see <https://a.b/c> now");
    NodeAssert.equal(auto[1].type, "link");
    NodeAssert.equal(auto[1].href, "https://a.b/c");
    const email = parseInlines("<a@b.c>");
    NodeAssert.equal(email[0].href, "mailto:a@b.c");
  });

  NodeTest.it("parses images as inert alt+src text", () => {
    NodeAssert.deepEqual(parseInlines("![alt](pic.png)"), [
      { type: "image", alt: "alt", src: "pic.png" },
    ]);
  });

  NodeTest.it("honors backslash escapes and hard breaks", () => {
    NodeAssert.equal(inlineText(parseInlines("\\*not em\\* \\#")), "*not em* #");
    const hard = parseInlines("one  \ntwo");
    NodeAssert.ok(hard.some((node) => node.type === "break"));
  });

  NodeTest.it("bounds nesting depth and degrades to literal text past the cap", () => {
    // ~200 nested links in link text — recursion must stop at the depth
    // cap, leaving the unread remainder as literal text.
    let source = "end";
    for (let i = 0; i < 200; i += 1) source = `[l ${source}](https://a.b)`;
    const parsed = parseInlines(source);
    let depth = 0;
    let node = parsed[0];
    while (node !== undefined && node.type === "link") {
      depth += 1;
      node = node.children.find((child) => child.type === "link");
    }
    NodeAssert.ok(depth <= 64, `link nesting depth ${depth} exceeds the cap`);
    NodeAssert.ok(inlineText(parsed).includes("end"), "innermost text survives as literal");
  });

  NodeTest.it("bounds recursion on malformed input, not only well-formed nesting", () => {
    const maxDepth = (nodes, depth = 0) =>
      nodes.reduce(
        (max, n) => Math.max(max, n.children ? maxDepth(n.children, depth + 1) : depth),
        depth,
      );

    // Mis-nested link text/targets still drive real recursion — each level
    // strips one `[x `…`](u)` pair — so the cap must land here too.
    const misnested = "[x ".repeat(200) + "y" + "](u)".repeat(200);
    NodeAssert.equal(maxDepth(parseInlines(misnested)), 64);

    // Unclosed delimiters and marker soup degrade to literal text.
    for (const source of [
      "[".repeat(400) + "x" + "]".repeat(400),
      "![".repeat(400) + "x" + "]".repeat(400),
      "*a ".repeat(400),
      "~~".repeat(400),
    ]) {
      NodeAssert.ok(maxDepth(parseInlines(source)) <= 64);
    }

    // Malformed inline content inside a deep quote hits the same block cap.
    const quote = parseMarkdown("> ".repeat(300) + "[unclosed" + "![".repeat(100));
    let quoteDepth = 0;
    let node = quote[0];
    while (node !== undefined && node.type === "quote") {
      quoteDepth += 1;
      node = node.children[0];
    }
    NodeAssert.ok(quoteDepth <= 64, `malformed quote depth ${quoteDepth} exceeds the cap`);
  });
});

NodeTest.describe("markdown safety — no raw-HTML surface", () => {
  NodeTest.it("script tags render as literal text", () => {
    const blocks = parseMarkdown('# Hi\n\n<script>alert("x")</script>\n\nafter');
    NodeAssert.equal(inlineText(blocks[1].children), '<script>alert("x")</script>');
    NodeAssert.equal(blockText(blocks).includes("alert"), true);
    // The hostile source round-trips as inert text — nothing was interpreted.
    NodeAssert.ok(
      blockText(blocks).includes('<script>alert("x")</script>'),
      "script source must appear verbatim as text",
    );
  });

  NodeTest.it("event-handler HTML stays literal", () => {
    const blocks = parseMarkdown("<img src=x onerror=alert(1)>");
    NodeAssert.equal(blocks[0].type, "paragraph");
    NodeAssert.equal(inlineText(blocks[0].children), "<img src=x onerror=alert(1)>");
  });

  NodeTest.it("link destinations never become navigable for hostile schemes", () => {
    for (const source of [
      "[click](javascript:alert(document.cookie))",
      "[click](jAvAsCrIpT:alert(1))",
      "[click](data:text/html;base64,PHNjcmlwdD4=)",
      "[click](  javascript:alert(1)  )",
      // Entity smuggling: the parser never decodes `&#…;` — the raw
      // destination fails the scheme allowlist outright.
      "[click](java&#115;cript:alert)",
      "[click](java&#x73;cript:alert)",
      "[click](javascript&#58;alert)",
    ]) {
      const blocks = parseMarkdown(source);
      const links = [];
      const walk = (inlines) => {
        for (const node of inlines) {
          if (node.type === "link") links.push(node);
          if (node.children) walk(node.children);
        }
      };
      walk(blocks[0].children);
      NodeAssert.equal(links.length, 1, `${source} must parse as one link node`);
      for (const link of links) NodeAssert.equal(link.safe, false, link.href);
    }
  });

  NodeTest.it("fence contents are never re-parsed as markup", () => {
    const blocks = parseMarkdown("```html\n<script>alert(1)</script>\n```");
    NodeAssert.equal(blocks[0].type, "code");
    NodeAssert.equal(blocks[0].text, "<script>alert(1)</script>");
  });
});

NodeTest.describe("link helpers", () => {
  NodeTest.it("isSafeLinkHref allows only https/mailto/fragment", () => {
    for (const ok of ["https://a.b", "http://a.b", "mailto:a@b.c", "#section", "#a-b_c"])
      NodeAssert.equal(isSafeLinkHref(ok), true, ok);
    for (const bad of [
      "javascript:x",
      "data:x",
      "file:///x",
      "//a.b",
      "a/b",
      "ftp://a.b",
      "https://a b",
    ])
      NodeAssert.equal(isSafeLinkHref(bad), false, bad);
  });

  NodeTest.it("splitLinkTarget drops the optional title", () => {
    NodeAssert.equal(splitLinkTarget('https://a.b "title"').href, "https://a.b");
    NodeAssert.equal(splitLinkTarget("<https://a.b/c d> 't'").href, "https://a.b/c d");
    NodeAssert.equal(splitLinkTarget("x").href, "x");
  });
});
