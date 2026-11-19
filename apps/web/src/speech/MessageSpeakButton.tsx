import { SquareIcon, Volume2Icon } from "lucide-react";

import { getClientSettings, useClientSettings } from "../hooks/useSettings";
import { Button } from "../components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { speak, speechAvailable, stopSpeaking, useSpeechPlayback } from "./speechPlayer";
import { speakableText } from "./speechText";

/** Reads one agent message aloud, or stops it while it is playing. */
export function MessageSpeakButton({ messageId, text }: { messageId: string; text: string }) {
  const playing = useSpeechPlayback(
    (state) => state.sourceId === messageId && state.status !== "idle",
  );
  const engine = useClientSettings((settings) => settings.speech.engine);
  if (!speechAvailable({ engine }) || text.trim() === "") return null;
  const label = playing ? "Stop reading" : "Read aloud";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="xs"
            variant="ghost-muted"
            aria-label={label}
            aria-pressed={playing}
            onClick={() => {
              if (playing) {
                stopSpeaking();
                return;
              }
              const settings = getClientSettings().speech;
              speak(speakableText(text, settings), settings, {
                id: messageId,
                label: "Agent message",
              });
            }}
          />
        }
      >
        {playing ? <SquareIcon className="size-3" /> : <Volume2Icon className="size-3" />}
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}
