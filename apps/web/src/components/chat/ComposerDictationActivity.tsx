import type { VoiceInputPhase } from "@t3tools/client-runtime/voice-input";
import { XIcon } from "lucide-react";
import { useEffect, useRef, useState, type PointerEvent } from "react";

import type { DictationLevel } from "~/dictation/dictationLevel";
import { WAVEFORM_REST_SCALE, driveDictationWaveform } from "~/dictation/dictationWaveform";
import { useMediaQuery } from "~/hooks/useMediaQuery";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";

const BAR_COUNT = 11;
const BARS = Array.from({ length: BAR_COUNT }, (_, index) => index);

const keepComposerFocus = (event: PointerEvent) => event.preventDefault();

/** Recording time, counted here so the ticking clock re-renders only this label. */
function RecordingElapsed() {
  const [seconds, setSeconds] = useState(0);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Maintain the recording elapsed-time interval while mounted.
  useEffect(() => {
    const startedAt = Date.now();
    const interval = setInterval(
      () => setSeconds(Math.floor((Date.now() - startedAt) / 1_000)),
      1_000,
    );
    return () => clearInterval(interval);
  }, []);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * Bars that follow the microphone while it is live. They rest as dots while
 * transcribing, while idle, and under reduced motion.
 */
function DictationWaveform(props: { readonly level: DictationLevel; readonly live: boolean }) {
  const containerRef = useRef<HTMLSpanElement>(null);
  const reduceMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const animate = props.live && !reduceMotion;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Subscribe the waveform DOM to microphone levels while mounted.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const bars = Array.from(container.children).filter(
      (child): child is HTMLElement => child instanceof HTMLElement,
    );
    if (animate) return driveDictationWaveform(bars, props.level);
    for (const bar of bars) bar.style.transform = `scaleY(${WAVEFORM_REST_SCALE})`;
    return undefined;
  }, [animate, props.level]);

  return (
    <span ref={containerRef} className="flex h-4 items-center gap-0.5" aria-hidden="true">
      {BARS.map((index) => (
        <span
          key={index}
          className={cn("h-4 w-[2px] rounded-full bg-primary", animate && "will-change-transform")}
          style={{ transform: `scaleY(${WAVEFORM_REST_SCALE})` }}
        />
      ))}
    </span>
  );
}

// Subscribe directly to audio levels without rerendering the composer for each frame.
export function ComposerDictationActivity(props: {
  readonly phase: VoiceInputPhase;
  readonly level: DictationLevel;
  readonly onCancel: () => void;
}) {
  const recording = props.phase === "recording";
  // Capture starts while the session is still being set up, so the bars react from the first word.
  const listening = recording || props.phase === "preparing";
  return (
    <span className="flex items-center gap-1.5 pr-1.5 pl-0.5">
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        onPointerDown={keepComposerFocus}
        onClick={props.onCancel}
        aria-label="Cancel dictation"
      >
        <XIcon />
      </Button>
      <span
        className={cn(
          "flex items-center gap-2 transition-opacity duration-150",
          !listening && "opacity-45",
        )}
      >
        <DictationWaveform level={props.level} live={listening} />
        <span className="min-w-[4.5ch] text-xs tabular-nums text-muted-foreground">
          {recording ? <RecordingElapsed /> : props.phase === "transcribing" ? "…" : "0:00"}
        </span>
      </span>
    </span>
  );
}
