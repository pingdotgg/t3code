import { useLayoutEffect, useRef, useState } from "react";
import { createRoot, type Root as ReactRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import type { Element, Root, RootContent } from "hast";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { VFile } from "vfile";
import type { ScopedThreadRef } from "@t3tools/contracts";
import {
  CHAT_MARKDOWN_REMARK_PLUGINS,
  CHAT_MARKDOWN_REHYPE_PLUGINS,
} from "@t3tools/shared/markdownPipeline";
import { subscribeAssistantMessageText } from "../../state/entities";
import { createMarkdownBlockSplitter } from "./markdownStreamBlocks";
import { remarkParseWithoutUnusedSyntax } from "./markdownSyntaxGates";
import { rehypeHeadingIds } from "./markdownFragments";
import { rehypeTextDirection } from "./markdownTextDirection";
import { MarkdownCodeBlock } from "./MarkdownCodeBlock";
import { MarkdownTable } from "./MarkdownTable";
import { MarkdownExternalLinkContent, createLiveExternalLinkContent } from "./MarkdownExternalLink";
import { getSyntaxHighlighterPromise } from "../../lib/syntaxHighlighting";
import { createIncrementalHighlightedDocument } from "../../lib/incrementalHighlighting";
import { resolveDiffThemeName } from "../../lib/diffRendering";
import { chatMarkdownClipboardPayload } from "../../markdown-clipboard";
import { inlineCodeFilePathCandidate } from "@t3tools/shared/markdownLinks";

const processor = unified()
  .use(remarkParse)
  .use(remarkParseWithoutUnusedSyntax)
  .use(CHAT_MARKDOWN_REMARK_PLUGINS)
  .use(remarkRehype)
  .use(CHAT_MARKDOWN_REHYPE_PLUGINS)
  .use(rehypeHeadingIds)
  .use(rehypeTextDirection)
  .freeze();
const MARKDOWN_CLASS =
  "chat-markdown w-full min-w-0 [overflow-wrap:anywhere] [word-break:break-word] text-sm leading-relaxed text-foreground/[calc(90%+var(--appearance-contrast-boost)/10)]";

// Widgets and cross-block constructs retain the normal renderer as soon as they arrive.
const UNSUPPORTED = /!\[|\$|<|\[[^\]]*\]\((?:t3-|file:|\/|\.\.?\/)|\[!|★ Insight|:::/;

const linkIslands = new WeakMap<HTMLElement, { href: string; text: string; root?: ReactRoot }>();
const renderedNodes = new WeakMap<RootContent, Node>();
let nextLinkId = 0;

function hastAttributes(properties: Element["properties"]): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (value === null || value === undefined || value === false) continue;
    const name =
      key === "className"
        ? "class"
        : key === "htmlFor"
          ? "for"
          : /^(?:data|aria)[A-Z]/.test(key)
            ? key.replace(/[A-Z]/g, (letter) => "-" + letter.toLowerCase())
            : key.toLowerCase();
    attributes[name] = value === true ? "" : Array.isArray(value) ? value.join(" ") : String(value);
  }
  return attributes;
}

function patchHastAttributes(element: HTMLElement, properties: Element["properties"]) {
  const attributes = hastAttributes(properties);
  for (const attr of Array.from(element.attributes)) {
    if (!(attr.name in attributes)) element.removeAttribute(attr.name);
  }
  for (const [name, value] of Object.entries(attributes)) {
    if (element.getAttribute(name) !== value) element.setAttribute(name, value);
  }
}

function patchHast(
  parent: Node,
  children: RootContent[],
  oldChildren: Node[] = Array.from(parent.childNodes),
  boundary: Node | null = null,
) {
  for (let i = 0; i < children.length; i++) {
    const next = children[i]!;
    const before = oldChildren[i];
    if (before && renderedNodes.get(next) === before) continue;
    const island = before instanceof HTMLElement ? linkIslands.get(before) : undefined;
    if (
      island &&
      next.type === "element" &&
      next.tagName === "a" &&
      island.href === String(next.properties.href) &&
      island.text ===
        next.children.map((child) => (child.type === "text" ? child.value : "")).join("")
    )
      continue;
    island?.root?.unmount();
    if (island && before instanceof HTMLElement) linkIslands.delete(before);
    if (before instanceof Text && next.type === "text") {
      if (before.data !== next.value) {
        if (next.value.startsWith(before.data)) before.appendData(next.value.slice(before.length));
        else before.data = next.value;
      }
    } else if (
      before instanceof HTMLElement &&
      next.type === "element" &&
      before.tagName.toLowerCase() === next.tagName
    ) {
      patchHastAttributes(before, next.properties);
      patchHast(before, next.children);
      renderedNodes.set(next, before);
    } else if (before) parent.replaceChild(domNode(next), before);
    else parent.insertBefore(domNode(next), boundary);
  }
  for (let i = children.length; i < oldChildren.length; i++) {
    const node = oldChildren[i]!;
    if (node instanceof HTMLElement) linkIslands.get(node)?.root?.unmount();
    node.parentNode?.removeChild(node);
  }
}

function domNode(node: RootContent): Node {
  if (node.type === "text") return document.createTextNode(node.value);
  if (node.type !== "element") return document.createComment("");
  const element = document.createElement(node.tagName);
  for (const [name, value] of Object.entries(hastAttributes(node.properties)))
    element.setAttribute(name, value);
  for (const child of node.children) element.appendChild(domNode(child));
  renderedNodes.set(node, element);
  return element;
}

function mountLinks(block: LiveBlock) {
  for (const node of blockNodes(block)) {
    if (!(node instanceof HTMLElement)) continue;
    const anchors = node.matches("a") ? [node] : Array.from(node.querySelectorAll("a"));
    for (const anchor of anchors) {
      if (linkIslands.has(anchor)) continue;
      const href = anchor.getAttribute("href") ?? "";
      if (!/^https?:/.test(href) || !URL.canParse(href)) {
        anchor.className ||= "";
        if (!href.startsWith("#")) {
          anchor.setAttribute("target", "_blank");
          anchor.setAttribute("rel", "noopener noreferrer");
        }
        continue;
      }
      const text = anchor.textContent ?? "";
      const host = new URL(href).hostname;
      anchor.setAttribute("target", "_blank");
      anchor.setAttribute("rel", "noopener noreferrer");
      anchor.setAttribute("data-base-ui-tooltip-trigger", "");
      anchor.setAttribute("data-slot", "tooltip-trigger");
      anchor.id = `«live-link-${nextLinkId++}»`;
      const content = createLiveExternalLinkContent(host, text);
      if (content) {
        anchor.replaceChildren(content);
        linkIslands.set(anchor, { href, text });
      } else {
        const root = createRoot(anchor);
        block.linkRoots ??= [];
        block.linkRoots.push(root);
        linkIslands.set(anchor, { href, text, root });
        root.render(
          <MarkdownExternalLinkContent host={host} plainText={text}>
            {text}
          </MarkdownExternalLinkContent>,
        );
      }
    }
  }
}

function startTailLayout(host: HTMLElement, initiallyFollowing: boolean) {
  const frame = host.closest<HTMLElement>(".messages-timeline-row-frame");
  const viewport = host.closest<HTMLElement>(".messages-timeline-scroll");
  const content = viewport?.firstElementChild;
  if (!frame || !viewport || !(content instanceof HTMLElement))
    return { dispose: () => {}, setFollowing: (_value: boolean) => {} };
  const rowContent =
    frame.firstElementChild instanceof HTMLElement ? frame.firstElementChild : host;
  const itemContainer = frame.parentElement;
  const originalContain = itemContainer?.style.contain ?? "";
  if (itemContainer) itemContainer.style.contain = "layout style";
  const initial = rowContent.getBoundingClientRect().height;
  const originalHeight = frame.style.height;
  const originalPadding = content.style.paddingBottom;
  const padding = Number.parseFloat(getComputedStyle(content).paddingBottom) || 0;
  let baseExtent = viewport.scrollHeight;
  let viewportHeight = viewport.clientHeight;
  let growth = 0;
  let container: HTMLElement = frame;
  while (container.parentElement && container.parentElement !== content)
    container = container.parentElement;
  const followingSiblings: HTMLElement[] = [];
  for (const row of container.querySelectorAll<HTMLElement>(
    '[data-timeline-row-kind="working"], [data-timeline-row-kind="thinking"]',
  )) {
    const sibling = row.closest<HTMLElement>(".messages-timeline-row-frame");
    if (sibling && frame.compareDocumentPosition(sibling) & Node.DOCUMENT_POSITION_FOLLOWING)
      followingSiblings.push(sibling);
  }
  for (let sibling = container.nextElementSibling; sibling; sibling = sibling.nextElementSibling) {
    if (sibling instanceof HTMLElement) followingSiblings.push(sibling);
  }
  const transforms = followingSiblings.map((sibling) => sibling.style.transform);
  frame.style.height = `${frame.getBoundingClientRect().height}px`;
  let following = initiallyFollowing;
  let ownTop: number | null = null;
  let pending: number | null = null;
  const release = (event: Event) => {
    if (event instanceof PointerEvent && event.target !== viewport) return;
    if (
      event instanceof KeyboardEvent &&
      event.target instanceof HTMLElement &&
      event.target.closest("input, textarea, [contenteditable]")
    )
      return;
    if (event instanceof WheelEvent && event.deltaY >= 0) return;
    if (event instanceof KeyboardEvent && !["ArrowUp", "PageUp", "Home"].includes(event.key))
      return;
    following = false;
    ownTop = null;
  };
  const scroll = (event: Event) => {
    if (event.target !== viewport) return;
    if (ownTop !== null && Math.abs(viewport.scrollTop - ownTop) < 1) {
      event.stopImmediatePropagation();
      return;
    }
    ownTop = null;
    if (!following)
      following = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop < 24;
  };
  const update = () => {
    pending = null;
    if (following) {
      ownTop = Math.max(0, baseExtent + growth - viewportHeight);
      viewport.scrollTop = ownTop;
    }
  };
  // oxlint-disable-next-line t3code/no-raw-resize-observer -- this boundary mutates only DOM and schedules no React state
  const observer = new ResizeObserver((entries) => {
    if (entries.some((entry) => entry.target === viewport)) viewportHeight = viewport.clientHeight;
    const entry = entries.find((entry) => entry.target === rowContent);
    if (entry) {
      growth =
        (entry.borderBoxSize[0]?.blockSize ?? rowContent.getBoundingClientRect().height) - initial;
      content.style.paddingBottom = `${padding + growth}px`;
      followingSiblings.forEach((sibling) => {
        sibling.style.transform = `translateY(${growth}px)`;
      });
    }
    pending ??= requestAnimationFrame(update);
  });
  observer.observe(rowContent);
  observer.observe(viewport);
  viewport.addEventListener("wheel", release, { passive: true });
  viewport.addEventListener("touchmove", release, { passive: true });
  viewport.addEventListener("pointerdown", release);
  document.addEventListener("keydown", release);
  document.addEventListener("scroll", scroll, true);
  const dispose = () => {
    observer.disconnect();
    if (pending !== null) cancelAnimationFrame(pending);
    const top = viewport.scrollTop;
    const parent = host.parentElement;
    const viewportTop = viewport.getBoundingClientRect().top;
    const candidates = Array.from(
      host.querySelectorAll<HTMLElement>("p, li, h1, h2, h3, h4, h5, h6, .line, td, th"),
    );
    const anchor = candidates.find((node) => {
      const rect = node.getBoundingClientRect();
      return rect.top >= viewportTop && rect.bottom <= viewportTop + viewport.clientHeight;
    });
    const anchorText = anchor?.textContent;
    const anchorTag = anchor?.tagName;
    const anchorOffset = anchor?.getBoundingClientRect().top;
    const anchorIndex = anchor
      ? candidates
          .filter((node) => node.tagName === anchorTag && node.textContent === anchorText)
          .indexOf(anchor)
      : -1;
    frame.style.height = originalHeight;
    if (itemContainer) itemContainer.style.contain = originalContain;
    content.style.paddingBottom = originalPadding;
    followingSiblings.forEach((sibling, i) => {
      sibling.style.transform = transforms[i]!;
    });
    requestAnimationFrame(() => {
      if (following) viewport.scrollTop = viewport.scrollHeight;
      else {
        const next = Array.from(
          parent?.querySelectorAll<HTMLElement>(
            ".chat-markdown p, .chat-markdown li, .chat-markdown :is(h1,h2,h3,h4,h5,h6), .chat-markdown .line, .chat-markdown td, .chat-markdown th",
          ) ?? [],
        ).filter((node) => node.tagName === anchorTag && node.textContent === anchorText)[
          anchorIndex
        ];
        viewport.scrollTop = top;
        if (next && anchorOffset !== undefined)
          viewport.scrollTop += next.getBoundingClientRect().top - anchorOffset;
      }
      // Streaming follow scrolls bypass the list; publish its restored position at handoff.
      viewport.dispatchEvent(new Event("scroll"));
    });
    viewport.removeEventListener("wheel", release);
    viewport.removeEventListener("touchmove", release);
    viewport.removeEventListener("pointerdown", release);
    document.removeEventListener("keydown", release);
    document.removeEventListener("scroll", scroll, true);
  };
  return {
    dispose,
    setFollowing: (value: boolean) => {
      following = value;
      if (following) {
        baseExtent = viewport.scrollHeight - growth;
        viewportHeight = viewport.clientHeight;
        pending ??= requestAnimationFrame(update);
      }
    },
  };
}

type ChromeTemplates = Map<string, { root: ReactRoot; ready: Promise<HTMLElement> }>;

function chromeTemplate(
  cache: ChromeTemplates,
  kind: "code" | "table",
  language: string,
  theme: "light" | "dark",
) {
  const key = `${kind}:${language}:${theme}`;
  const cached = cache.get(key);
  if (cached) return cached.ready;
  const root = createRoot(document.createDocumentFragment());
  const ready = new Promise<HTMLElement>((resolve) => {
    const capture = (node: HTMLElement | null) => {
      if (node)
        queueMicrotask(() =>
          resolve(
            node.closest<HTMLElement>(
              kind === "code" ? ".chat-markdown-codeblock" : ".chat-markdown-table-container",
            )!,
          ),
        );
    };
    root.render(
      kind === "code" ? (
        <MarkdownCodeBlock code="" language={language} fenceTitle={null} theme={theme} isStreaming>
          <div className="chat-markdown-shiki" ref={capture} />
        </MarkdownCodeBlock>
      ) : (
        <MarkdownTable ref={capture} />
      ),
    );
  });
  cache.set(key, { root, ready });
  return ready;
}

function cloneChrome(template: HTMLElement) {
  const clone = template.cloneNode(true) as HTMLElement;
  const ids = new Map<string, string>();
  for (const node of [clone, ...clone.querySelectorAll("*")]) {
    for (const attribute of Array.from(node.attributes)) {
      if (!/^(?:id|aria-|data-id)/.test(attribute.name) || !/«|_r_|:r/.test(attribute.value))
        continue;
      let id = ids.get(attribute.value);
      if (!id) {
        id = `«live-chrome-${nextLinkId++}»`;
        ids.set(attribute.value, id);
      }
      node.setAttribute(attribute.name, id);
    }
  }
  for (const viewport of clone.querySelectorAll<HTMLElement>(
    '[data-slot="scroll-area-viewport"]',
  )) {
    for (const side of ["x-start", "x-end", "y-start", "y-end"]) {
      viewport.style.setProperty(`--scroll-area-overflow-${side}`, "0px");
    }
  }
  return clone;
}

type LiveBlock = {
  source: string;
  host: HTMLElement;
  start: Comment;
  end: Comment;
  chrome?: "code" | "table";
  linkRoots?: ReactRoot[];
  rows?: { kind: "list" | "table"; prefix: string; lines: string[]; element: HTMLElement };
  table?: HTMLTableElement | null;
  codeHost?: HTMLDivElement | null;
  code?: string;
  highlight?: ReturnType<typeof createIncrementalHighlightedDocument>;
  openFence?: { offset: number; close: RegExp };
  disposed?: boolean;
  tableCheck?: number;
  onOverflow: () => void;
};

function checkTableWidth(block: LiveBlock) {
  if (block.tableCheck !== undefined) return;
  block.tableCheck = requestAnimationFrame(() => {
    delete block.tableCheck;
    if (block.disposed) return;
    const viewport = block.table?.parentElement;
    if (viewport && viewport.scrollWidth > viewport.clientWidth + 1) block.onOverflow();
  });
}

function blockNodes(block: LiveBlock): Node[] {
  const nodes: Node[] = [];
  for (let node = block.start.nextSibling; node && node !== block.end; node = node.nextSibling)
    nodes.push(node);
  return nodes;
}

function prepareNode(node: RootContent) {
  if (node.type !== "element") return;
  if (node.tagName === "a") delete node.properties.title;
  if (/^h[1-6]$/.test(node.tagName))
    node.properties.ariaLevel = Math.min(Number(node.tagName[1]) + 3, 6);
  if ((node.tagName === "th" || node.tagName === "td") && node.properties.align) {
    node.properties.style = `text-align: ${node.properties.align}`;
    delete node.properties.align;
  }
  if (node.tagName === "ol") {
    const first = Number(node.properties.start ?? 1);
    const count = node.children.filter(
      (child) => child.type === "element" && child.tagName === "li",
    ).length;
    const width = Math.max(String(first).length, String(first + Math.max(0, count - 1)).length);
    if (width > 1) node.properties.style = `--list-gutter: ${width + 2}ch`;
  }
  // JSX omits whitespace-only children of table elements.
  if (["table", "thead", "tbody", "tfoot", "tr"].includes(node.tagName))
    node.children = node.children.filter((child) => child.type !== "text" || child.value.trim());
  node.children.forEach(prepareNode);
}

function updateCode(block: LiveBlock) {
  if (!block.codeHost) return;
  if (block.highlight) {
    try {
      const tree = block.highlight(block.code ?? "");
      patchHast(block.codeHost, tree.children as RootContent[]);
      return;
    } catch {
      block.highlight.dispose();
      delete block.highlight;
    }
  }
  patchHast(block.codeHost, [
    {
      type: "element",
      tagName: "pre",
      properties: {},
      children: [
        {
          type: "element",
          tagName: "code",
          properties: {},
          children: [{ type: "text", value: block.code ?? "" }],
        },
      ],
    },
  ]);
}

function parseMarkdown(source: string): Root {
  const file = new VFile(source);
  return processor.runSync(processor.parse(file), file) as Root;
}

function flatListLines(source: string): string[] | null {
  const lines = source.replace(/\n+$/, "").split("\n");
  const marker = /^(?:([-+*])|\d{1,9}([.)])) /;
  const first = marker.exec(lines[0] ?? "");
  if (!first || /[^\x00-\x7f]|\n\n|^.*? \[[ xX]\]/m.test(source)) return null;
  return lines.every((line) => {
    const match = marker.exec(line);
    return match && match[1] === first[1] && match[2] === first[2];
  })
    ? lines
    : null;
}

