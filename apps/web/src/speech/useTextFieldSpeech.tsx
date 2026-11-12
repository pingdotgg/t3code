import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useEffect, useRef, type ReactNode, type RefObject } from "react";

import {
  ComposerSpeechButton,
  ComposerSpeechRecordingPill,
} from "~/components/chat/ComposerSpeechButton";
import { VoiceInputSetup } from "~/components/chat/VoiceInputSetup";
import { VoiceInputErrorPill } from "~/components/chat/VoiceInputErrorPill";
import { primaryServerKeybindingsAtom } from "~/state/server";
import { useDictationShortcut } from "./useDictationShortcut";
import { useEnvironmentSpeechInput, useSpeechUnavailableReason } from "./useEnvironmentSpeechInput";

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
  compact = false,
}: {
  speech: TextFieldSpeech;
  disabled?: boolean;
  compact?: boolean;
}) {
  const unavailableReason = useSpeechUnavailableReason(speech);
  return (
    <>
      {!compact && speech.preview ? (
        <p role="status" className="w-full text-body text-muted-foreground">
          {speech.preview.committed}
          <span className="opacity-70">{speech.preview.tentative}</span>
        </p>
      ) : null}
      <div
        className={
          compact
            ? "flex h-8 w-17 shrink-0 items-center justify-end gap-1 sm:h-7 sm:w-15"
            : "flex min-w-0 items-center gap-1"
        }
      >
        {compact && speech.state.phase === "error" ? (
          <VoiceInputErrorPill
            compact
            error={speech.state.error}
            errorAction={speech.state.errorAction}
            disabled={disabled}
            cancelShortcutLabel="Esc"
            onRetry={() => void speech.start()}
            onDismiss={speech.cancel}
          />
        ) : !compact ? (
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
        ) : null}
        {speech.available || (compact && unavailableReason !== null) ? (
          <ComposerSpeechButton
            state={speech.state}
            shortcutLabel={speech.shortcutLabel}
            disabled={disabled}
            unavailableReason={compact ? unavailableReason : null}
            dictation={
              compact
                ? {
                    level: speech.level,
                    onStop: () => void speech.stop(),
                    onCancel: speech.cancel,
                    onSkipPostProcessing: speech.skipPostProcessing,
                  }
                : undefined
            }
            onStart={() => void speech.start()}
          />
        ) : null}
      </div>
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
