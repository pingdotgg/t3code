import type { ReadAloudHighlight } from "@t3tools/client-runtime/read-aloud";
import type { ReadAloudCue } from "@t3tools/shared/read-aloud";
import { readAloudController } from "./readAloud";

const BLOCK_HIGHLIGHT = "t3-read-aloud-block";
const WORD_HIGHLIGHT = "t3-read-aloud-word";
/** Text a listener never hears: controls, icons, labels the UI adds, and math markup. */
const UNSPOKEN_SELECTOR =
  "svg, button, [role=button], [data-thread-find-ignore], [aria-hidden=true], .katex";
/** After the user scrolls, following waits this long and for the word to be back in view. */
const FOLLOW_PAUSE_MS = 3_000;
/** The word stays in the middle of the timeline; leaving that band scrolls it to 40%. */
const FOLLOW_BAND = { top: 0.2, bottom: 0.8, target: 0.4 };
const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);

const roots = new Map<string, HTMLElement>();
let highlights: { readonly block: Highlight; readonly word: Highlight } | null = null;
let scroller: HTMLElement | null = null;
let userScrolledAt: number | null = null;
let readingId: string | null = null;

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
      highlights = { block: new Highlight(), word: new Highlight() };
      // Thread find paints over read aloud where they overlap.
      highlights.block.priority = -2;
      highlights.word.priority = -1;
      CSS.highlights.set(BLOCK_HIGHLIGHT, highlights.block);
      CSS.highlights.set(WORD_HIGHLIGHT, highlights.word);
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
    watchScroller(null);
    return;
  }
  if (highlight.id !== readingId) {
    readingId = highlight.id;
    userScrolledAt = null;
  }
  const root = roots.get(highlight.id);
  const block = root?.isConnected ? blockElement(root, highlight.block) : null;
  if (!block) return;
  const text = spokenText(block);
  const first = locate(text, highlight.block.first);
  const last = locate(text, highlight.block.last);
  const word = locate(text, highlight.word.cue);
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
  follow(wordRange ?? blockRange);
}

/** The innermost tagged element that holds the whole block. */
function blockElement(root: HTMLElement, block: ReadAloudHighlight["block"]) {
  let best: { element: HTMLElement; start: number } | null = null;
  for (const element of root.querySelectorAll<HTMLElement>("[data-speech-start]")) {
    const start = Number(element.dataset.speechStart);
    const end = Number(element.dataset.speechEnd);
    // Document order puts descendants after ancestors, so a tie goes to the inner one.
    if (start <= block.start && end >= block.end && (!best || start >= best.start))
      best = { element, start };
  }
  return best ? best.element : null;
}

type SpokenText = {
  readonly value: string;
  readonly nodes: ReadonlyArray<{ readonly node: Text; readonly at: number }>;
};

function spokenText(block: HTMLElement): SpokenText {
  const nodes: Array<{ node: Text; at: number }> = [];
  let value = "";
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!(node instanceof Text)) continue;
    const unspoken = node.parentElement?.closest(UNSPOKEN_SELECTOR);
    if (unspoken && block.contains(unspoken)) continue;
    nodes.push({ node, at: value.length });
    value += node.data;
  }
  return { value, nodes };
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
      return { node: entry.node, offset: offset - entry.at };
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

function follow(target: Range | null) {
  if (!target || !scroller) return;
  const rect = target.getClientRects()[0] ?? target.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return;
  const view = scroller.getBoundingClientRect();
  if (userScrolledAt !== null) {
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
  scroller = next;
  next?.addEventListener("wheel", markUserScroll, { passive: true });
  next?.addEventListener("touchmove", markUserScroll, { passive: true });
  next?.addEventListener("keydown", markScrollKey);
  next?.addEventListener("pointerdown", markScrollbarDrag);
}