function updateListGutter(element: HTMLElement, lines: string[]) {
  if (element.tagName !== "OL") return;
  const first = Number(/^\d+/.exec(lines[0]!)?.[0] ?? 1);
  const width = Math.max(String(first).length, String(first + lines.length - 1).length);
  if (width > 1) element.style.setProperty("--list-gutter", `${width + 2}ch`);
  else element.style.removeProperty("--list-gutter");
}

function plainRow(state: NonNullable<LiveBlock["rows"]>, line: string): Element | null {
  const plain = (text: string) => /^[a-zA-Z0-9 .,!?'";/()-]*$/.test(text) && !/www\./i.test(text);
  if (state.kind === "list") {
    const text = line.replace(/^(?:[-+*]|\d{1,9}[.)]) /, "").trimEnd();
    if (!plain(text) || !/^[a-zA-Z0-9]/.test(text)) return null;
    return {
      type: "element",
      tagName: "li",
      properties: {},
      children: [{ type: "text", value: text }],
    };
  }
  const cells = line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
  if (!cells.every(plain)) return null;
  const headers =
    state.element.parentElement?.querySelectorAll<HTMLTableCellElement>("thead th") ?? [];
  return {
    type: "element",
    tagName: "tr",
    properties: {},
    children: Array.from(headers, (header, i) => ({
      type: "element",
      tagName: "td",
      properties: header.style.textAlign ? { style: `text-align: ${header.style.textAlign}` } : {},
      children: cells[i] ? [{ type: "text", value: cells[i] }] : [],
    })),
  };
}

