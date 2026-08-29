import { Linking, Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { SymbolView, type AppSymbolName } from "../../components/AppSymbol";
import { cn } from "../../lib/cn";
import type { VoiceComposerPresentation, VoiceInputState } from "./voiceInputController";

function VoiceActionButton(props: {
  readonly accessibilityLabel: string;
  readonly disabled?: boolean;
  readonly icon: AppSymbolName;
  readonly onPress: () => void;
  readonly variant?: "plain" | "primary";
}) {
  const variant = props.variant ?? "plain";
  return (
    <Pressable
      accessibilityLabel={props.accessibilityLabel}
      accessibilityRole="button"
      accessibilityState={{ disabled: props.disabled }}
      className={cn(
        "items-center justify-center active:opacity-70",
        variant === "primary" ? "size-11" : "size-9",
      )}
      disabled={props.disabled}
      hitSlop={variant === "plain" ? 4 : undefined}
      onPress={props.onPress}
      style={{ opacity: props.disabled ? 0.4 : 1 }}
    >
      <View
        className={cn(
          "items-center justify-center",
          variant === "primary" ? "size-11 rounded-full bg-primary" : "size-9",
        )}
      >
        <SymbolView
          name={props.icon}
          size={17}
          tintColorClassName={variant === "primary" ? "accent-primary-foreground" : "accent-icon"}
          type="monochrome"
        />
      </View>
    </Pressable>
  );
}

export function ComposerDictationStatus(props: {
  readonly presentation: VoiceComposerPresentation;
  readonly onDismissError: () => void;
}) {
  if (!props.presentation.statusLabel) return null;
  const isError = props.presentation.statusKind === "error";
  return (
    <View className="min-w-0 flex-1 flex-row items-center gap-1.5 px-2">
      <Text
        className={cn("min-w-0 flex-1 text-sm", isError ? "text-red-300" : "text-foreground-muted")}
        numberOfLines={1}
      >
        {props.presentation.statusLabel}
      </Text>
      {isError ? (
        <Pressable
          accessibilityLabel="Dismiss voice input error"
          accessibilityRole="button"
          className="size-7 items-center justify-center active:opacity-70"
          hitSlop={8}
          onPress={props.onDismissError}
        >
          <SymbolView
            name="xmark"
            size={12}
            tintColorClassName="accent-icon-muted"
            type="monochrome"
          />
        </Pressable>
      ) : null}
    </View>
  );
}

export function ComposerDictationCancelAction(props: {
  readonly presentation: VoiceComposerPresentation;
  readonly onCancel: () => void;
}) {
  if (props.presentation.leadingAction !== "cancel") return null;
  return (
    <VoiceActionButton
      accessibilityLabel="Cancel dictation"
      icon="xmark"
      onPress={props.onCancel}
    />
  );
}

export function ComposerDictationPrimaryAction(props: {
  readonly state: VoiceInputState;
  readonly presentation: VoiceComposerPresentation;
  readonly isAvailable: boolean;
  readonly disabled?: boolean;
  readonly onStart: () => void;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}) {
  if (props.presentation.trailingAction === "confirm") {
    return (
      <VoiceActionButton
        accessibilityLabel="Finish dictation"
        disabled={!props.presentation.confirmationEnabled}
        icon="checkmark"
        onPress={props.onConfirm}
        variant="primary"
      />
    );
  }

  if (!props.isAvailable) return null;
  const openSettings = props.state.phase === "error" && props.state.errorAction === "settings";
  return (
    <VoiceActionButton
      accessibilityLabel={openSettings ? "Open microphone settings" : "Start dictation"}
      disabled={props.disabled}
      icon="mic"
      onPress={
        openSettings
          ? () => {
              props.onCancel();
              void Linking.openSettings();
            }
          : props.onStart
      }
    />
  );
}
