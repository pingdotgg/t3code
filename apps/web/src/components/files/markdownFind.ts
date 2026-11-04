import { THREAD_FIND_BLOCK_TAGS } from "@t3tools/shared/threadFindText";
import { findThreadSearchOccurrences } from "@t3tools/shared/threadSearch";

const MATCH_HIGHLIGHT = "t3-markdown-find";
const ACTIVE_HIGHLIGHT = "t3-markdown-find-active";
const IGNORE = "svg, script, style, [data-thread-find-ignore], [role=toolbar]";
let searchCount = 0;

interface TextRun {
  readonly text: string;
  readonly nodes: readonly { readonly node: Text; readonly start: number; readonly end: number }[];
}

function indexText(container: HTMLElement): TextRun[] {
  const runs: TextRun[] = [];
  let text = "";
  let nodes: TextRun["nodes"][number][] = [];
  const flush = () => {
    if (text) runs.push({ text, nodes });
    text = "";
    nodes = [];
  };
  const visit = (node: Node, inPre = false) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const value = node.nodeValue ?? "";
      const start = text.length;
      text += inPre ? value : value.replace(/\n/g, " ");
      nodes.push({ node: node as Text, start, end: text.length });
      return;
    }
    if (!(node instanceof Element)) return;
    if (node.matches(IGNORE)) {
      flush();
      return;
    }
    const tag = node.tagName.toLowerCase();
    const block = THREAD_FIND_BLOCK_TAGS.has(tag);
    if (block) flush();
    for (const child of node.childNodes) visit(child, inPre || tag === "pre");
    if (block) flush();
  };
  visit(container);
  flush();
  return runs;
}

function findRanges(runs: readonly TextRun[], query: string): Range[] {
  const ranges: Range[] = [];
  for (const { text, nodes } of runs) {
    let startIndex = 0;
    let endIndex = 0;
    for (const offset of findThreadSearchOccurrences(text, query)) {
      while (startIndex < nodes.length && nodes[startIndex]!.end <= offset) startIndex++;
      endIndex = Math.max(endIndex, startIndex);
      while (endIndex < nodes.length && nodes[endIndex]!.end < offset + query.length) endIndex++;
      const start = nodes[startIndex];
      const end = nodes[endIndex];
      if (!start || !end) continue;
      const range = start.node.ownerDocument.createRange();
      range.setStart(start.node, offset - start.start);
      range.setEnd(end.node, offset + query.length - end.start);
      ranges.push(range);
    }
  }
  return ranges;
}

function highlight(name: string): Highlight {
  let value = CSS.highlights.get(name);
  if (!value) {
    value = new Highlight();
    CSS.highlights.set(name, value);
  }
  return value;
}

function reveal(range: Range, container: HTMLElement) {
  let folded = false;
  for (
    let node = range.startContainer.parentElement;
    node && container.contains(node);
    node = node.parentElement
  ) {
    if (node.matches("[hidden], [data-thread-find-fold]")) {
      node.dispatchEvent(new Event("beforematch"));
      folded = true;
    }
  }
  if (folded) return;

  const viewport = container.closest<HTMLElement>('[data-slot="scroll-area-viewport"]');
  if (!viewport) return;
  for (
    let node = range.startContainer.parentElement;
    node && viewport.contains(node);
    node = node.parentElement
  ) {
    const horizontal = node.scrollWidth > node.clientWidth;
    const vertical = node.scrollHeight > node.clientHeight;
    if (!horizontal && !vertical) continue;
    const style = getComputedStyle(node);
    const bounds = node.getBoundingClientRect();
    const rect = range.getBoundingClientRect();
    const inset = node === viewport ? 60 : 16;
    const left =
      horizontal && /auto|scroll/.test(style.overflowX)
        ? rect.left < bounds.left
          ? rect.left - bounds.left - 16
          : Math.max(0, rect.right - bounds.right + 16)
        : 0;
    const top =
      vertical && /auto|scroll/.test(style.overflowY)
        ? rect.top < bounds.top + inset || rect.bottom > bounds.bottom - 16
          ? rect.top - bounds.top - (node === viewport ? bounds.height / 2 : 16)
          : 0
        : 0;
    if (left || top) node.scrollBy({ left, top, behavior: "instant" });
    if (node === viewport) break;
  }
}

export function createMarkdownFind(
  container: HTMLElement,
  onChange: (result: { matchCount: number; activeIndex: number }) => void,
) {
  let runs: readonly TextRun[] | null = null;
  let ranges: Range[] = [];
  let activeIndex = 0;
  let query = "";
  let frame: number | null = null;
  let matchesDirty = true;
  searchCount++;
  const inactive = highlight(MATCH_HIGHLIGHT);
  const active = highlight(ACTIVE_HIGHLIGHT);
  active.priority = 1;
  const clear = () => {
    for (const range of ranges) {
      inactive.delete(range);
      active.delete(range);
    }
    ranges = [];
  };
  const select = () => {
    const selected = ranges[activeIndex];
    if (selected) {
      inactive.delete(selected);
      active.add(selected);
      reveal(selected, container);
    }
    onChange({ matchCount: ranges.length, activeIndex });
  };
  const refresh = () => {
    frame = null;
    if (matchesDirty) {
      clear();
      if (query) {
        runs ??= indexText(container);
        ranges = findRanges(runs, query);
        for (const range of ranges) inactive.add(range);
      }
      matchesDirty = false;
    }
    activeIndex = Math.min(activeIndex, Math.max(0, ranges.length - 1));
    select();
  };
  const schedule = () => {
    frame ??= requestAnimationFrame(refresh);
  };
  const observer = new MutationObserver((mutations) => {
    let changed = false;
    for (const mutation of mutations) {
      const target =
        mutation.target instanceof Element ? mutation.target : mutation.target.parentElement;
      if (target?.closest(IGNORE)) continue;
      if (mutation.type !== "attributes") {
        runs = null;
        matchesDirty = true;
      }
      changed = true;
    }
    if (changed && query) schedule();
  });
  observer.observe(container, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["hidden", "data-thread-find-fold", "data-wrap"],
  });
  return {
    search(value: string) {
      query = value.trim();
      activeIndex = 0;
      matchesDirty = true;
      schedule();
    },
    step(delta: number) {
      if (frame !== null) {
        cancelAnimationFrame(frame);
        refresh();
      }
      if (!ranges.length) return;
      const previous = ranges[activeIndex]!;
      active.delete(previous);
      inactive.add(previous);
      activeIndex = (activeIndex + delta + ranges.length) % ranges.length;
      select();
    },
    dispose() {
      observer.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
      clear();
      runs = null;
      if (--searchCount === 0) {
        CSS.highlights.delete(MATCH_HIGHLIGHT);
        CSS.highlights.delete(ACTIVE_HIGHLIGHT);
      }
    },
  };
}