function updateRows(block: LiveBlock, source: string): boolean | null {
  const state = block.rows;
  if (!state || !source.startsWith(block.source)) return null;
  const lines =
    state.kind === "list"
      ? flatListLines(source)
      : source.startsWith(state.prefix) && !/[^\x00-\x7f]|\n\n/.test(source)
        ? source.slice(state.prefix.length).replace(/\n+$/, "").split("\n").filter(Boolean)
        : null;
  if (!lines || (state.kind === "table" && lines.some((line) => !/^ *\|/.test(line)))) return null;
  let changed = 0;
  while (changed < state.lines.length && state.lines[changed] === lines[changed]) changed++;
  const next: RootContent[] = [];
  for (let i = changed; i < lines.length; i++) {
    const plain = plainRow(state, lines[i]!);
    if (plain) {
      next.push(plain);
      if (state.kind === "list") next.push({ type: "text", value: "\n" });
      continue;
    }
    const tree = parseMarkdown(state.prefix + lines[i]!);
    if (unsupportedNode(tree)) return false;
    tree.children.forEach(prepareNode);
    const element = tree.children.find((node) => node.type === "element");
    if (element?.type !== "element") return null;
    const parent =
      state.kind === "list"
        ? element
        : element.children.find((node) => node.type === "element" && node.tagName === "tbody");
    const row =
      parent && "children" in parent
        ? parent.children.find((node) => node.type === "element")
        : null;
    if (!row) return null;
    next.push(row);
    if (state.kind === "list") next.push({ type: "text", value: "\n" });
  }
  const offset = state.kind === "list" ? changed * 2 + 1 : changed;
  patchHast(state.element, next, Array.from(state.element.childNodes).slice(offset));
  if (state.kind === "list") updateListGutter(state.element, lines);
  state.lines = lines;
  block.source = source;
  mountLinks(block);
  if (state.kind === "table") checkTableWidth(block);
  return true;
}

