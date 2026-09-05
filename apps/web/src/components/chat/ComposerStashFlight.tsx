import { ArchiveIcon } from "lucide-react";
import { useLayoutEffect, useRef, type RefObject } from "react";
import { createPortal } from "react-dom";
import { composerStashKeyframes } from "../../composerStashMotion";

export interface StashFlight {
  key: number;
  target: string;
  text: string;
  x: number;
  y: number;
  width: number;
}

/** A visual copy moves only after persistence succeeds; it never owns draft data. */
export function ComposerStashFlight(props: {
  flight: StashFlight;
  destinationRef: RefObject<HTMLButtonElement | null>;
  onDone: () => void;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const { flight, destinationRef, onDone } = props;

  useLayoutEffect(() => {
    const card = cardRef.current;
    const destination = destinationRef.current;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (!card || !destination || reducedMotion.matches) {
      onDone();
      return;
    }
    const rect = destination.getBoundingClientRect();
    const dx = rect.x + rect.width / 2 - flight.x - flight.width / 2;
    const dy = rect.y + rect.height / 2 - flight.y - card.offsetHeight / 2;
    const angle = Math.atan2(dy, dx) + Math.PI / 2;
    const animation = card.animate(
      composerStashKeyframes(0, -Math.hypot(dx, dy)).map((frame) => {
        const arrival = Math.max(0, (frame.offset - 0.7) / 0.3);
        return {
          ...frame,
          transform: `rotate(${angle}rad) ${frame.transform} rotate(${-angle}rad) scale(${1 - arrival * 0.96})`,
          opacity: 1 - arrival,
        };
      }),
      { duration: 550, easing: "cubic-bezier(.32,0,.18,1)", fill: "forwards" },
    );
    animation.onfinish = onDone;
    const cancel = () => onDone();
    reducedMotion.addEventListener("change", cancel);
    window.addEventListener("resize", cancel);
    return () => {
      animation.onfinish = null;
      animation.cancel();
      reducedMotion.removeEventListener("change", cancel);
      window.removeEventListener("resize", cancel);
    };
  }, [flight, destinationRef, onDone]);

  return createPortal(
    <div
      ref={cardRef}
      aria-hidden="true"
      data-stash-flight="true"
      className="pointer-events-none fixed z-[100] rounded-xl border border-primary/25 bg-popover px-4 py-3 text-sm text-popover-foreground shadow-lg motion-reduce:hidden"
      style={{ left: flight.x, top: flight.y, width: flight.width }}
    >
      <div className="mb-1 flex items-center gap-1.5 text-[11px] text-primary">
        <ArchiveIcon className="size-3" /> Moving to Stash
      </div>
      <div className="line-clamp-2 break-words">{flight.text}</div>
    </div>,
    document.body,
  );
}
