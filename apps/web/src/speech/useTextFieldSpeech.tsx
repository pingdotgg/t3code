import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useEffect, useRef, type ReactNode, type RefObject } from "react";

import {
  ComposerSpeechButton,
  ComposerSpeechRecordingPill,
} from "~/components/chat/ComposerSpeechButton";
import { VoiceInputSetup } from "~/components/chat/VoiceInputSetup";
import { primaryServerKeybindingsAtom } from "~/state/server";
import { useDictationShortcut } from "./useDictationShortcut";
import { useEnvironmentSpeechInput } from "./useEnvironmentSpeechInput";

/** Binds dictation to a plain textarea draft; the shortcut targets it only while it has focus. */
export function useTextFieldSpeech(input: {
  readonly environmentId: EnvironmentId;
  readonly projectId?: ProjectId | null | undefined;
  readonly ownerKey: string;
  readonly text: string;
  readonly textareaRef: RefObject<HTMLTextAreaElement | null>;
  readonly onTextChange: (text: string) => void;
  readonly disabled?: boolean | undefined;
}) {
  const latest = useRef(input);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- publishes committed field callbacks to the asynchronous recording controller
  useEffect(() => {
    latest.current = input;
  });
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const speech = useEnvironmentSpeechInput({
    environmentId: input.environmentId,
    projectId: input.projectId,
    ownerKey: input.ownerKey,
    draftText: input.text,
    disabled: input.disabled,
    offerSetup: false,
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

export type TextFieldSpeech = ReturnType<typeof useTextFieldSpeech>;

export function TextFieldSpeechControls({
  speech,
  disabled = false,
}: {
  speech: TextFieldSpeech;
  disabled?: boolean;
}) {
  return (
    <>
      {speech.preview ? (
        <p
          role="status"
          className="order-first max-h-24 w-full overflow-y-auto rounded-lg border border-border/60 bg-muted/30 px-2.5 py-1.5 text-sm break-words whitespace-pre-wrap"
        >
          {speech.preview.committed}
          <span className="text-muted-foreground">{speech.preview.tentative}</span>
        </p>
      ) : null}
      <ComposerSpeechRecordingPill
        state={speech.state}
        progress={null}
        level={speech.level}
        finishShortcutLabel={speech.shortcutLabel}
        cancelShortcutLabel="Esc"
        disabled={disabled}
        onStart={() => void speech.start()}
        onStop={() => void speech.stop()}
        onCancel={speech.cancel}
        onSkipPostProcessing={speech.skipPostProcessing}
      />
      {speech.available ? (
        <ComposerSpeechButton
          state={speech.state}
          size="compact"
          shortcutLabel={speech.shortcutLabel}
          disabled={disabled}
          onStart={() => void speech.start()}
        />
      ) : null}
      <VoiceInputSetup
        environmentId={speech.transcriptionEnvironmentId}
        open={speech.setup.open}
        step={speech.setup.step}
        status={speech.status}
        model={speech.setup.model}
        language={speech.setup.language}
        downloading={speech.setup.downloading}
        error={speech.setup.error}
        onOpenChange={speech.setup.setOpen}
        onRetryCatalog={speech.setup.retryCatalog}
        onDownload={() => void speech.setup.download()}
        onCancelDownload={() => void speech.setup.cancelDownload()}
        onStartRecording={() => void speech.setup.startRecording()}
      />
    </>
  );
}

/** Render-prop form for editors that only sometimes have an environment to dictate on. */
export function SpeechTextField({
  children,
  ...input
}: Parameters<typeof useTextFieldSpeech>[0] & {
  children: (speech: TextFieldSpeech) => ReactNode;
}) {
  return children(useTextFieldSpeech(input));
}
