import { SpeechPlaybackRate } from "@t3tools/contracts";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { useSpeechOutputDestination } from "./useSpeechOutputDestination";

export function SpeechPlaybackSpeed({ compact = false }: { compact?: boolean }) {
  const { playbackRate, setPlaybackRate } = useSpeechOutputDestination();
  return (
    <Select
      value={String(playbackRate)}
      onValueChange={(value) => {
        const rate = SpeechPlaybackRate.literals.find((rate) => String(rate) === value);
        if (rate) setPlaybackRate(rate);
      }}
    >
      <SelectTrigger
        aria-label="Playback speed"
        size={compact ? "xs" : "sm"}
        variant={compact ? "ghost" : "default"}
      >
        <SelectValue>{playbackRate}×</SelectValue>
      </SelectTrigger>
      <SelectPopup>
        {SpeechPlaybackRate.literals.map((rate) => (
          <SelectItem key={rate} value={String(rate)}>
            {rate}×{rate === 1 ? " (Normal)" : ""}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}
