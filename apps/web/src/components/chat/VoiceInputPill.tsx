import { memo, useEffect, useRef, type ReactNode } from "react";
import { useMediaQuery } from "~/hooks/useMediaQuery";
import { cn } from "~/lib/utils";

const WAVEFORM_BAR_COUNT = 24;
const WAVEFORM_BAR_IDS = Array.from({ length: WAVEFORM_BAR_COUNT }, (_, index) => String(index));
const WAVEFORM_REST_SCALE = 0.2;

export const VoiceWaveform = memo(function VoiceWaveform(props: { level: number }) {
  const prefersReducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const barsRef = useRef<Array<HTMLSpanElement | null>>([]);
  const levelsRef = useRef(Array<number>(WAVEFORM_BAR_COUNT).fill(0));

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- updates native waveform bar styles when microphone levels arrive
  useEffect(() => {
    const levels = levelsRef.current;
    levels.copyWithin(0, 1);
    levels[levels.length - 1] = props.level;
    barsRef.current.forEach((bar, index) => {
      if (!bar) return;
      const level = levels[index] ?? 0;
      bar.style.opacity = String(0.3 + level * 0.55);
      bar.style.transform = `scaleY(${prefersReducedMotion ? 0.4 : Math.max(WAVEFORM_REST_SCALE, level)})`;
    });
  }, [prefersReducedMotion, props.level]);

  return (
    <div
      aria-hidden
      className="flex h-4 min-w-0 flex-1 items-center justify-end gap-0.5 overflow-hidden"
    >
      {WAVEFORM_BAR_IDS.map((id, index) => (
        <span
          key={id}
          ref={(bar) => {
            barsRef.current[index] = bar;
          }}
          className="h-full w-0.5 shrink-0 origin-center rounded-full bg-foreground opacity-35 transition-[transform,opacity] duration-100 ease-out motion-reduce:transition-none"
          style={{ transform: `scaleY(${prefersReducedMotion ? 0.4 : WAVEFORM_REST_SCALE})` }}
        />
      ))}
    </div>
  );
});

/**
 * The capsule every dictation state renders in. Default matches the composer's send button
 * and insets its pill buttons; compact matches the `xs` buttons in text-field action rows.
 */
export function VoiceInputPill({
  children,
  tone = "default",
  size = "default",
}: {
  children: ReactNode;
  tone?: "default" | "error";
  size?: "default" | "compact" | undefined;
}) {
  return (
    <div
      data-slot="voice-input-pill"
      className={cn(
        "flex min-w-0 items-center gap-1.5 ring-1 ring-inset",
        size === "compact"
          ? // Phones give the capsule its own row so the field's buttons stay together below it.
            "h-7 rounded-md max-sm:order-first max-sm:basis-full sm:h-6"
          : "h-9 max-w-fit grow-[1.5] basis-0 rounded-full p-0.5 sm:h-8",
        tone === "error"
          ? "bg-destructive/6 text-destructive-foreground ring-destructive/24"
          : "bg-muted/48 ring-border",
      )}
    >
      {children}
    </div>
  );
}
