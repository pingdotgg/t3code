import type { LiveVoiceState } from "@t3tools/client-runtime/live-voice";
import { useRef } from "react";
import { Modal, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";

export function LiveVoiceStartButton(props: { disabled: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Start voice chat"
      accessibilityState={{ disabled: props.disabled }}
      disabled={props.disabled}
      onPress={props.onPress}
      className="h-11 justify-center rounded-xl px-2 active:bg-subtle"
      style={{ opacity: props.disabled ? 0.45 : 1 }}
    >
      <Text className="text-sm font-t3-medium text-foreground-muted">Voice</Text>
    </Pressable>
  );
}

export function LiveVoiceCall(props: {
  visible: boolean;
  state: LiveVoiceState;
  threadTitle: string;
  onClose: () => void;
  onMute: (muted: boolean) => void;
}) {
  const captions = useRef<ScrollView>(null);
  const insets = useSafeAreaInsets();
  const active = props.state.status === "connecting" || props.state.status === "connected";
  return (
    <Modal visible={props.visible} animationType="slide" onRequestClose={props.onClose}>
      <View
        className="flex-1 bg-screen"
        style={{ paddingTop: insets.top, paddingBottom: insets.bottom }}
      >
        <View className="gap-2 border-b border-border p-5">
          <Text className="text-xl font-t3-medium text-foreground">Voice chat</Text>
          <Text className="text-sm text-foreground-muted" numberOfLines={2}>
            {props.threadTitle}
          </Text>
          <Text accessibilityLiveRegion="polite" className="text-sm text-foreground-muted">
            {props.state.status === "connecting"
              ? "Connecting…"
              : props.state.status === "connected"
                ? props.state.muted
                  ? "Microphone muted"
                  : "Listening"
                : props.state.status === "error"
                  ? "Could not continue voice chat"
                  : "Call ended"}
          </Text>
        </View>
        <ScrollView
          ref={captions}
          className="flex-1"
          contentContainerStyle={{ padding: 20, gap: 16 }}
          onContentSizeChange={() => captions.current?.scrollToEnd({ animated: false })}
        >
          {props.state.transcript.length === 0 ? (
            <Text className="text-foreground-muted">
              Speak naturally about this thread. Captions appear here during your call.
            </Text>
          ) : null}
          <Text className="text-base text-foreground" selectable>
            {props.state.transcript
              .map((entry) => `${entry.role === "user" ? "You" : "Assistant"}\n${entry.text}`)
              .join("\n\n")}
          </Text>
          {props.state.error ? (
            <Text accessibilityRole="alert" className="text-foreground">
              {props.state.error}
            </Text>
          ) : null}
        </ScrollView>
        <View className="gap-3 border-t border-border p-5">
          {active ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={props.state.muted ? "Unmute microphone" : "Mute microphone"}
              accessibilityState={{ selected: props.state.muted }}
              onPress={() => props.onMute(!props.state.muted)}
              className="min-h-12 items-center justify-center rounded-xl bg-subtle px-4"
            >
              <Text className="font-t3-medium text-foreground">
                {props.state.muted ? "Unmute" : "Mute"}
              </Text>
            </Pressable>
          ) : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={active ? "End voice chat" : "Close voice chat"}
            onPress={props.onClose}
            className="min-h-12 items-center justify-center rounded-xl bg-subtle px-4"
          >
            <Text className="font-t3-medium text-foreground">{active ? "End call" : "Close"}</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}
