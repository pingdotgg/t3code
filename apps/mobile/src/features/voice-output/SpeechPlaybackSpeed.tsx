import { SpeechPlaybackRate } from "@t3tools/contracts";
import { Pressable } from "react-native";
import { AppText } from "../../components/ui/AppText";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { Menu } from "../../components/ui/Menu";
import { useSpeechOutputDestination } from "./useSpeechOutputDestination";

export function SpeechPlaybackSpeed({ compact = false }: { compact?: boolean }) {
  const { playbackRate, setPlaybackRate } = useSpeechOutputDestination();
  return (
    <Menu
      actions={SpeechPlaybackRate.literals.map((rate) => ({
        id: String(rate),
        title: `${rate}×${rate === 1 ? " (Normal)" : ""}`,
        state: rate === playbackRate ? "on" : "off",
      }))}
      onPressAction={({ nativeEvent }) => {
        const rate = SpeechPlaybackRate.literals.find((rate) => String(rate) === nativeEvent.event);
        if (rate) setPlaybackRate(rate);
      }}
    >
      {compact ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Playback speed ${playbackRate}×`}
          hitSlop={8}
          className="min-h-8 min-w-10 items-center justify-center"
        >
          <AppText textRole="caption">{playbackRate}×</AppText>
        </Pressable>
      ) : (
        <ListActionRow label="Playback speed" detail={`${playbackRate}×`} onPress={() => {}} />
      )}
    </Menu>
  );
}
