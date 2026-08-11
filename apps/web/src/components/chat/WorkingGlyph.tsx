import { cn } from "~/lib/utils";

/**
 * The "an agent is running" mark.
 *
 * It replaces three grey dots doing `animate-status-pulse` -- the same generic
 * blink every live indicator in the app uses, which said "something somewhere
 * is happening" rather than "your agent is thinking right now". This is the one
 * moment the user is actually waiting on the app, so it is worth a mark of its
 * own.
 *
 * The three dots survive, but they now ride a ring and carry descending
 * opacity, so they read as a comet with a tail. The ring does not spin
 * smoothly: it steps 120 degrees at a time on a spring, like a clock
 * escapement, and holds still between beats. Because the dots sit 120 degrees
 * apart, each step lands the bright head exactly where the next dot was, so the
 * tail chases itself around the circle. The core pulses on the same beat.
 *
 * The step is not a stylistic tic -- it is the same duty-cycle argument the
 * keyframes in motion.css are built on. A constant spin updates the compositor
 * every vsync forever; this moves for roughly a third of each beat and is
 * static the rest of the time. And unlike the indicators that ramp in `steps()`
 * because dozens of them are resident at once, exactly one of these exists and
 * only while a run is in flight, so its motion can afford to be smooth while it
 * lasts.
 */
export function WorkingGlyph({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden
      className={cn("working-glyph size-4 shrink-0 text-primary", className)}
      fill="currentColor"
      focusable="false"
      viewBox="0 0 16 16"
    >
      <circle className="working-glyph-core" cx="8" cy="8" r="1" />
      <g className="working-glyph-ring">
        {/* 120 degrees apart, brightest first: the opacity ramp is the tail. */}
        <circle cx="8" cy="2.6" r="1.3" />
        <circle cx="12.68" cy="10.7" opacity="0.55" r="1.3" />
        <circle cx="3.32" cy="10.7" opacity="0.28" r="1.3" />
      </g>
    </svg>
  );
}
