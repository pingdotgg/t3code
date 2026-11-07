import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type {
  DesktopPreviewAnnotationVoiceConfig,
  DesktopPreviewAnnotationVoiceEvent,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import { resolveSpeechPresentation } from "~/components/chat/ComposerSpeechButton";
import { VoiceInputSetup } from "~/components/chat/VoiceInputSetup";
import { toastManager } from "~/components/ui/toast";
import { useComposerDraftStore } from "~/composerDraftStore";
import { useStableCallback } from "~/hooks/useStableCallback";
import { useDictationShortcut, type DictationKeyHandlers } from "~/speech/useDictationShortcut";
import { useEnvironmentSpeechInput } from "~/speech/useEnvironmentSpeechInput";
import { useProject, useThreadShell } from "~/state/entities";
import { previewBridge } from "./previewBridge";

/**
 * The annotation editor lives inside the preview guest, which only forwards trusted gestures
 * and mirrors state. Recording, consent, and transcription stay in this renderer.
 */
export function PreviewAnnotationSpeech({
  threadRef,
  tabId,
  config,
  keybindings,
}: {
  threadRef: ScopedThreadRef;
  tabId: string;
  config: DesktopPreviewAnnotationVoiceConfig;
  keybindings: Parameters<typeof useDictationShortcut>[0]["keybindings"];
}) {
  const navigate = useNavigate();
  const thread = useThreadShell(threadRef);
  const draftThread = useComposerDraftStore((store) => store.getDraftThreadByRef(threadRef));
  const projectId = thread?.projectId ?? draftThread?.projectId ?? null;
  const project = useProject(
    projectId ? scopeProjectRef(threadRef.environmentId, projectId) : null,
  );
  const draft = useRef({ text: "", cursor: 0, selectionEnd: 0 });
  const [text, setText] = useState("");
  const keys = useRef<DictationKeyHandlers | null>(null);
  const guestFocused = useRef(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- notices focus returning from the preview guest to this window
  useEffect(() => {
    const onFocus = () => {
      guestFocused.current = false;
    };
    window.addEventListener("focus", onFocus);
    window.addEventListener("focusin", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("focusin", onFocus);
    };
  }, []);
  const speech = useEnvironmentSpeechInput({
    environmentId: threadRef.environmentId,
    projectId,
    projectName: project?.title,
    ownerKey: JSON.stringify(["preview-annotation", threadRef, tabId, config.sessionId]),
    draftText: text,
    offerSetup: false,
    readDraft: () => ({
      text: draft.current.text,
      selection: { start: draft.current.cursor, end: draft.current.selectionEnd },
    }),
    commitDraft: (next, selection) => {
      draft.current = { text: next, cursor: selection.start, selectionEnd: selection.end };
      setText(next);
      void publish(current.current.voiceState, { text: next, cursor: selection.start });
    },
  });
  const subscribeKeys = useStableCallback((handlers: DictationKeyHandlers) => {
    keys.current = handlers;
    return () => {
      keys.current = null;
    };
  });
  const shortcutLabel = useDictationShortcut({
    keybindings,
    speech,
    disabled: false,
    terminalOpen: false,
    modelPickerOpen: false,
    previewFocus: true,
    ownsFocus: () => guestFocused.current,
    subscribeKeys,
  });
  const { available, state, preview, freezesEditor, blocksSubmission, level } = speech;
  const voiceState = {
    tabId,
    sessionId: config.sessionId,
    available,
    phase: state.phase,
    errorAction: state.errorAction,
    status: resolveSpeechPresentation(state, null).status,
    preview: preview ? preview.committed + preview.tentative : null,
    level,
    shortcutLabel,
    freezesEditor,
    blocksSubmission,
  };
  const current = useRef({ speech, voiceState });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- publishes committed speech actions and state to the desktop IPC listener
  useEffect(() => {
    current.current = { speech, voiceState };
  });
  const publish = useStableCallback(
    async (voice: typeof voiceState, nextDraft: { text: string; cursor: number } | null) => {
      try {
        await previewBridge?.annotationVoice.update({ ...voice, draft: nextDraft });
      } catch (error) {
        current.current.speech.cancel();
        toastManager.add({
          type: "error",
          title: "Could not update annotation voice input",
          description: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- mirrors every committed voice state change into the preview guest
  useEffect(() => {
    void publish(voiceState, null);
  }, [publish, voiceState]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to gestures the preview guest relays for this session
  useEffect(
    () =>
      previewBridge?.annotationVoice.onEvent(
        (eventTabId, event: DesktopPreviewAnnotationVoiceEvent) => {
          if (eventTabId !== tabId || event.sessionId !== config.sessionId) return;
          draft.current = {
            text: event.text,
            cursor: Math.min(event.cursor, event.text.length),
            selectionEnd: Math.min(event.selectionEnd ?? event.cursor, event.text.length),
          };
          setText(event.text);
          if (event.action === "focus" || event.action === "key" || event.action === "start")
            guestFocused.current = true;
          if (event.action === "blur") guestFocused.current = false;
          const value = current.current.speech;
          switch (event.action) {
            case "focus":
            case "sync":
              void publish(current.current.voiceState, null);
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
              keys.current?.[event.keyboard.type](
                new KeyboardEvent(event.keyboard.type, event.keyboard),
              );
              break;
            }
          }
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
