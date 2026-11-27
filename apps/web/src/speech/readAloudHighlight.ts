import type { ReadAloudHighlight } from "@t3tools/client-runtime/read-aloud";
import {
  readAloudSourceAtShown,
  spokenWordAt,
  type ReadAloudCue,
} from "@t3tools/shared/read-aloud";
import { readAloudController } from "./readAloud";

const BLOCK_HIGHLIGHT = "t3-read-aloud-block";
const WORD_HIGHLIGHT = "t3-read-aloud-word";
const HOVER_HIGHLIGHT = "t3-read-aloud-hover";
/** Text a listener never hears: controls, icons, labels the UI adds, and math markup. */
const UNSPOKEN_SELECTOR =
  "svg, button, [role=button], [data-thread-find-ignore], [aria-hidden=true], .katex";
/** After the user scrolls, following waits this long and for the word to be back in view. */
const FOLLOW_PAUSE_MS = 3_000;
/** Following holds still this long after the pointer lands on a word, so a click hits that word. */
const HOVER_HOLD_MS = 1_500;
/** The word stays in the middle of the timeline; leaving that band scrolls it to 40%. */
const FOLLOW_BAND = { top: 0.2, bottom: 0.8, target: 0.4 };
/** The elements read aloud as one block each; matches `rehypeSpeechOffsets`. */
const SPEECH_BLOCK_SELECTOR = "p, li, h1, h2, h3, h4, h5, h6, tr, pre";
/** Elements that keep their own clicks: links, controls, code blocks, and math. */
const INTERACTIVE_SELECTOR =
  "a, button, input, textarea, select, summary, label, pre, [role=button], [role=link], [contenteditable=true], .katex";
const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);

const roots = new Map<string, HTMLElement>();
let highlights: {
  readonly block: Highlight;
  readonly word: Highlight;
  readonly hover: Highlight;
} | null = null;
let scroller: HTMLElement | null = null;
let userScrolledAt: number | null = null;
let hoveredAt: number | null = null;
let readingId: string | null = null;
// The word being read, for the player's way back to it.
let readingRange: Range | null = null;
// Where the word being read is, relative to the view, while it is out of view.
let away: "above" | "below" | null = null;
const awayListeners = new Set<() => void>();
let reveal: ((id: string) => boolean) | null = null;

function setAway(next: typeof away) {
  if (next === away) return;
  away = next;
  for (const listener of awayListeners) listener();
}

function measureAway() {
  if (!readingId) return setAway(null);
  // Virtualized out of the DOM: it went the way it was last seen going.
  if (!readingRange || !scroller || !readingRange.startContainer.isConnected)
    return setAway(away ?? "below");
  const rect = readingRange.getBoundingClientRect();
  const view = scroller.getBoundingClientRect();
  setAway(rect.bottom < view.top ? "above" : rect.top > view.bottom ? "below" : null);
}

/** Which way the word being read is scrolled out of view, if it is; virtualized away counts. */
export const readAloudAway = () => away;
export function subscribeReadAloudAway(listener: () => void) {
  awayListeners.add(listener);
  return () => {
    awayListeners.delete(listener);
  };
}

/** The timeline lends this a way to scroll a reply back in after virtualization dropped it. */
export function setReadAloudRevealer(next: (id: string) => boolean) {
  reveal = next;
  return () => {
    if (reveal === next) reveal = null;
  };
}

/** Brings the word being read back into view and lets the thread follow it again. */
export function returnToReadAloud() {
  if (!readingId) return;
  userScrolledAt = null;
  if (readingRange?.startContainer.isConnected) follow(readingRange, true);
  else reveal?.(readingId);
}

const supported = () =>
  typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight !== "undefined";

/**
 * A ref for the element that renders message `id`'s markdown. Rows mount and unmount as the
 * timeline virtualizes, so the highlight is painted again whenever the row returns.
 */
