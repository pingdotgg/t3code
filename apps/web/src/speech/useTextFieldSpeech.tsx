import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useRef, type ReactNode, type RefObject } from "react";

import { primaryServerKeybindingsAtom } from "~/state/server";
import { useDictationShortcut } from "./useDictationShortcut";
import { useEnvironmentSpeechInput } from "./useEnvironmentSpeechInput";
import { ComposerSpeechMicButton } from "~/components/chat/ComposerSpeechButton";
import { VoiceInputSetup } from "~/components/chat/VoiceInputSetup";

/** Bind dictation to a plain-text draft and keep the insertion cursor in that editor. */
export function useTextFieldSpeech(input: {
  environmentId: EnvironmentId;
  ownerKey: string;
  text: string;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  onTextChange(text: string): void;
  disabled?: boolean;
}) {
  const latest = useRef(input);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Publish committed text-field callbacks before asynchronous transcription inserts its result.
  useEffect(() => {
    latest.current = input;
  });
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const speech = useEnvironmentSpeechInput({
    environmentId: input.environmentId,
    ownerKey: input.ownerKey,
    draftText: input.text,
    readDraft: () => {
      const field = latest.current.textareaRef.current;
      const cursor = field?.selectionStart ?? latest.current.text.length;
      return {
        text: field?.value ?? latest.current.text,
        selection: { start: cursor, end: field?.selectionEnd ?? cursor },
      };
    },
    commitDraft: (text, selection) => {
      latest.current.onTextChange(text);
      window.requestAnimationFrame(() => {
        const field = latest.current.textareaRef.current;
        if (!field) return;
        field.focus({ preventScroll: true });
        field.setSelectionRange(selection.start, selection.end);
      });
    },
  });
  const shortcutLabel = useDictationShortcut({
    keybindings,
    speech,
    disabled: input.disabled ?? false,
    terminalOpen: false,
    modelPickerOpen: false,
    targetRef: input.textareaRef,
  });
  return { ...speech, shortcutLabel };
}

export function TextFieldSpeechControls({
  speech,
  disabled = false,
}: {
  speech: ReturnType<typeof useTextFieldSpeech>;
  disabled?: boolean;
}) {
  return (
    <>
      {speech.available ? (
        <ComposerSpeechMicButton
          appearance="field"
          state={speech.state}
          level={speech.level}
          shortcutLabel={speech.shortcutLabel}
          disabled={disabled}
          onStart={() => void speech.start()}
          onStop={() => void speech.stop()}
          onCancel={speech.cancel}
          onSkipPostProcessing={speech.skipPostProcessing}
        />
      ) : null}
      <VoiceInputSetup
        environmentId={speech.transcriptionEnvironmentId}
        open={speech.setup.open}
        step={speech.setup.step}
        status={speech.status}
        model={speech.setup.model}
        downloading={speech.setup.downloading}
        cancelled={speech.setup.cancelled}
        error={speech.setup.error}
        onOpenChange={speech.setup.setOpen}
        onDownload={() => void speech.setup.download()}
        onCancelDownload={() => void speech.setup.cancelDownload()}
        onStartRecording={() => void speech.setup.startRecording()}
      />
    </>
  );
}

export function SpeechTextField({
  children,
  ...input
}: Parameters<typeof useTextFieldSpeech>[0] & {
  children(speech: ReturnType<typeof useTextFieldSpeech>): ReactNode;
}) {
  const speech = useTextFieldSpeech(input);
  return children(speech);
}
