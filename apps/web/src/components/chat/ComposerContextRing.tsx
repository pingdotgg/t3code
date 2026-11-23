import type { ContextWindowSnapshot } from "@t3tools/client-runtime/state/context-window";

const RING_RADIUS = 12;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/**
 * How full the thread's context window is, drawn as a ring inside the round send and stop buttons.
 * It takes the button's text colour and turns to the error colour past 90%.
 */
export function ComposerContextRing(props: { usage: ContextWindowSnapshot }) {
  if (props.usage.usedPercentage === null) return null;
  const used = Math.max(0, Math.min(100, props.usage.usedPercentage));
  return (
    <svg
      viewBox="0 0 32 32"
      className="pointer-events-none absolute inset-0 size-full -rotate-90"
      aria-hidden="true"
      data-composer-context-ring={Math.round(used)}
    >
      <circle
        cx="16"
        cy="16"
        r={RING_RADIUS}
        fill="none"
        stroke="currentColor"
        strokeOpacity={0.26}
        strokeWidth="2.5"
      />
      <circle
        cx="16"
        cy="16"
        r={RING_RADIUS}
        fill="none"
        stroke={used > 90 ? "var(--color-error)" : "currentColor"}
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeDasharray={RING_CIRCUMFERENCE}
        strokeDashoffset={RING_CIRCUMFERENCE * (1 - used / 100)}
        className="transition-[stroke-dashoffset,stroke] duration-500 ease-out motion-reduce:transition-none"
      />
    </svg>
  );
}