export function readAloudHighlightRoot(id: string) {
  return (element: HTMLElement | null) => {
    if (!element || !supported()) return;
    if (!highlights) {
      highlights = { block: new Highlight(), word: new Highlight(), hover: new Highlight() };
      // Thread find paints over read aloud where they overlap.
      highlights.block.priority = -2;
      highlights.word.priority = -1;
      CSS.highlights.set(BLOCK_HIGHLIGHT, highlights.block);
      CSS.highlights.set(WORD_HIGHLIGHT, highlights.word);
      CSS.highlights.set(HOVER_HIGHLIGHT, highlights.hover);
      readAloudController.subscribeHighlight(paint);
    }
    roots.set(id, element);
    paint();
    return () => {
      if (roots.get(id) === element) roots.delete(id);
    };
  };
}

function paint() {
  if (!highlights) return;
  const highlight = readAloudController.getHighlight();
  highlights.block.clear();
  highlights.word.clear();
  if (!highlight) {
    readingId = null;
    readingRange = null;
    highlights.hover.clear();
    watchScroller(null);
    measureAway();
    return;
  }
  if (highlight.id !== readingId) {
    readingId = highlight.id;
    userScrolledAt = null;
  }
  const root = roots.get(highlight.id);
  const block = root?.isConnected ? blockElement(root, highlight.block) : null;
  if (!block) {
    readingRange = null;
    return measureAway();
  }
  const text = spokenText(block);
  const first = locate(text, highlight.block.first);
  const last = locate(text, highlight.block.last);
  const word = highlight.word.cue && locate(text, highlight.word.cue);
  const blockRange =
    first && last && first.start < last.end ? range(text, first.start, last.end) : null;
  if (blockRange) highlights.block.add(blockRange);
  else {
    const whole = document.createRange();
    whole.selectNodeContents(block);
    highlights.block.add(whole);
  }
  const wordRange = word ? range(text, word.start, word.end) : null;
  if (wordRange) highlights.word.add(wordRange);
  watchScroller(block.closest<HTMLElement>(".messages-timeline-scroll"));
  readingRange = wordRange ?? blockRange;
  follow(readingRange);
  measureAway();
}

/** The element that renders the block: by its markdown range, else by its text. */
function blockElement(root: HTMLElement, block: ReadAloudHighlight["block"]) {
  let best: { element: HTMLElement; start: number } | null = null;
  for (const element of root.querySelectorAll<HTMLElement>("[data-speech-start]")) {
    const start = Number(element.dataset.speechStart);
    const end = Number(element.dataset.speechEnd);
    // Document order puts descendants after ancestors, so a tie goes to the inner one.
    if (start <= block.start && end >= block.end && (!best || start >= best.start))
      best = { element, start };
  }
  return best ? best.element : blockElementByText(root, block);
}

/**
 * Words writes source positions only on list items, so paragraphs, headings and table rows
 * carry no range. Take the first innermost block whose text holds the block's first and last words.
 */
function blockElementByText(root: HTMLElement, block: ReadAloudHighlight["block"]) {
  const candidates = [...root.querySelectorAll<HTMLElement>(SPEECH_BLOCK_SELECTOR)]
    .filter((element) => !element.querySelector(SPEECH_BLOCK_SELECTOR))
    .map((element) => ({ element, text: spokenText(element) }));
  for (const { element, text } of candidates) {
    const first = locate(text, block.first);
    const last = locate(text, block.last);
    if (first && last && first.start <= last.start) return element;
  }
  // A chip, footnote mark, or rendered formula can show an end word differently from how it is
  // spoken; the block still starts or ends with the other one.
  const edge = (text: string) => text.trim().replace(/[^\p{L}\p{N}]+$/u, "");
  return (
    candidates.find(({ text }) => text.value.trimStart().startsWith(block.first.text))?.element ??
    candidates.find(({ text }) => edge(text.value).endsWith(edge(block.last.text)))?.element ??
    null
  );
}

/**
 * The markdown offset where reading from a point in message `id`'s rendered markdown starts, such
 * as a clicked block or the start of a selection, or null when the point maps to no spoken word.
 * A block's own source range wins; Words leaves most blocks without one, so their words are matched
 * to the reply's instead.
 */
