import { ActivityIndicator, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { ControlPill } from "../../components/ControlPill";
import type { MobileVoiceTranscriptionStatus } from "./useMobileVoiceTranscription";

const WAVEFORM_BAR_IDS = Array.from({ length: 24 }, (_, index) => `voice-waveform-${index}`);

function formatElapsed(elapsedMs: number): string {
  const seconds = Math.floor(elapsedMs / 1_000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function MobileVoiceTranscriptionPanel(props: {
  readonly status: Exclude<MobileVoiceTranscriptionStatus, "idle">;
  readonly elapsedMs: number;
  readonly levels: readonly number[];
  readonly sendDisabled: boolean;
  readonly onCancel: () => void;
  readonly onStop: () => void;
  readonly onSend: () => void;
}) {
  if (props.status === "transcribing") {
    return (
      <View className="min-h-11 flex-1 flex-row items-center justify-center gap-2 px-2">
        <ControlPill
          accessibilityLabel="Cancel transcription"
          className="h-9 w-9"
          icon="xmark"
          onPress={props.onCancel}
        />
        <ActivityIndicator size="small" />
        <Text className="text-sm text-foreground-muted">Processing recording…</Text>
      </View>
    );
  }

  return (
    <View className="min-h-11 flex-1 flex-row items-center gap-2">
      <ControlPill
        accessibilityLabel="Cancel dictation"
        className="h-9 w-9"
        icon="xmark"
        onPress={props.onCancel}
      />
      <View className="h-8 min-w-0 flex-1 flex-row items-center justify-between gap-px">
        {WAVEFORM_BAR_IDS.map((barId, index) => (
          <View
            key={barId}
            className="w-0.5 rounded-full bg-foreground-muted"
            style={{ height: Math.max(2, 2 + (props.levels.at(index - 24) ?? 0) * 24) }}
          />
        ))}
      </View>
      <Text className="w-10 text-right text-sm tabular-nums text-foreground-muted">
        {formatElapsed(props.elapsedMs)}
      </Text>
      <ControlPill
        accessibilityLabel="Stop dictation"
        className="h-9 w-9"
        icon="stop.fill"
        onPress={props.onStop}
      />
      <ControlPill
        accessibilityLabel="Transcribe and send"
        className="h-9 w-9"
        disabled={props.sendDisabled}
        icon="arrow.up"
        variant="primary"
        onPress={props.onSend}
      />
    </View>
  );
}
