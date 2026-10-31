import type {
  DesktopPreviewAnnotationVoiceConfig,
  DesktopPreviewAnnotationVoiceEvent,
  EnvironmentId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import { useEnvironmentSpeechInput } from "~/speech/useEnvironmentSpeechInput";
import { useDictationShortcut, type DictationKeyHandlers } from "~/speech/useDictationShortcut";
import { resolveSpeechPresentation } from "~/components/chat/ComposerSpeechButton";
import { VoiceInputSetup } from "~/components/chat/VoiceInputSetup";
import { previewBridge } from "./previewBridge";
import { toastManager } from "~/components/ui/toast";

/** The inspected page owns its draft; recording stays in the application renderer. */
export function PreviewAnnotationSpeech({
  environmentId,
  tabId,
  config,
}: {
  environmentId: EnvironmentId;
  tabId: string;
  config: DesktopPreviewAnnotationVoiceConfig;
}) {
  const navigate = useNavigate();
  const draft = useRef({ text: "", cursor: 0 });
  const [text, setText] = useState("");
  const [, setAcknowledgement] = useState(0);
  const keys = useRef<DictationKeyHandlers | null>(null);
  const speech = useEnvironmentSpeechInput({
    environmentId,
    ownerKey: JSON.stringify([environmentId, tabId, config.sessionId]),
    draftText: text,
    readDraft: () => ({
      text: draft.current.text,
      selection: { start: draft.current.cursor, end: draft.current.cursor },
    }),
    commitDraft: (next, selection) => {
      draft.current = { text: next, cursor: selection.start };
      setText(next);
      void publish({ text: next, cursor: selection.start });
    },
  });
  const current = useRef(speech);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Publish committed speech actions before desktop annotation events read them.
  useEffect(() => {
    current.current = speech;
  });
  const subscribeKeys = (handlers: DictationKeyHandlers) => {
    keys.current = handlers;
    return () => {
      keys.current = null;
    };
  };
  const shortcutLabel = useDictationShortcut({
    keybindings: config.keybindings,
    speech,
    disabled: false,
    terminalOpen: false,
    modelPickerOpen: false,
    previewFocus: true,
    ownsFocus: () => true,
    subscribeKeys,
  });
  const { available, state, preview, freezesEditor, blocksSubmission, cancel, level, progress } =
    speech;
  const publish = async (nextDraft: { text: string; cursor: number } | null = null) => {
    try {
      await previewBridge?.annotationVoice.update({
        tabId,
        sessionId: config.sessionId,
        available: available,
        phase: state.phase,
        errorAction: state.errorAction,
        status: resolveSpeechPresentation(state, progress).status,
        preview: preview ? preview.committed + preview.tentative : null,
        level,
        shortcutLabel,
        freezesEditor: freezesEditor,
        blocksSubmission: blocksSubmission,
        draft: nextDraft,
      });
    } catch (error) {
      cancel();
      toastManager.add({
        type: "error",
        title: "Could not update annotation voice input",
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Synchronize committed speech status with the external desktop annotation webview.
  useEffect(() => {
    void publish();
  }, [publish]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Subscribe to the desktop annotation session and release its event listener on unmount.
  useEffect(
    () =>
      previewBridge?.annotationVoice.onEvent(
        (eventTabId, event: DesktopPreviewAnnotationVoiceEvent) => {
          if (eventTabId !== tabId || event.sessionId !== config.sessionId) return;
          draft.current = { text: event.text, cursor: event.cursor };
          setText(event.text);
          const value = current.current;
          switch (event.action) {
            case "sync":
              void publish();
              break;
            case "start":
              void value.start();
              break;
            case "stop":
              void value.stop();
              break;
            case "cancel":
              value.cancel();
              break;
            case "settings":
              value.cancel();
              void navigate({ to: "/settings/voice" });
              break;
            case "skip":
              value.skipPostProcessing();
              break;
            case "blur":
              keys.current?.blur();
              break;
            case "key": {
              if (!event.keyboard) break;
              const keyboard = new KeyboardEvent(event.keyboard.type, event.keyboard);
              keys.current?.[event.keyboard.type](keyboard);
              break;
            }
          }
          if (event.action !== "sync") setAcknowledgement((count) => count + 1);
        },
      ),
    [tabId, config.sessionId, publish, navigate],
  );
  return (
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
  );
}
