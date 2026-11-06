import { memo, useEffect, useRef, type ReactNode } from "react";
import { useMediaQuery } from "~/hooks/useMediaQuery";

const WAVEFORM_BAR_COUNT = 12;
// A silent bar is a 2px dot: 2px of the bar's 14px height.
const WAVEFORM_MIN_SCALE = 2 / 14;
const WAVEFORM_BAR_IDS = Array.from({ length: WAVEFORM_BAR_COUNT }, (_, index) => String(index));

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
      bar.style.transform = `scaleY(${prefersReducedMotion ? 0.35 : Math.max(WAVEFORM_MIN_SCALE, level)})`;
    });
  }, [prefersReducedMotion, props.level]);

  return (
    <div aria-hidden className="flex h-5 min-w-0 items-center justify-end gap-0.5 overflow-hidden">
      {WAVEFORM_BAR_IDS.map((id, index) => (
        <span
          key={id}
          ref={(bar) => {
            barsRef.current[index] = bar;
          }}
          className="h-3.5 w-0.5 shrink-0 origin-center rounded-full bg-primary transition-transform duration-100 ease-out motion-reduce:transition-none"
          style={{ transform: `scaleY(${prefersReducedMotion ? 0.35 : WAVEFORM_MIN_SCALE})` }}
        />
      ))}
    </div>
  );
});

export function VoiceInputPill({ children }: { children: ReactNode }) {
  return (
    // Same height as the toolbar's icon buttons, so starting a recording never resizes the composer.
    <div
      data-slot="voice-input-pill"
      className="flex h-8 w-48 max-w-full min-w-0 shrink-0 items-center gap-2 sm:h-7 sm:w-64"
    >
      {children}
    </div>
  );
}
