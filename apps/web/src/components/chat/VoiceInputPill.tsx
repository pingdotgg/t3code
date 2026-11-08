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
 * The capsule every dictation state renders in. It matches the composer's pill buttons
 * (h-8, h-7 from sm), so starting a recording never resizes the toolbar it sits in.
 */
export function VoiceInputPill({
  children,
  tone = "default",
}: {
  children: ReactNode;
  tone?: "default" | "error";
}) {
  return (
    <div
      data-slot="voice-input-pill"
      className={cn(
        "flex h-8 items-center gap-1.5 rounded-full ring-1 ring-inset sm:h-7",
        tone === "error"
          ? "max-w-fit min-w-0 grow-2 basis-0 bg-destructive/6 text-destructive ring-destructive/24"
          : "max-w-60 min-w-32 flex-1 bg-muted/48 ring-border",
      )}
    >
      {children}
    </div>
  );
}
