import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type PointerEventHandler,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  createRope,
  createSnapDetector,
  handSpeed,
  type Rope,
  ROPE_NODES,
  ropeTop,
  SEGMENT_LENGTH,
  stepRope,
  tipSpeed,
} from "./whipRope";

const HANDLE_NODES = 2;
/**
 * After a crack the whip is deaf for this long, so the natural return stroke
 * of a flick does not crack again. Two deliberate flicks further apart both
 * do.
 */
const CRACK_REFRACTORY_MS = 600;
/** Picking the whip up is not a crack: detection arms after this. */
const ARM_DELAY_MS = 150;
const DRAG_THRESHOLD_PX = 6;
const STEP_MS = 1000 / 60;
const MAX_STEPS_PER_FRAME = 4;
/** Below this per-step movement on every node the rope counts as still. */
const IDLE_SPEED = 0.05;
/** Consecutive still frames before the loop sleeps until the pointer moves. */
const IDLE_FRAMES = 20;
/** A dropped whip that has not left the screen by then is removed anyway. */
const FALL_TIMEOUT_MS = 2000;
const FALL_FADE_MS = 900;

const HANDLE_COLOR = "#3b2416";
const KNOB_COLOR = "#2a1a10";
const RING_COLOR = "#b08d57";
const LASH_COLOR_START = [0x6b, 0x3f, 0x1d] as const;
const LASH_COLOR_END = [0xc4, 0x8a, 0x4a] as const;
const POPPER_COLOR = "#e8dcc8";
const SPARK_COLOR = "#ffb347";
/** Spark for a crack whose order stayed within the cooldown: just sound. */
const SPARK_DUD_COLOR = "#a8a29e";

// Holster icon: the whip at rest, before the user picks it up.
const HOLSTER_LASH = "M7 17 C9 11 13 10 15 13 C17 16 21 16 22 10";
const HOLSTER_POPPER = "M20.4 14.6 C21.4 14 22 12.4 22 10";

const WHIP_HELP = "Grab and flick to crack the whip at a stuck agent. Orange spark: order sent.";

/**
 * One rope segment as a leather strand: the handle is thick and dark, the
 * lash tapers and lightens toward the tip, and the last segment is the pale
 * popper that does the cracking. Precomputed once; only positions move.
 */
const SEGMENTS = Array.from({ length: ROPE_NODES - 1 }, (_, index) => {
  if (index < HANDLE_NODES) {
    return { id: `handle-${index}`, color: HANDLE_COLOR, width: 9 };
  }
  if (index === ROPE_NODES - 2) {
    return { id: "popper", color: POPPER_COLOR, width: 1.2 };
  }
  const progress = (index - HANDLE_NODES) / (ROPE_NODES - 2 - HANDLE_NODES);
  const channel = (start: number, end: number) => Math.round(start + (end - start) * progress);
  return {
    id: `lash-${index}`,
    color: `rgb(${channel(LASH_COLOR_START[0], LASH_COLOR_END[0])} ${channel(LASH_COLOR_START[1], LASH_COLOR_END[1])} ${channel(LASH_COLOR_START[2], LASH_COLOR_END[2])})`,
    width: 4.8 - 3.5 * progress,
  };
});

const prefersReducedMotion = () =>
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

/** Largest per-step movement across the rope; zero once it hangs still. */
function ropeSpeed(rope: Rope): number {
  let fastest = 0;
  for (let index = 1; index < rope.x.length; index += 1) {
    fastest = Math.max(
      fastest,
      Math.abs(rope.x[index]! - rope.previousX[index]!),
      Math.abs(rope.y[index]! - rope.previousY[index]!),
    );
  }
  return fastest;
}

interface WhipButtonProps {
  disabled: boolean;
  /** Cracks the whip at the agent; true when the order actually went out. */
  onWhip: () => boolean;
  onPointerDown?: PointerEventHandler<HTMLElement> | undefined;
}

/**
 * The whip the user cracks at a running agent. Press and drag to pick it up:
 * a rope follows the pointer and every fast flick that snaps the tip cracks
 * it, with a spark at the tip: orange when the order went out, grey when it
 * only made noise because the parent is still within its cooldown. Picking
 * it up or clicking it sends nothing; letting go drops it and it falls off
 * the screen. Keyboard activation, and a plain click when the user prefers
 * reduced motion, crack it in the holster.
 */
