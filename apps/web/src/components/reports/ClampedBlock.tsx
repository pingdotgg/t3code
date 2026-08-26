/**
 * Content the reader may want in full, held to a fixed number of lines until
 * they ask for it.
 *
 * Triage deals the same object thirty times, so a report whose agent wrote
 * four paragraphs of justification must not arrive as a card twice the height
 * of the last one. Nothing is cut: the control below reveals the rest in
 * place, and the report's own page always has it whole.
 */
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { cn } from "../../lib/utils";

export function ClampedBlock({
  lines,
  className,
  expandLabel = "Show more",
  collapseLabel = "Show less",
  children,
}: {
  readonly lines: number;
  readonly className?: string;
  readonly expandLabel?: string;
  readonly collapseLabel?: string;
  readonly children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const clipRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);

  // Measured rather than guessed from string length: the same sentence fits
  // at one card width and not at another, and a "Show more" that reveals
  // nothing is worse than no control at all.
  //
  // Only measured while collapsed — expanded, the element is exactly as tall
  // as its content and would report itself as having nothing left to show.
  // Watching the content rather than the clip is what catches text that
  // reflows or arrives without the block being remounted.
  useLayoutEffect(() => {
    const clip = clipRef.current;
    const content = contentRef.current;
    if (clip === null || content === null || expanded) return;
    const measure = () => setOverflows(clip.scrollHeight - clip.clientHeight > 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    return () => observer.disconnect();
  }, [expanded]);

  return (
    <div className={cn("min-w-0", className)}>
      <div
        ref={clipRef}
        // `1lh` is the element's own line height, so the clamp lands on a line
        // boundary at any type size the card uses.
        style={expanded ? undefined : { maxHeight: `calc(${lines} * 1lh)` }}
        className={cn(
          "overflow-hidden",
          // Fades the clipped line out instead of guillotining it, which is
          // what tells the reader there is more without a second affordance.
          !expanded &&
            overflows &&
            "[mask-image:linear-gradient(to_bottom,black_calc(100%-1.1lh),transparent)]",
        )}
      >
        <div ref={contentRef}>{children}</div>
      </div>
      {overflows ? (
        <button
          type="button"
          className="mt-1 cursor-pointer rounded-sm text-xs font-medium text-foreground/70 underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? collapseLabel : expandLabel}
        </button>
      ) : null}
    </div>
  );
}
