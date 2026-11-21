import { type ComponentProps, useLayoutEffect, useRef } from "react";

import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";

export function MiddleTruncate({
  value,
  tail,
  showTitle = true,
  variant = "default",
  className,
  ...props
}: Omit<ComponentProps<"span">, "children"> & {
  value: string;
  tail?: number;
  showTitle?: boolean;
  variant?: "default" | "cap-aligned";
}) {
  const raw = splitForMiddleTruncate(value, tail);
  const split = raw && collapseSegments(raw);
  const headRef = useRef<HTMLSpanElement>(null);
  const head = split?.head;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- fits the head span's DOM text and refits it through a ResizeObserver
  useLayoutEffect(() => {
    const element = headRef.current;
    // A new head can keep the same box size, so refit here, not only on resize.
    if (!element || head === undefined) return;
    scheduleFit(element);
    return observeResize(element, () => scheduleFit(element));
  }, [head]);
  return (
    <span
      dir="auto"
      {...(showTitle ? { title: value } : {})}
      className={cn(
        "inline-flex min-w-0 max-w-full overflow-hidden whitespace-nowrap",
        variant === "cap-aligned" &&
          // Padding keeps descenders inside the box, so the cut does not clip them.
          "overflow-x-clip overflow-y-visible [&>span]:[text-box:trim-both_cap_alphabetic] [&>span]:-mb-1 [&>span]:pb-1 [&>span]:overflow-x-clip [&>span]:overflow-y-visible",
        className,
      )}
      {...props}
    >
      {split ? (
        <>
          {/* The tail carries the ellipsis so it sits flush; a CSS ellipsis leaves a ragged gap. */}
          <span ref={headRef} className="peer min-w-0 overflow-hidden whitespace-pre">
            {split.head}
          </span>
          <span className="shrink-0 whitespace-pre peer-data-overflow:before:content-['…']">
            {split.tail}
          </span>
        </>
      ) : (
        // Keyed so React does not reuse the head node and its imperative clip.
        <span key="whole" className="min-w-0 truncate">
          {value}
        </span>
      )}
    </span>
  );
}

// Fitting heads one by one forces a layout per row, since each read follows the previous
// head's write. Heads queued in one commit or resize delivery fit together in a microtask,
// still before paint: all reads, then all writes.
const pendingFits = new Set<HTMLElement>();

function scheduleFit(head: HTMLElement) {
  if (pendingFits.size === 0) queueMicrotask(fitPendingHeads);
  pendingFits.add(head);
}

// An overflowing head is cut after its last whole character: clip the partial glyph
// and slide the tail over the slack. Neither changes layout, so the observed
// size stays the true available width.
function fitPendingHeads() {
  const heads = [...pendingFits].filter((head) => head.isConnected);
  pendingFits.clear();
  const overflowing = heads.map(
    (head) => head.scrollWidth > head.clientWidth && head.firstChild instanceof Text,
  );
  heads.forEach((head, index) => head.toggleAttribute("data-overflow", overflowing[index]));
  const slacks = heads.map((head, index) => {
    if (!overflowing[index]) return 0;
    const slack = measureSlack(head);
    return head.matches(":dir(rtl)") ? -slack : slack;
  });
  heads.forEach((head, index) => {
    const slack = slacks[index]!;
    head.style.clipPath = slack
      ? `inset(-0.25em ${Math.max(slack, 0)}px -0.25em ${Math.max(-slack, 0)}px)`
      : "";
    const tail = head.nextElementSibling;
    if (tail instanceof HTMLElement) tail.style.translate = slack ? `${-slack}px 0` : "";
  });
}

function measureSlack(head: HTMLElement) {
  const text = head.firstChild as Text;
  const range = document.createRange();
  const width = head.clientWidth;
  const widthTo = (end: number) => {
    range.setStart(text, 0);
    range.setEnd(text, end);
    return range.getBoundingClientRect().width;
  };
  let fits = 0;
  let over = text.length;
  while (over - fits > 1) {
    const mid = (fits + over) >> 1;
    if (widthTo(mid) <= width) fits = mid;
    else over = mid;
  }
  if (/[\uD800-\uDBFF]/.test(text.data[fits - 1] ?? "")) fits -= 1;
  return Math.max(0, width - widthTo(fits));
}

// The segments render pre so the space at the cut survives, so collapse here what CSS
// would have (not \s: em and no-break spaces are kept). Split first, so the tail length
// still counts the raw value.
function collapseSegments(split: { head: string; tail: string }) {
  const collapse = (text: string) => text.replace(/[ \t\n\r\f]+/g, " ");
  const head = collapse(split.head).replace(/^ /, "");
  const tail = collapse(split.tail).replace(/ $/, "");
  return { head, tail: head.endsWith(" ") ? tail.replace(/^ /, "") : tail };
}

const DEFAULT_TAIL = 10;
const MAX_SEGMENT_TAIL = 16;
const MIN_WORD_TAIL = 4;
const WORD_BREAK = /[-_./]/;

export function splitForMiddleTruncate(
  value: string,
  tail?: number,
): { head: string; tail: string } | null {
  // Split by code point to avoid cutting surrogate pairs into broken glyphs.
  const chars = Array.from(value);
  let keep = tail ?? DEFAULT_TAIL;
  if (tail === undefined) {
    const slash = chars.lastIndexOf("/");
    if (slash > 0 && slash < chars.length - 1) {
      const segment = chars.length - slash - 1;
      keep = segment <= MAX_SEGMENT_TAIL ? segment : DEFAULT_TAIL;
    }
  }
  if (keep <= 0 || chars.length <= keep + 4) return null;
  let cut = chars.length - keep;
  // Start an automatic tail on a word ("machine", not "er-machine"). A shorter tail is
  // preferred so the head stays readable; a longer one is the fallback.
  if (tail === undefined && !WORD_BREAK.test(chars[cut - 1]!)) {
    const startsWord = (index: number) => WORD_BREAK.test(chars[index - 1]!);
    let snapped = -1;
    for (let index = cut + 1; index <= chars.length - MIN_WORD_TAIL; index++) {
      if (startsWord(index)) {
        snapped = index;
        break;
      }
    }
    for (
      let index = cut - 1;
      snapped < 0 && index >= chars.length - MAX_SEGMENT_TAIL && index > 4;
      index--
    ) {
      if (startsWord(index)) snapped = index;
    }
    if (snapped > 0) cut = snapped;
  }
  return { head: chars.slice(0, cut).join(""), tail: chars.slice(cut).join("") };
}
