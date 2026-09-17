import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  setIsAudioActiveAsync,
  useAudioRecorder,
  type RecordingStatus,
} from "expo-audio";
import { File } from "expo-file-system";
import { createContext, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { AppState, Platform } from "react-native";
import { getLocalVoiceTranscriber } from "../../native/voiceTranscription";
import { appAtomRegistry } from "../../state/atom-registry";
import {
  composerDraftsAtom,
  getComposerDraftSnapshot,
  setComposerDraftText,
} from "../../state/use-composer-drafts";
import { VoiceInputSession } from "./voiceInputSession";

export const VoiceInputSessionContext = createContext<{
  session: VoiceInputSession;
  recorder: ReturnType<typeof useAudioRecorder>;
} | null>(null);

async function releaseVoiceRecordingAudio(): Promise<void> {
  try {
    await setAudioModeAsync({
      allowsRecording: false,
      allowsBackgroundRecording: false,
      shouldPlayInBackground: false,
    });
  } finally {
    // Expo does not deactivate AVAudioSession when recording stops or its
    // category changes. Explicit deactivation resumes interrupted app audio.
    await setIsAudioActiveAsync(false);
  }
}

async function configureVoiceRecordingAudio(): Promise<void> {
  try {
    await setAudioModeAsync({
      allowsRecording: true,
      interruptionMode: "doNotMix",
      playsInSilentMode: true,
      shouldPlayInBackground: Platform.OS === "ios",
      allowsBackgroundRecording: Platform.OS === "ios",
    });
    await setIsAudioActiveAsync(true);
  } catch (error) {
    try {
      await releaseVoiceRecordingAudio();
    } catch {
      // Keep the setup error. The controller has not started a recorder yet.
    }
    throw error;
  }
}

/** Keep the native recorder alive while navigation mounts and releases composers. */
export function VoiceInputProvider({ children }: { children: ReactNode }) {
  const sessionRef = useRef<VoiceInputSession | null>(null);
  const handleStatus = useCallback((status: RecordingStatus) => {
    void sessionRef.current?.controller.handleRecorderStatus({
      isFinished: status.isFinished,
      hasError: status.hasError || status.mediaServicesDidReset === true,
      error: status.error,
      url: status.url,
    });
  }, []);
  const recorder = useAudioRecorder(
    { ...RecordingPresets.HIGH_QUALITY, isMeteringEnabled: true },
    handleStatus,
  );
  const [value] = useState(() => {
    const session = new VoiceInputSession({
      recorder,
      getTranscriber: getLocalVoiceTranscriber,
      requestPermission: async () => {
        const permission = await requestRecordingPermissionsAsync();
        return { granted: permission.granted, canAskAgain: permission.canAskAgain };
      },
      configureRecording: configureVoiceRecordingAudio,
      releaseRecording: releaseVoiceRecordingAudio,
      deleteRecording: (uri) => new File(uri).delete(),
      readText: (ownerKey) => getComposerDraftSnapshot(ownerKey).text,
      writeText: setComposerDraftText,
    });
    return { session, recorder };
  });
  useEffect(() => {
    sessionRef.current = value.session;
    const unsubscribe = appAtomRegistry.subscribe(composerDraftsAtom, () =>
      value.session.draftChanged(),
    );
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "background") return;
      void value.session.controller.appMovedToBackground();
      if (Platform.OS !== "ios") void value.session.controller.interruptRecording();
    });
    return () => {
      unsubscribe();
      subscription.remove();
      value.session.controller.dispose();
    };
  }, [value]);
  return (
    <VoiceInputSessionContext.Provider value={value}>{children}</VoiceInputSessionContext.Provider>
  );
}
