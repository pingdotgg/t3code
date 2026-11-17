import { useAtomValue } from "@effect/atom-react";
import { resolveTranscriptCommit } from "@t3tools/client-runtime/voice-input";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";

import { ComposerSpeechButton } from "~/components/chat/ComposerSpeechButton";
import { VoiceInputErrorPill } from "~/components/chat/VoiceInputErrorPill";
import { VoiceInputSetup } from "~/components/chat/VoiceInputSetup";
import { primaryServerKeybindingsAtom } from "~/state/server";
import { useDictationShortcut } from "./useDictationShortcut";
import { useEnvironmentSpeechInput, useSpeechUnavailableReason } from "./useEnvironmentSpeechInput";

type DraftSelection = { readonly start: number; readonly end: number };

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
  // Where the transcript will land; the field is read-only while dictating, so it holds still.
  const [caret, setCaret] = useState<DraftSelection>({ start: 0, end: 0 });
  const speech = useEnvironmentSpeechInput({
    environmentId: input.environmentId,
    projectId: input.projectId,
    ownerKey: input.ownerKey,
    disabled: input.disabled,
    offerSetup: false,
    readDraft: () => {
      const field = latest.current.textareaRef.current;
      const cursor = field?.selectionStart ?? latest.current.text.length;
      const selection = { start: cursor, end: field?.selectionEnd ?? cursor };
      setCaret((previous) =>
        previous.start === selection.start && previous.end === selection.end ? previous : selection,
      );
      // The field shows the live transcript, so the draft comes from props, not the DOM.
      return { text: latest.current.text, selection };
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
  const unavailableReason = useSpeechUnavailableReason(speech);
  return {
    ...speech,
    shortcutLabel,
    unavailableReason,
    /** The draft with the live transcript streamed in at the caret, as the field should show it. */
    displayText: withLiveTranscript(input.text, caret, speech.preview),
  };
}

function withLiveTranscript(
  text: string,
  selection: DraftSelection,
  preview: { readonly committed: string; readonly tentative: string } | null,
) {
  if (!preview) return text;
  const snapshot = { ownerKey: "", text, selection, revision: 0 };
  const result = resolveTranscriptCommit(
    snapshot,
    snapshot,
    `${preview.committed}${preview.tentative}`,
    "auto",
  );
  return result.kind === "commit" ? result.text : text;
}

export type TextFieldSpeech = ReturnType<typeof useTextFieldSpeech>;

export function TextFieldSpeechControls({
  speech,
  disabled = false,
}: {
  speech: TextFieldSpeech;
  disabled?: boolean;
}) {
  const showsMic = speech.available || speech.unavailableReason !== null;
  return (
    <>
      {speech.state.phase === "error" ? (
        <VoiceInputErrorPill
          size="compact"
          error={speech.state.error}
          errorAction={speech.state.errorAction}
          disabled={disabled}
          cancelShortcutLabel="Esc"
          onRetry={() => void speech.start()}
          onDismiss={speech.cancel}
        />
      ) : showsMic ? (
        <ComposerSpeechButton
          state={speech.state}
          size="compact"
          shortcutLabel={speech.shortcutLabel}
          disabled={disabled}
          unavailableReason={speech.unavailableReason}
          dictation={{
            level: speech.level,
            onStop: () => void speech.stop(),
            onCancel: speech.cancel,
            onSkipPostProcessing: speech.skipPostProcessing,
          }}
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