export const WhipButton = memo(function WhipButton({
  disabled,
  onWhip,
  onPointerDown,
}: WhipButtonProps) {
  // The rope is on screen while active: in hand, or falling after let go.
  const [active, setActive] = useState(false);
  const [held, setHeld] = useState(false);

  const ropeRef = useRef<Rope | null>(null);
  const pointerRef = useRef({ x: 0, y: 0, startX: 0, startY: 0, dragged: false });
  const fallStartedAtRef = useRef<number | null>(null);
  const wakeRef = useRef(() => {});
  const overlayRef = useRef<SVGSVGElement | null>(null);
  const holsterRef = useRef<SVGSVGElement | null>(null);
  const segmentRefs = useRef<Array<SVGLineElement | null>>([]);
  const knobRef = useRef<SVGCircleElement | null>(null);
  const ringRef = useRef<SVGCircleElement | null>(null);
  const sparkRef = useRef<SVGCircleElement | null>(null);

  const crackInHolster = useCallback(() => {
    const sent = onWhip();
    if (prefersReducedMotion()) return;
    const swing = sent ? 14 : 5;
    holsterRef.current?.animate(
      [
        { transform: "rotate(0deg)" },
        { transform: `rotate(${-swing}deg)` },
        { transform: `rotate(${swing / 2}deg)` },
        { transform: "rotate(0deg)" },
      ],
      { duration: 300, easing: "ease-out" },
    );
  }, [onWhip]);

  const crackAtTip = useCallback(
    (rope: Rope) => {
      const sent = onWhip();
      const spark = sparkRef.current;
      if (!spark) return;
      const tip = ROPE_NODES - 1;
      spark.setAttribute("cx", rope.x[tip]!.toFixed(1));
      spark.setAttribute("cy", rope.y[tip]!.toFixed(1));
      spark.setAttribute("fill", sent ? SPARK_COLOR : SPARK_DUD_COLOR);
      spark.animate(
        [
          { transform: "scale(0.15)", opacity: 1 },
          { transform: `scale(${sent ? 2 : 1.15})`, opacity: 0.9 },
          { transform: "scale(0.3)", opacity: 0 },
        ],
        { duration: 300, easing: "ease-out" },
      );
    },
    [onWhip],
  );

  // The rope only runs while on screen: one rAF loop per pick-up, cancelled
  // when the dropped rope is gone or on unmount. Fixed 60Hz steps keep the
  // feel the same on 120Hz displays, and the loop sleeps once a held rope
  // hangs still until the pointer moves again, so a whip held idle repaints
  // nothing. The rope and pointer are read from their refs each frame so
  // picking the whip up again mid-fall swaps in the new rope and hand without
  // restarting the loop.
  useEffect(() => {
    if (!active) return;
    const pickedUpAt = performance.now();
    const snapped = createSnapDetector();
    let last = pickedUpAt;
    let accumulator = 0;
    let lastCrackAt = -Infinity;
    let stillFrames = 0;
    let frameId = 0;
    function frame(now: number) {
      const rope = ropeRef.current;
      const pointer = pointerRef.current;
      if (!rope) {
        frameId = 0;
        return;
      }
      const fallStartedAt = fallStartedAtRef.current;
      accumulator += Math.min(now - last, STEP_MS * MAX_STEPS_PER_FRAME);
      last = now;
      let stepped = false;
      let cracked = false;
      while (accumulator >= STEP_MS) {
        stepRope(rope, fallStartedAt === null ? pointer : null);
        accumulator -= STEP_MS;
        stepped = true;
        if (snapped(tipSpeed(rope), handSpeed(rope))) cracked = true;
      }
      if (
        fallStartedAt !== null &&
        (ropeTop(rope) > window.innerHeight + 60 || now - fallStartedAt > FALL_TIMEOUT_MS)
      ) {
        ropeRef.current = null;
        fallStartedAtRef.current = null;
        setActive(false);
        frameId = 0;
        return;
      }
      if (stepped) {
        for (let index = 0; index < ROPE_NODES - 1; index += 1) {
          const line = segmentRefs.current[index];
          if (!line) continue;
          line.setAttribute("x1", rope.x[index]!.toFixed(1));
          line.setAttribute("y1", rope.y[index]!.toFixed(1));
          line.setAttribute("x2", rope.x[index + 1]!.toFixed(1));
          line.setAttribute("y2", rope.y[index + 1]!.toFixed(1));
        }
        knobRef.current?.setAttribute("cx", rope.x[0]!.toFixed(1));
        knobRef.current?.setAttribute("cy", rope.y[0]!.toFixed(1));
        ringRef.current?.setAttribute("cx", rope.x[HANDLE_NODES]!.toFixed(1));
        ringRef.current?.setAttribute("cy", rope.y[HANDLE_NODES]!.toFixed(1));
        stillFrames = fallStartedAt === null && ropeSpeed(rope) < IDLE_SPEED ? stillFrames + 1 : 0;
      }
      if (
        cracked &&
        fallStartedAt === null &&
        pointer.dragged &&
        now - pickedUpAt > ARM_DELAY_MS &&
        now - lastCrackAt > CRACK_REFRACTORY_MS
      ) {
        lastCrackAt = now;
        crackAtTip(rope);
      }
      if (stillFrames >= IDLE_FRAMES) {
        frameId = 0;
        return;
      }
      frameId = requestAnimationFrame(frame);
    }
    wakeRef.current = () => {
      if (frameId !== 0) return;
      stillFrames = 0;
      last = performance.now();
      frameId = requestAnimationFrame(frame);
    };
    frameId = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(frameId);
      wakeRef.current = () => {};
    };
  }, [active, crackAtTip]);

  const pickUp = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      onPointerDown?.(event);
      if (disabled || event.button !== 0) return;
      if (prefersReducedMotion()) return;
      // Capture keeps the drag alive outside the button. A pointer that is
      // already gone (or a synthetic event) cannot be captured; the rope still
      // follows whatever moves reach the button.
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // No capture: see above.
      }
      const rect = event.currentTarget.getBoundingClientRect();
      ropeRef.current = createRope(
        ROPE_NODES,
        SEGMENT_LENGTH,
        rect.left + rect.width / 2,
        rect.top + rect.height / 2,
      );
      pointerRef.current = {
        x: event.clientX,
        y: event.clientY,
        startX: event.clientX,
        startY: event.clientY,
        dragged: false,
      };
      // Grabbing a falling whip cancels its fade and swaps in the new rope.
      fallStartedAtRef.current = null;
      overlayRef.current?.getAnimations().forEach((animation) => animation.cancel());
      setHeld(true);
      setActive(true);
      wakeRef.current();
    },
    [disabled, onPointerDown],
  );

  const move = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!ropeRef.current || fallStartedAtRef.current !== null) return;
    const pointer = pointerRef.current;
    pointer.x = event.clientX;
    pointer.y = event.clientY;
    if (
      !pointer.dragged &&
      Math.hypot(event.clientX - pointer.startX, event.clientY - pointer.startY) > DRAG_THRESHOLD_PX
    ) {
      pointer.dragged = true;
    }
    wakeRef.current();
  }, []);

  // Letting go does not remove the rope: it falls with the hand's last
  // velocity, fades, and unmounts once it is off the screen.
  const putDown = useCallback(() => {
    if (!ropeRef.current || fallStartedAtRef.current !== null) return;
    fallStartedAtRef.current = performance.now();
    setHeld(false);
    overlayRef.current?.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration: FALL_FADE_MS,
      delay: 250,
      easing: "ease-in",
      fill: "forwards",
    });
    wakeRef.current();
  }, []);

  // Pointer clicks never crack: grabbing the whip must not send anything, and
  // a drag already cracked (or not) through the rope. A keyboard activation
  // arrives as a click with detail 0 and cracks in the holster; so does any
  // click when there is no rope because the user prefers reduced motion.
  const onClick = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>) => {
      pointerRef.current.dragged = false;
      if (event.detail === 0 || prefersReducedMotion()) crackInHolster();
    },
    [crackInHolster],
  );

  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="icon-sm"
              variant="outline"
              className="cursor-grab touch-none rounded-full select-none active:cursor-grabbing"
              disabled={disabled}
              aria-label="Whip"
              onPointerDown={pickUp}
              onPointerMove={move}
              onPointerUp={putDown}
              onPointerCancel={putDown}
              onLostPointerCapture={putDown}
              onClick={onClick}
            />
          }
        >
          <svg
            ref={holsterRef}
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={cn("overflow-visible transition-opacity", held && "opacity-25")}
            aria-hidden="true"
          >
            <path d="M3.5 20.5 L7 17" stroke={HANDLE_COLOR} strokeWidth="3.4" />
            <circle cx="3.5" cy="20.5" r="1.8" fill={KNOB_COLOR} />
            <circle cx="7" cy="17" r="1.1" fill={RING_COLOR} />
            <path d={HOLSTER_LASH} stroke="#8a5a2b" strokeWidth="1.8" />
            <path d={HOLSTER_POPPER} stroke={POPPER_COLOR} strokeWidth="1" />
          </svg>
        </TooltipTrigger>
        <TooltipPopup side="top" className="max-w-56">
          {WHIP_HELP}
        </TooltipPopup>
      </Tooltip>
      {active
        ? createPortal(
            <svg
              ref={overlayRef}
              // While held the overlay owns the cursor, so it stays a closed
              // hand wherever the drag goes; once dropped it must not block clicks.
              className={cn(
                "fixed inset-0 z-[9999] h-full w-full",
                held ? "cursor-grabbing" : "pointer-events-none",
              )}
              aria-hidden="true"
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <defs>
                {/* Filter region follows the rope's own box, not the viewport. */}
                <filter id="whip-shadow" x="-20%" y="-20%" width="140%" height="140%">
                  <feDropShadow dx="0" dy="2" stdDeviation="1.5" floodOpacity="0.35" />
                </filter>
              </defs>
              <g filter="url(#whip-shadow)">
                {SEGMENTS.map((segment, index) => (
                  <line
                    key={segment.id}
                    ref={(element) => {
                      segmentRefs.current[index] = element;
                    }}
                    stroke={segment.color}
                    strokeWidth={segment.width}
                  />
                ))}
                <circle ref={knobRef} r="7" fill={KNOB_COLOR} />
                <circle ref={ringRef} r="4" fill={RING_COLOR} />
              </g>
              <circle
                ref={sparkRef}
                r="10"
                opacity="0"
                fill={SPARK_COLOR}
                style={{ transformBox: "fill-box", transformOrigin: "center" }}
              />
            </svg>,
            document.body,
          )
        : null}
    </>
  );
});
