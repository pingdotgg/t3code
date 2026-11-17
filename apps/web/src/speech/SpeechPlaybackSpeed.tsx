import { useGT } from "gt-react";
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
  const gt = useGT();
  const { playbackRate, setPlaybackRate, canManage, mixedRate } = useSpeechOutputDestination();
  return (
    <Select
      value={mixedRate ? "mixed" : String(playbackRate)}
      disabled={!canManage}
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
        <SelectValue>{mixedRate ? gt("Mixed") : `${playbackRate}×`}</SelectValue>
      </SelectTrigger>
      <SelectPopup>
        {mixedRate ? (
          <SelectItem value="mixed" disabled>
            {gt("Mixed")}
          </SelectItem>
        ) : null}
        {SpeechPlaybackRate.literals.map((rate) => (
          <SelectItem key={rate} value={String(rate)}>
            {rate}×{rate === 1 ? " (Normal)" : ""}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}
