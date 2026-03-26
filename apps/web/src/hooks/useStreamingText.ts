import { useEffect, useRef, useState } from "react";

/** Fraction of the remaining backlog to reveal per animation frame (~ease-out). */
const BACKLOG_REVEAL_FRACTION = 0.35;
/** Minimum characters advanced per frame to guarantee forward progress. */
const MIN_CHARS_PER_FRAME = 2;
/** Snap forward to the next newline within this many chars to avoid mid-line markdown breaks. */
const NEWLINE_SNAP_LOOKAHEAD = 40;
/** Minimum milliseconds between React re-renders (limits markdown re-parsing cost). */
const RENDER_THROTTLE_MS = 32;

/**
 * Smoothly reveals streaming text by buffering incoming content and
 * advancing the visible portion incrementally via requestAnimationFrame.
 *
 * When `isStreaming` is false the full text is returned immediately.
 *
 * The revealed position is initialised to the current text length so that
 * on component (re-)mount (e.g. virtual-scroll recycle) all existing text
 * appears instantly — only characters arriving *after* mount are animated.
 *
 * To avoid flickering from partially-parsed markdown, the reveal position
 * snaps forward to the next newline boundary when one is within reach.
 */
export function useStreamingText(targetText: string, isStreaming: boolean): string {
  const revealedRef = useRef(targetText.length);
  const targetRef = useRef(targetText);
  // Counter to trigger React re-renders without holding the displayed text
  // string in state.
  const [, rerender] = useState(0);

  targetRef.current = targetText;

  // Snap to full text when streaming ends.
  useEffect(() => {
    if (!isStreaming) {
      revealedRef.current = targetText.length;
    }
  }, [isStreaming, targetText]);

  // RAF animation loop — runs only while streaming.
  useEffect(() => {
    if (!isStreaming) return;

    let rafId = 0;
    let active = true;
    let lastRenderTs = 0;

    const loop = (timestamp: number) => {
      if (!active) return;
      const target = targetRef.current;
      let current = revealedRef.current;

      // If the server replaced (rather than appended to) the text, clamp.
      if (current > target.length) {
        current = target.length;
        revealedRef.current = current;
      }

      if (current < target.length) {
        const backlog = target.length - current;
        let nextPos =
          current + Math.max(MIN_CHARS_PER_FRAME, Math.ceil(backlog * BACKLOG_REVEAL_FRACTION));
        nextPos = Math.min(nextPos, target.length);

        // Snap forward to the next newline if one is within reach to avoid
        // splitting a markdown line mid-syntax.
        const nextNewline = target.indexOf("\n", nextPos);
        if (nextNewline !== -1 && nextNewline - nextPos < NEWLINE_SNAP_LOOKAHEAD) {
          nextPos = nextNewline + 1;
        }

        revealedRef.current = Math.min(nextPos, target.length);

        // Throttle React re-renders to ~30fps to limit the cost of full
        // ReactMarkdown parses while keeping the visual flow smooth.
        const caughtUp = revealedRef.current >= target.length;
        if (caughtUp || timestamp - lastRenderTs >= RENDER_THROTTLE_MS) {
          lastRenderTs = timestamp;
          rerender((c) => c + 1);
        }
      }

      rafId = requestAnimationFrame(loop);
    };

    rafId = requestAnimationFrame(loop);

    return () => {
      active = false;
      cancelAnimationFrame(rafId);
    };
    // Only restart the loop when the streaming flag changes. Incoming text
    // updates are picked up via `targetRef` inside the loop.
  }, [isStreaming]);

  if (!isStreaming) return targetText;
  return targetText.slice(0, revealedRef.current);
}
