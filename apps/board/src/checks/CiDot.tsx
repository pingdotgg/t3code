const TONE = {
  passing: "bg-emerald-400",
  failing: "bg-red-400",
  pending: "bg-amber-400",
  stuck: "bg-red-400",
  none: null,
} as const;

export type CiReading = keyof typeof TONE;

/** Orca's CI status dot: green when the checks pass, red when one fails or is stuck, amber while they run. Nothing when there are none. */
export function CiDot({ reading, className = "" }: { reading: CiReading; className?: string }) {
  const tone = TONE[reading];
  return tone === null ? null : (
    <span
      data-testid="ci-dot"
      data-reading={reading}
      aria-hidden
      className={`size-1.5 rounded-full ${tone} ${className}`}
    />
  );
}
