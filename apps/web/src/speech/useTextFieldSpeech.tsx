import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useEffect, useRef, type ReactNode, type RefObject } from "react";

import { primaryServerKeybindingsAtom } from "~/state/server";
import { useDictationShortcut } from "./useDictationShortcut";
import { useEnvironmentSpeechInput } from "./useEnvironmentSpeechInput";
import {
  ComposerSpeechButton,
  ComposerSpeechCancelButton,
  ComposerSpeechRecordingPill,
  ComposerSpeechStatus,
} from "~/components/chat/ComposerSpeechButton";
import { VoiceInputSetup } from "~/components/chat/VoiceInputSetup";

/** Bind dictation to a plain-text draft and keep the insertion cursor in that editor. */
export function useTextFieldSpeech(input: {
  environmentId: EnvironmentId;
  projectId?: ProjectId | undefined;
  ownerKey: string;
  text: string;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  onTextChange(text: string): void;
  disabled?: boolean;
}) {
  const latest = useRef(input);
  useEffect(() => {
    latest.current = input;
  });
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const speech = useEnvironmentSpeechInput({
    environmentId: input.environmentId,
    projectId: input.projectId,
    ownerKey: input.ownerKey,
    draftText: input.text,
    readDraft: () => {
      const field = latest.current.textareaRef.current;
      const cursor = field?.selectionStart ?? latest.current.text.length;
      return {
        text: field?.value ?? latest.current.text,
        selection: { start: cursor, end: cursor },
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
      {speech.preview ? (
        <p role="status" className="text-sm text-muted-foreground">
          {speech.preview.committed}
          {speech.preview.tentative}
        </p>
      ) : null}
      <div className="flex min-w-0 items-center gap-1">
        <ComposerSpeechRecordingPill
          state={speech.state}
          progress={speech.progress}
          level={speech.level}
          finishShortcutLabel={speech.shortcutLabel}
          onStop={() => void speech.stop()}
          onCancel={speech.cancel}
          onSkipPostProcessing={speech.skipPostProcessing}
        />
        {speech.state.phase === "error" ? (
          <>
            <ComposerSpeechStatus
              state={speech.state}
              progress={speech.progress}
              level={speech.level}
            />
            <ComposerSpeechCancelButton state={speech.state} onCancel={speech.cancel} />
          </>
        ) : null}
        {speech.available ? (
          <ComposerSpeechButton
            state={speech.state}
            progress={speech.progress}
            shortcutLabel={speech.shortcutLabel}
            disabled={disabled}
            onStart={() => void speech.start()}
            onCancel={speech.cancel}
          />
        ) : null}
      </div>
      <VoiceInputSetup
        environmentId={speech.transcriptionEnvironmentId}
        open={speech.setup.open}
        step={speech.setup.step}
        status={speech.status}
        model={speech.setup.model}
        downloading={speech.setup.downloading}
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
