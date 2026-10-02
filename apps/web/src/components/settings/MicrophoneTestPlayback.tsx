import { PauseIcon, PlayIcon, RotateCcwIcon, CheckIcon } from "lucide-react";
import { useRef, useState } from "react";

import { Button } from "../ui/button";
import { VoiceInputPill } from "../chat/VoiceInputPill";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";

const formatTime = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

export function MicrophoneTestPlayback({
  src,
  duration,
  onRetry,
  onDone,
}: {
  src: string;
  duration: number;
  onRetry(): void;
  onDone(): void;
}) {
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [error, setError] = useState(false);

  async function togglePlayback() {
    const player = audio.current;
    if (!player) return;
    if (!player.paused) {
      player.pause();
      return;
    }
    setError(false);
    if (player.ended) player.currentTime = 0;
    try {
      await player.play();
    } catch {
      setError(true);
    }
  }

  return (
    <div>
      <audio
        ref={audio}
        src={src}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onTimeUpdate={() => setPosition(audio.current?.currentTime ?? 0)}
        onError={() => setError(true)}
      />
      <VoiceInputPill>
        <Button
          size="icon-sm-pill"
          variant="ghost"
          aria-label={playing ? "Pause recording" : "Play recording"}
          onClick={() => void togglePlayback()}
        >
          {playing ? <PauseIcon /> : <PlayIcon />}
        </Button>
        <input
          type="range"
          aria-label="Recording playback position"
          min={0}
          max={duration}
          step={0.01}
          value={Math.min(position, duration)}
          style={{
            background: `linear-gradient(to right, var(--primary) ${(duration > 0 ? Math.min(position / duration, 1) : 0) * 100}%, var(--muted) ${(duration > 0 ? Math.min(position / duration, 1) : 0) * 100}%)`,
          }}
          disabled={duration <= 0}
          onChange={(event) => {
            const next = Number(event.target.value);
            if (audio.current) audio.current.currentTime = next;
            setPosition(next);
          }}
          className="h-1 min-w-0 flex-1 cursor-pointer appearance-none rounded-full bg-muted accent-primary focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring [&::-webkit-slider-thumb]:size-2.5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-primary [&::-moz-range-thumb]:size-2.5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-primary"
        />
        <span
          className="shrink-0 text-xs tabular-nums text-muted-foreground"
          aria-label={`${formatTime(position)} / ${formatTime(duration)}`}
        >
          {formatTime(position)}
        </span>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button size="icon-sm-pill" variant="ghost" aria-label="Try again" onClick={onRetry}>
                <RotateCcwIcon />
              </Button>
            }
          />
          <TooltipPopup>Try again</TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button size="icon-sm-pill" aria-label="Done" onClick={onDone}>
                <CheckIcon />
              </Button>
            }
          />
          <TooltipPopup>Done</TooltipPopup>
        </Tooltip>
      </VoiceInputPill>
      {error ? (
        <p role="alert" className="mt-1 text-xs text-destructive">
          Could not play this recording. Try recording again.
        </p>
      ) : null}
    </div>
  );
}
