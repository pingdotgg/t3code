import type {
  VoiceModePhase,
  VoiceModeState,
  VoiceSessionTarget,
} from "@t3tools/client-runtime/voice-mode";
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { Alert } from "react-native";

import { voiceMode } from "./voiceMode";
import { resolveVoiceModeNotice } from "./voiceModePresentation";

export function useVoiceModeState(): VoiceModeState {
  return useSyncExternalStore(voiceMode.subscribe, voiceMode.getState);
}

/** This thread's conversation phase. A primitive, so captions do not re-render the caller. */
export function useVoiceModePhase(target: VoiceSessionTarget): VoiceModePhase {
  const { environmentId, threadId } = target;
  const getSnapshot = useCallback(
    () =>
      voiceMode.isActiveFor({ environmentId, threadId }) ? voiceMode.getState().phase : "idle",
    [environmentId, threadId],
  );
  return useSyncExternalStore(voiceMode.subscribe, getSnapshot);
}

/**
 * Ties a conversation to the screen showing its thread: leaving the thread
 * ends it. Screens pushed over the thread (files, review, settings) keep it
 * running, like a call; its controls return with the thread.
 * Also reports failures and remote endings for this thread, once.
 */
export function useVoiceModeThreadLifecycle(target: VoiceSessionTarget): void {
  const { environmentId, threadId } = target;

  useEffect(
    () => () => {
      if (voiceMode.isActiveFor({ environmentId, threadId })) voiceMode.stop();
    },
    [environmentId, threadId],
  );

  useEffect(() => {
    // Reads the live state: dismissing notifies listeners re-entrantly, so a
    // listener's argument can already be stale.
    const report = () => {
      const state = voiceMode.getState();
      if (state.target?.environmentId !== environmentId || state.target.threadId !== threadId) {
        return;
      }
      const notice = resolveVoiceModeNotice(state);
      if (!notice) return;
      voiceMode.dismiss();
      Alert.alert(notice.title, notice.message);
    };
    report();
    return voiceMode.subscribe(report);
  }, [environmentId, threadId]);
}
