import { useGT } from "gt-react-native";
import type { SpeechPlaybackControls } from "@t3tools/client-runtime/voice-output";
import { SpeechPlaybackRate } from "@t3tools/contracts";
import { Pressable } from "react-native";
import { AppText } from "../../components/ui/AppText";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { Menu } from "../../components/ui/Menu";
import { useSpeechOutputDestination } from "./useSpeechOutputDestination";

export function SpeechPlaybackSpeed({
  compact = false,
  controls,
}: {
  compact?: boolean;
  controls?: SpeechPlaybackControls;
}) {
  const gt = useGT();
  const fallback = useSpeechOutputDestination();
  const { playbackRate, setPlaybackRate, canManage, mixedRate } = controls ?? fallback;
  return (
    <Menu
      actions={SpeechPlaybackRate.literals.map((rate) => ({
        id: String(rate),
        title: `${rate}×${rate === 1 ? " (Normal)" : ""}`,
        state: !mixedRate && rate === playbackRate ? "on" : "off",
        attributes: { disabled: !canManage },
      }))}
      onPressAction={({ nativeEvent }) => {
        const rate = SpeechPlaybackRate.literals.find((rate) => String(rate) === nativeEvent.event);
        if (rate) setPlaybackRate(rate);
      }}
    >
      {compact ? (
        <Pressable
          disabled={!canManage}
          accessibilityRole="button"
          accessibilityLabel={gt("Playback speed {playbackRate}×", { playbackRate: playbackRate })}
          hitSlop={8}
          className="min-h-8 min-w-10 items-center justify-center"
        >
          <AppText textRole="caption">{mixedRate ? gt("Mixed") : `${playbackRate}×`}</AppText>
        </Pressable>
      ) : (
        <ListActionRow
          disabled={!canManage}
          label={gt("Playback speed")}
          detail={mixedRate ? gt("Mixed") : `${playbackRate}×`}
          onPress={() => {}}
        />
      )}
    </Menu>
  );
}
