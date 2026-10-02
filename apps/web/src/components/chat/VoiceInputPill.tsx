import { memo, useEffect, useRef, type ReactNode } from "react";
import { useMediaQuery } from "~/hooks/useMediaQuery";

const WAVEFORM_BAR_COUNT = 28;
const WAVEFORM_BAR_IDS = Array.from({ length: WAVEFORM_BAR_COUNT }, (_, index) => String(index));

export const VoiceWaveform = memo(function VoiceWaveform(props: { level: number }) {
  const prefersReducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const barsRef = useRef<Array<HTMLSpanElement | null>>([]);
  const levelsRef = useRef(Array<number>(WAVEFORM_BAR_COUNT).fill(0));

  useEffect(() => {
    const levels = levelsRef.current;
    levels.copyWithin(0, 1);
    levels[levels.length - 1] = props.level;
    barsRef.current.forEach((bar, index) => {
      if (!bar) return;
      const level = levels[index] ?? 0;
      bar.style.opacity = String(0.22 + level * 0.78);
      bar.style.transform = `scaleY(${prefersReducedMotion ? 0.35 : Math.max(0.08, level)})`;
    });
  }, [prefersReducedMotion, props.level]);

  return (
    <div
      aria-hidden
      className="flex h-5 min-w-0 flex-1 items-center justify-between gap-px overflow-hidden"
    >
      {WAVEFORM_BAR_IDS.map((id, index) => (
        <span
          key={id}
          ref={(bar) => {
            barsRef.current[index] = bar;
          }}
          className="h-full w-0.5 shrink-0 origin-center rounded-full bg-primary opacity-25 transition-[transform,opacity] duration-100 ease-out motion-reduce:transition-none"
          style={{ transform: `scaleY(${prefersReducedMotion ? 0.35 : 0.08})` }}
        />
      ))}
    </div>
  );
});

export function VoiceInputPill({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-10 w-48 min-w-0 shrink-0 items-center gap-2 rounded-full border border-border/50 bg-background/80 p-1 sm:h-9 sm:w-64">
      {children}
    </div>
  );
}