export function readAloudSourceAt(id: string, markdown: string, node: Node, offset: number) {
  const root = roots.get(id);
  if (!root?.isConnected || !root.contains(node)) return null;
  const element = node instanceof Element ? node : node.parentElement;
  const block = element?.closest<HTMLElement>(SPEECH_BLOCK_SELECTOR);
  const start = block && root.contains(block) ? block.dataset.speechStart : undefined;
  if (start !== undefined) return Number(start);
  const text = spokenText(root);
  const at = textOffset(text, node, offset);
  return at === null ? null : readAloudSourceAtShown(markdown, text.value, at);
}

/** The word under a pointer in message `id` while it is read aloud, as a DOM range. */
function wordAtPoint(id: string, event: MouseEvent) {
  const target = event.target;
  if (
    !readAloudController.isReading(id) ||
    !(target instanceof Element) ||
    target.closest(INTERACTIVE_SELECTOR) ||
    target.closest(UNSPOKEN_SELECTOR)
  )
    return null;
  const caret = caretAt(event.clientX, event.clientY);
  const root = roots.get(id);
  if (!caret || !(caret.node instanceof Text) || !root?.contains(caret.node)) return null;
  const { start, end } = spokenWordAt(caret.node.data, caret.offset);
  if (start === end) return null;
  const word = document.createRange();
  word.setStart(caret.node, start);
  word.setEnd(caret.node, end);
  // A caret lands on the nearest word even past the end of a line; only the word itself counts.
  const box = word.getBoundingClientRect();
  return event.clientX >= box.left &&
    event.clientX <= box.right &&
    event.clientY >= box.top &&
    event.clientY <= box.bottom
    ? word
    : null;
}

function caretAt(x: number, y: number) {
  if ("caretPositionFromPoint" in document) {
    const position = document.caretPositionFromPoint(x, y);
    return position && { node: position.offsetNode, offset: position.offset };
  }
  const legacy = (
    document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null }
  ).caretRangeFromPoint?.(x, y);
  return legacy ? { node: legacy.startContainer, offset: legacy.startOffset } : null;
}

/** While message `id` is read aloud, marks the word under the pointer as one a click reads from. */
export function hoverReadAloudWord(id: string, event: MouseEvent) {
  if (!highlights) return;
  const word = wordAtPoint(id, event);
  highlights.hover.clear();
  if (word) highlights.hover.add(word);
  hoveredAt = word ? performance.now() : null;
  const root = roots.get(id);
  if (root) root.style.cursor = word ? "pointer" : "";
}

export function clearReadAloudHover(id: string) {
  highlights?.hover.clear();
  hoveredAt = null;
  const root = roots.get(id);
  if (root) root.style.cursor = "";
}

/**
 * While message `id` is read aloud, a plain click on one of its words reads from that word.
 * Clicks that select text, follow links, or use controls and code blocks keep their behavior.
 */
export function jumpReadAloudOnClick(id: string, markdown: string, event: MouseEvent) {
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.detail > 1 ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey ||
    !readAloudController.isReading(id) ||
    window.getSelection()?.isCollapsed === false
  )
    return null;
  const target = event.target;
  if (!(target instanceof Element) || target.closest(INTERACTIVE_SELECTOR)) return null;
  const word = wordAtPoint(id, event);
  if (word) {
    const from = readAloudSourceAt(id, markdown, word.startContainer, word.startOffset);
    if (from !== null) return readAloudController.seek(id, from);
  }
  const block = target.closest<HTMLElement>(SPEECH_BLOCK_SELECTOR);
  const from = block ? readAloudSourceAt(id, markdown, block, 0) : null;
  return from === null ? null : readAloudController.jump(id, from);
}

type SpokenText = {
  readonly value: string;
  readonly nodes: ReadonlyArray<{ readonly node: Text; readonly at: number }>;
};

function spokenText(block: HTMLElement): SpokenText {
  const nodes: Array<{ node: Text; at: number }> = [];
  let value = "";
  let previous: Element | null = null;
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!(node instanceof Text)) continue;
    const unspoken = node.parentElement?.closest(UNSPOKEN_SELECTOR);
    if (unspoken && block.contains(unspoken)) continue;
    // Table cells and blocks render apart but hold no whitespace between them, which would run
    // "Edit" and "edit" together into one word no spoken word matches.
    const container = node.parentElement?.closest(`td, th, ${SPEECH_BLOCK_SELECTOR}`) ?? null;
    if (container !== previous && value && !/\s$/.test(value)) value += "\n";
    previous = container;
    nodes.push({ node, at: value.length });
    value += node.data;
  }
  return { value, nodes };
}

