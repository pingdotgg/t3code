import { animate, arc } from "motion";
import { useEffect, useRef, type RefObject } from "react";
import { createPortal } from "react-dom";
import { COMPOSER_STASH_DURATION_MS } from "../../composerStashMotion";

export interface StashFlight {
  key: number;
  target: string;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface StashFlightGeometry {
  x: number;
  y: number;
  startTime: CSSNumberish | null;
}

/** A visual copy moves only after persistence succeeds; it never owns draft data. */
export function ComposerStashFlight(props: {
  flight: StashFlight;
  destinationRef: RefObject<HTMLButtonElement | null>;
  geometryRef: RefObject<StashFlightGeometry | null>;
  geometryListenerRef: RefObject<((geometry: StashFlightGeometry) => void) | null>;
  onDone: () => void;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const { flight, destinationRef, geometryRef, geometryListenerRef, onDone } = props;

  useEffect(() => {
    const card = cardRef.current;
    const destination = destinationRef.current;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (!card || !destination || reducedMotion.matches) {
      onDone();
      return;
    }
    let animation: ReturnType<typeof animate> | null = null;
    let appearance: ReturnType<typeof animate> | null = null;
    let cancelled = false;
    let generation = 0;
    let target: { x: number; y: number } | null = null;
    let path: ReturnType<typeof arc> | null = null;
    const moveTo = (geometry: StashFlightGeometry) => {
      if (cancelled || (target?.x === geometry.x && target.y === geometry.y)) return;
      const initial = target === null;
      target = geometry;
      const currentGeneration = ++generation;
      // stop() preserves the current visual position for Motion's interruption handling.
      animation?.stop();
      const dx = geometry.x - flight.x - flight.width / 2;
      const dy = geometry.y - flight.y - card.offsetHeight / 2;
      const distance = Math.hypot(dx, dy);
      path ??= arc({
        strength: distance === 0 ? 0 : Math.min(0.08, 8 / distance),
        direction: "cw",
        peak: 0.5,
        rotate: false,
      });
      const startTime =
        typeof geometry.startTime === "number"
          ? geometry.startTime
          : Number(document.timeline.currentTime);
      const remaining = Math.max(
        1,
        COMPOSER_STASH_DURATION_MS - (Number(document.timeline.currentTime) - startTime),
      );
      // Motion arc() / add-to-basket pattern: https://motion.dev/docs/arc
      // Reuse the path when the editor's later layout measurement updates the tab.
      animation = animate(
        card,
        { x: initial ? [0, dx] : dx, y: initial ? [0, dy] : dy },
        {
          duration: initial ? COMPOSER_STASH_DURATION_MS / 1000 : remaining / 1000,
          ...(initial ? { startTime } : {}),
          ease: [0.4, 0, 0.2, 1],
          path,
        },
      );
      if (initial) {
        appearance = animate(
          card,
          { scale: [1, 0.04], opacity: [1, 1, 0] },
          {
            duration: COMPOSER_STASH_DURATION_MS / 1000,
            startTime,
            opacity: {
              duration: COMPOSER_STASH_DURATION_MS / 1000,
              startTime,
              times: [0, 0.85, 1],
              ease: "linear",
            },
            ease: [0.4, 0, 0.2, 1],
          },
        );
      }
      void animation.then(() => {
        if (!cancelled && currentGeneration === generation) onDone();
      });
    };
    // Subscribe before starting: Lexical can finish clearing after the first
    // React layout. Every final-layout retarget keeps the original deadline.
    geometryListenerRef.current = moveTo;
    queueMicrotask(() => {
      if (cancelled) return;
      const rect = destination.getBoundingClientRect();
      moveTo(
        geometryRef.current ?? {
          x: rect.x + rect.width / 2,
          y: rect.y + rect.height / 2,
          startTime: document.timeline.currentTime,
        },
      );
    });
    const cancel = () => onDone();
    reducedMotion.addEventListener("change", cancel);
    window.addEventListener("resize", cancel);
    return () => {
      cancelled = true;
      geometryListenerRef.current = null;
      animation?.cancel();
      appearance?.cancel();
      reducedMotion.removeEventListener("change", cancel);
      window.removeEventListener("resize", cancel);
    };
  }, [flight, destinationRef, geometryRef, geometryListenerRef, onDone]);

  return createPortal(
    <div
      ref={cardRef}
      aria-hidden="true"
      data-stash-flight="true"
      className="pointer-events-none fixed z-[100] overflow-hidden whitespace-pre-wrap break-words rounded-md bg-popover text-sm leading-relaxed text-popover-foreground shadow-sm opacity-0 motion-reduce:hidden"
      style={{
        left: flight.x,
        top: flight.y,
        width: flight.width,
        height: flight.height,
      }}
    >
      {flight.text}
    </div>,
    document.body,
  );
}
