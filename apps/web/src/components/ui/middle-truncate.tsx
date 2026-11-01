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
  const split = splitForMiddleTruncate(value, tail);
  const headRef = useRef<HTMLSpanElement>(null);
  const head = split?.head;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- fits the head span's DOM text and refits it through a ResizeObserver
  useLayoutEffect(() => {
    const element = headRef.current;
    // A new head can keep the same box size, so refit here, not only on resize.
    if (!element || head === undefined) return;
    fitHead(element);
    return observeResize(element, () => fitHead(element));
  }, [head]);
  return (
    <span
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
          <span ref={headRef} className="peer min-w-0 overflow-hidden">
            {split.head}
          </span>
          <span className="shrink-0 peer-data-overflow:before:content-['…']">{split.tail}</span>
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

// An overflowing head is cut after its last whole character: clip the partial glyph
// and slide the tail left over the slack. Neither changes layout, so the observed
// size stays the true available width.

function fitHead(head: HTMLElement) {
  const text = head.firstChild;
  const overflowing = head.scrollWidth > head.clientWidth && text instanceof Text;
  head.toggleAttribute("data-overflow", overflowing);
  let slack = 0;
  if (overflowing) {
    const range = document.createRange();
    const left = head.getBoundingClientRect().left;
    const widthTo = (end: number) => {
      range.setStart(text, 0);
      range.setEnd(text, end);
      return range.getBoundingClientRect().right - left;
    };
    let fits = 0;
    let over = text.length;
    while (over - fits > 1) {
      const mid = (fits + over) >> 1;
      if (widthTo(mid) <= head.clientWidth) fits = mid;
      else over = mid;
    }
    if (/[\uD800-\uDBFF]/.test(text.data[fits - 1] ?? "")) fits -= 1;
    slack = Math.max(0, head.clientWidth - widthTo(fits));
  }
  head.style.clipPath = slack > 0 ? `inset(-0.25em ${slack}px -0.25em 0)` : "";
  const tail = head.nextElementSibling;
  if (tail instanceof HTMLElement) tail.style.translate = slack > 0 ? `-${slack}px 0` : "";
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
