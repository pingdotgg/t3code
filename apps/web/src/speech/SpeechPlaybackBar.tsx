import { PauseIcon, PlayIcon, SquareIcon, Volume2Icon } from "lucide-react";

import { Button } from "../components/ui/button";
import { pauseSpeaking, resumeSpeaking, stopSpeaking, useSpeechPlayback } from "./speechPlayer";

/** Pause, resume, and stop for whatever Read aloud is playing. Hidden when nothing plays. */
export function SpeechPlaybackBar() {
  const status = useSpeechPlayback((state) => state.status);
  const label = useSpeechPlayback((state) => state.sourceLabel);
  if (status === "idle") return null;
  return (
    <div
      className="flex items-center gap-1.5 rounded-lg border border-border bg-card/70 px-2.5 py-1 text-xs shadow-xs backdrop-blur"
      data-speech-playback={status}
      aria-live="polite"
    >
      <Volume2Icon className="size-3.5 shrink-0 text-primary" />
      <span className="min-w-0 flex-1 truncate text-muted-foreground">
        {status === "paused" ? "Paused" : "Reading"} {label?.toLowerCase() ?? "aloud"}
      </span>
      {status === "speaking" ? (
        <Button size="xs" variant="ghost" onClick={pauseSpeaking}>
          <PauseIcon /> Pause
        </Button>
      ) : (
        <Button size="xs" variant="ghost" onClick={resumeSpeaking}>
          <PlayIcon /> Resume
        </Button>
      )}
      <Button size="xs" variant="ghost" onClick={stopSpeaking}>
        <SquareIcon /> Stop
      </Button>
    </div>
  );
}
