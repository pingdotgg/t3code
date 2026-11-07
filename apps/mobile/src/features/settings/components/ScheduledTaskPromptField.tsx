import { TextInput, View } from "react-native";

import { AppText as Text } from "../../../components/ui/AppText";
import type { ComposerEditorSelection } from "../../../components/ComposerEditor";
import {
  ComposerDictationCancelAction,
  ComposerDictationError,
  ComposerDictationPrimaryAction,
  ComposerDictationStartAction,
  ComposerDictationStatus,
  ComposerDictationToolbar,
} from "../../voice-input/ComposerDictationControl";
import type { useVoiceInputController } from "../../voice-input/useVoiceInputController";
import { resolveVoiceComposerPresentation } from "../../voice-input/voiceInputPresentation";

export function ScheduledTaskPromptField(props: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly selection: ComposerEditorSelection;
  readonly onChangeSelection: (selection: ComposerEditorSelection) => void;
  readonly disabled: boolean;
  readonly voiceInput: ReturnType<typeof useVoiceInputController>;
}) {
  const voice = props.voiceInput;
  const presentation = resolveVoiceComposerPresentation(voice.state, voice.elapsedSeconds);
  const showsDictation = presentation.statusKind === "active";
  const showsIdleTrigger = voice.isAvailable && !showsDictation;

  return (
    <View className="gap-2 border-t border-border-subtle px-4 py-3">
      <Text className="text-sm text-foreground-muted">Prompt</Text>
      <View className="flex-row">
        <TextInput
          accessibilityLabel="Prompt"
          value={props.value}
          onChangeText={props.onChange}
          selection={props.selection}
          onSelectionChange={({ nativeEvent }) => props.onChangeSelection(nativeEvent.selection)}
          readOnly={props.disabled || voice.freezesEditor}
          multiline
          scrollEnabled
          textAlignVertical="top"
          placeholder="What should the agent do each time?"
          placeholderTextColorClassName="accent-foreground-muted"
          className="max-h-40 min-h-24 flex-1 font-sans text-base text-foreground"
        />
        {voice.isAvailable ? (
          // Keeps its width while dictating so the prompt does not reflow when the trigger hides.
          <View className="w-[44px] self-end">
            {showsIdleTrigger ? (
              <ComposerDictationStartAction
                state={voice.state}
                isAvailable={voice.isAvailable}
                disabled={props.disabled}
                onStart={voice.start}
                onCancel={voice.cancel}
              />
            ) : null}
          </View>
        ) : null}
      </View>
      <ComposerDictationError
        error={voice.state.phase === "error" ? voice.state.error : null}
        onDismiss={voice.cancel}
      />
      {showsDictation ? (
        <ComposerDictationToolbar showsDictation>
          <View className="h-11 flex-row items-center">
            <ComposerDictationCancelAction presentation={presentation} onCancel={voice.cancel} />
            <ComposerDictationStatus
              audioLevels={voice.audioLevels}
              elapsedSeconds={voice.elapsedSeconds}
              phase={voice.state.phase}
              presentation={presentation}
            />
            <ComposerDictationPrimaryAction
              state={voice.state}
              presentation={presentation}
              isAvailable={voice.isAvailable}
              disabled={props.disabled}
              onStart={voice.start}
              onConfirm={voice.stop}
              onCancel={voice.cancel}
            />
          </View>
        </ComposerDictationToolbar>
      ) : null}
    </View>
  );
}