function rememberRows(block: LiveBlock, source: string, only: Element | null) {
  delete block.rows;
  if (only?.tagName === "ul" || only?.tagName === "ol") {
    const lines = flatListLines(source);
    const element = blockNodes(block).find(
      (node) => node instanceof HTMLElement && node.tagName.toLowerCase() === only.tagName,
    );
    if (lines && element instanceof HTMLElement && element.children.length === lines.length)
      block.rows = { kind: "list", prefix: "", lines, element };
  } else if (only?.tagName === "table" && block.table?.tBodies[0]) {
    const headerEnd = source.indexOf("\n", source.indexOf("\n") + 1) + 1;
    if (headerEnd > 0 && !/[^\x00-\x7f]|\n\n/.test(source))
      block.rows = {
        kind: "table",
        prefix: source.slice(0, headerEnd),
        lines: source.slice(headerEnd).replace(/\n+$/, "").split("\n").filter(Boolean),
        element: block.table.tBodies[0],
      };
  }
}

function renderBlock(
  block: LiveBlock,
  source: string,
  theme: "light" | "dark",
  templates: ChromeTemplates,
) {
  if (
    block.openFence &&
    source.startsWith(block.source) &&
    !block.openFence.close.test(source.slice(block.openFence.offset))
  ) {
    const code = source.slice(block.openFence.offset);
    block.code = code && !code.endsWith("\n") ? `${code}\n` : code;
    block.source = source;
    updateCode(block);
    return;
  }
  const added = source.slice(block.source.length);
  const previousContent = block.source.trimEnd();
  const pendingWhitespace = block.source.slice(previousContent.length);
  let tail: Node | null =
    block.rows?.kind === "table"
      ? (block.rows.element.lastElementChild?.lastElementChild ?? null)
      : (blockNodes(block).at(-1) ?? null);
  while (tail?.lastChild) {
    tail =
      tail instanceof HTMLElement && /^(?:UL|OL)$/.test(tail.tagName)
        ? tail.lastElementChild
        : tail.lastChild;
  }
  if (
    block.source &&
    source.startsWith(block.source) &&
    /^[a-zA-Z0-9 .,!?;'-]+$/.test(added) &&
    tail instanceof Text &&
    ["P", "LI", "TD", "TH"].includes(tail.parentElement?.tagName ?? "") &&
    tail.data &&
    previousContent.endsWith(tail.data) &&
    !pendingWhitespace.includes("\n") &&
    !/www\./i.test(tail.data + added) &&
    !/\S*[.:/@]\S*$/.test(tail.data)
  ) {
    const appended = (pendingWhitespace + added).trimEnd();
    if (appended) tail.appendData(appended);
    block.source = source;
    return;
  }
  const rows = updateRows(block, source);
  if (rows !== null) return rows === false ? false : undefined;
  const tree = parseMarkdown(source);
  delete block.rows;
  if (unsupportedNode(tree)) return false;
  block.source = source;
  tree.children.forEach(prepareNode);
  const meaningful = tree.children.filter((node) => node.type !== "text" || node.value.trim());
  const only = meaningful.length === 1 && meaningful[0]?.type === "element" ? meaningful[0] : null;
  if (
    (block.chrome === "code" && only?.tagName !== "pre") ||
    (block.chrome === "table" && only?.tagName !== "table")
  )
    return false;
  if (only?.tagName === "pre") {
    if (!source.includes("\n")) {
      patchHast(block.host, tree.children, blockNodes(block), block.end);
      return;
    }
    const code = only.children[0];
    if (code?.type !== "element") return;
    block.code = code.children.map((node) => (node.type === "text" ? node.value : "")).join("");
    const fence = /^(`{3,}|~{3,})\w*\n/.exec(source);
    if (fence) {
      const close = new RegExp(`^${fence[1]![0]}{${fence[1]!.length},}[ \\t]*(?:\\n|$)`, "m");
      if (!close.test(source.slice(fence[0].length)))
        block.openFence = { offset: fence[0].length, close };
      else delete block.openFence;
    }
    if (!block.chrome) {
      block.chrome = "code";
      const language = String(code.properties.className ?? "language-text").replace(
        /^language-/,
        "",
      );
      for (const node of blockNodes(block)) node.parentNode?.removeChild(node);
      void chromeTemplate(templates, "code", language, theme).then((template) => {
        if (block.disposed) return;
        const frame = cloneChrome(template);
        block.codeHost = frame.querySelector<HTMLDivElement>(".chat-markdown-shiki");
        block.host.insertBefore(frame, block.end);
        updateCode(block);
      });
      void getSyntaxHighlighterPromise(language)
        .then((highlighter) => {
          if (block.disposed) return;
          block.highlight = createIncrementalHighlightedDocument(
            highlighter,
            language,
            resolveDiffThemeName(theme),
          );
          updateCode(block);
        })
        .catch(() => {});
    }
    updateCode(block);
  } else if (only?.tagName === "table") {
    if (!block.chrome) {
      block.chrome = "table";
      for (const node of blockNodes(block)) node.parentNode?.removeChild(node);
      void chromeTemplate(templates, "table", "", theme).then((template) => {
        if (block.disposed) return;
        const frame = cloneChrome(template);
        block.table = frame.querySelector("table");
        block.host.insertBefore(frame, block.end);
        renderBlock(block, block.source, theme, templates);
      });
    } else if (block.table) {
      patchHastAttributes(block.table, only.properties);
      patchHast(block.table, only.children);
      mountLinks(block);
      rememberRows(block, source, only);
      checkTableWidth(block);
    }
  } else {
    patchHast(block.host, tree.children, blockNodes(block), block.end);
    mountLinks(block);
    rememberRows(block, source, only);
  }
}

function unsupportedNode(node: Root | RootContent, inPre = false): boolean {
  if (node.type === "element") {
    if (node.tagName === "a" && !/^(?:https?:|mailto:|#)/.test(String(node.properties.href)))
      return true;
    if (node.tagName === "a" && node.children.some((child) => child.type !== "text")) return true;
    if (node.tagName === "img" || node.properties.dataAlert !== undefined) return true;
    if (node.tagName === "code") {
      if (
        node.properties.dataCodeMeta !== undefined ||
        /language-(?:mermaid|math|latex)/.test(String(node.properties.className))
      )
        return true;
      if (
        !inPre &&
        inlineCodeFilePathCandidate(
          node.children.map((child) => (child.type === "text" ? child.value : "")).join(""),
        )
      )
        return true;
    }
    inPre ||= node.tagName === "pre";
  }
  return "children" in node && node.children.some((child) => unsupportedNode(child, inPre));
}

export function ImperativeLiveMarkdown({
  threadRef,
  itemId,
  initialText,
  theme,
  followEnabled,
  onFallback,
}: {
  threadRef: ScopedThreadRef;
  itemId: string;
  initialText: string;
  theme: "light" | "dark";
  followEnabled: boolean;
  onFallback: () => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const layoutRef = useRef<ReturnType<typeof startTailLayout> | null>(null);
  const [fallback] = useState(() => onFallback);
  const [initialFollowEnabled] = useState(followEnabled);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- owns the live DOM and its authoritative text subscription
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const split = createMarkdownBlockSplitter();
    const blocks: LiveBlock[] = [];
    const templates: ChromeTemplates = new Map();
    let previous = "";
    let stopped = false;
    const layout = startTailLayout(host, initialFollowEnabled);
    layoutRef.current = layout;
    const stop = () => {
      stopped = true;
      fallback();
    };
    const update = (text: string | null) => {
      if (stopped || text === null || text === previous) return;
      if (
        !text.startsWith(previous) ||
        UNSUPPORTED.test(text.slice(Math.max(0, previous.length - 64)))
      ) {
        stop();
        return;
      }
      const sources = split(text);
      if (sources === null) {
        stop();
        return;
      }
      previous = text;
      while (blocks.length > sources.length) {
        const block = blocks.pop()!;
        block.disposed = true;
        block.highlight?.dispose();
        for (const root of block.linkRoots ?? []) queueMicrotask(() => root.unmount());
        for (const node of blockNodes(block)) node.parentNode?.removeChild(node);
        block.start.remove();
        block.end.remove();
      }
      for (let i = 0; i < sources.length; i++) {
        let block = blocks[i];
        if (!block) {
          const start = document.createComment("block");
          const end = document.createComment("/block");
          host.append(start, end);
          block = {
            source: "",
            host,
            start,
            end,
            onOverflow: stop,
          };
          blocks.push(block);
        }
        if (
          block.source !== sources[i] &&
          renderBlock(block, sources[i]!, theme, templates) === false
        ) {
          stop();
          return;
        }
      }
    };
    update(initialText);
    const unsubscribe = subscribeAssistantMessageText(threadRef, itemId, update);
    return () => {
      stopped = true;
      unsubscribe();
      layout.dispose();
      layoutRef.current = null;
      for (const template of templates.values()) queueMicrotask(() => template.root.unmount());
      for (const block of blocks) {
        block.disposed = true;
        block.highlight?.dispose();
        for (const root of block.linkRoots ?? []) queueMicrotask(() => root.unmount());
      }
      host.replaceChildren();
    };
  }, [threadRef, itemId, initialText, theme, fallback, initialFollowEnabled]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- feeds user navigation changes into the native follow controller
  useLayoutEffect(() => {
    layoutRef.current?.setFollowing(followEnabled);
  }, [followEnabled]);
  return (
    <div
      ref={hostRef}
      className={MARKDOWN_CLASS}
      data-streaming=""
      data-imperative-live=""
      onPointerOverCapture={(event) => {
        const target = (event.target as HTMLElement).closest("a, [data-base-ui-tooltip-trigger]");
        const parent = hostRef.current?.parentElement;
        if (!target || !parent) return;
        const selector = "a, [data-base-ui-tooltip-trigger]";
        const index = Array.from(hostRef.current!.querySelectorAll(selector)).indexOf(target);
        flushSync(fallback);
        const next = parent.querySelectorAll(selector)[index];
        next?.dispatchEvent(
          new MouseEvent("mouseover", { bubbles: true, relatedTarget: event.relatedTarget }),
        );
      }}
      onClickCapture={(event) => {
        const selector = "a, button";
        const target = (event.target as HTMLElement).closest(selector);
        const parent = hostRef.current?.parentElement;
        if (target && parent) {
          const index = Array.from(hostRef.current!.querySelectorAll(selector)).indexOf(target);
          event.preventDefault();
          event.stopPropagation();
          flushSync(fallback);
          parent.querySelectorAll(selector)[index]?.dispatchEvent(
            new MouseEvent("click", {
              bubbles: true,
              cancelable: true,
              button: event.button,
              ctrlKey: event.ctrlKey,
              metaKey: event.metaKey,
              shiftKey: event.shiftKey,
              altKey: event.altKey,
            }),
          );
        }
      }}
      onContextMenuCapture={(event) => {
        const anchor = (event.target as HTMLElement).closest("a");
        const parent = hostRef.current?.parentElement;
        if (!anchor || !parent) return;
        const index = Array.from(hostRef.current!.querySelectorAll("a")).indexOf(anchor);
        event.preventDefault();
        event.stopPropagation();
        flushSync(fallback);
        parent.querySelectorAll(".chat-markdown a")[index]?.dispatchEvent(
          new MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            clientX: event.clientX,
            clientY: event.clientY,
          }),
        );
      }}
      onDoubleClick={(event) => {
        const code = (event.target as HTMLElement).closest("code");
        if (code && !code.closest("pre")) window.getSelection()?.selectAllChildren(code);
      }}
      onCopy={(event) => {
        const selection = window.getSelection();
        const payload = selection && chatMarkdownClipboardPayload(selection);
        if (!payload) return;
        event.preventDefault();
        event.clipboardData.setData("text/plain", payload.text);
        event.clipboardData.setData("text/html", payload.html);
      }}
    />
  );
}