/** The offset in `text` of a DOM point, or of the first spoken text after it. */
function textOffset(text: SpokenText, node: Node, offset: number) {
  const at = document.createRange();
  at.setStart(node, offset);
  for (const entry of text.nodes) {
    if (entry.node === node) return entry.at + Math.min(offset, entry.node.length);
    if (at.comparePoint(entry.node, 0) > 0) return entry.at;
  }
  return null;
}

/** The cue's place in the rendered text: its `occurrence`-th appearance, counted as the cue was. */
function locate(text: SpokenText, cue: ReadAloudCue) {
  let at = text.value.indexOf(cue.text);
  for (let seen = 0; at !== -1 && seen < cue.occurrence; seen++)
    at = text.value.indexOf(cue.text, at + cue.text.length);
  return at === -1 ? null : { start: at, end: at + cue.text.length };
}

function point(text: SpokenText, offset: number, end: boolean) {
  for (let index = text.nodes.length - 1; index >= 0; index--) {
    const entry = text.nodes[index];
    if (entry && (entry.at < offset || (!end && entry.at === offset)))
      return { node: entry.node, offset: Math.min(offset - entry.at, entry.node.length) };
  }
  return null;
}

function range(text: SpokenText, start: number, end: number) {
  const from = point(text, start, false);
  const to = point(text, end, true);
  if (!from || !to) return null;
  const result = document.createRange();
  result.setStart(from.node, from.offset);
  result.setEnd(to.node, to.offset);
  return result;
}

function follow(target: Range | null, force = false) {
  if (!target || !scroller) return;
  if (!force && hoveredAt !== null && performance.now() - hoveredAt < HOVER_HOLD_MS) return;
  const rect = target.getClientRects()[0] ?? target.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return;
  const view = scroller.getBoundingClientRect();
  if (userScrolledAt !== null && !force) {
    if (performance.now() - userScrolledAt < FOLLOW_PAUSE_MS) return;
    // Never pull the user back; follow again once they bring the word into view themselves.
    if (rect.bottom < view.top || rect.top > view.bottom) return;
    userScrolledAt = null;
  }
  if (
    rect.top >= view.top + view.height * FOLLOW_BAND.top &&
    rect.bottom <= view.top + view.height * FOLLOW_BAND.bottom
  )
    return;
  scroller.scrollBy({
    top: rect.top - (view.top + view.height * FOLLOW_BAND.target),
    behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
  });
}

// The text moved under the pointer, so the hovered word may no longer be the one under it.
const onScroll = () => {
  highlights?.hover.clear();
  measureAway();
};
const markUserScroll = () => {
  userScrolledAt = performance.now();
};
const markScrollKey = (event: KeyboardEvent) => {
  if (SCROLL_KEYS.has(event.key)) markUserScroll();
};
// Dragging the scrollbar targets the scroll element itself.
const markScrollbarDrag = (event: PointerEvent) => {
  if (event.target === scroller) markUserScroll();
};

function watchScroller(next: HTMLElement | null) {
  if (next === scroller) return;
  scroller?.removeEventListener("wheel", markUserScroll);
  scroller?.removeEventListener("touchmove", markUserScroll);
  scroller?.removeEventListener("keydown", markScrollKey);
  scroller?.removeEventListener("pointerdown", markScrollbarDrag);
  scroller?.removeEventListener("scroll", onScroll);
  scroller = next;
  next?.addEventListener("scroll", onScroll, { passive: true });
  next?.addEventListener("wheel", markUserScroll, { passive: true });
  next?.addEventListener("touchmove", markUserScroll, { passive: true });
  next?.addEventListener("keydown", markScrollKey);
  next?.addEventListener("pointerdown", markScrollbarDrag);
}
