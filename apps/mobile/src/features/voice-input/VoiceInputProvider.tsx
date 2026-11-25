import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { useAtomValue } from "@effect/atom-react";
import { AudioModule, RecordingPresets, type RecordingStatus } from "expo-audio";
import { File } from "expo-file-system";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { useSyncExternalStore } from "react";
import { AppState, Platform } from "react-native";
import { Effect } from "effect";
import { Atom, AtomRegistry, AsyncResult } from "effect/reactivity";
import { makeMutable } from "react-native-reanimated";

import {
  type MicrophoneEntry,
  microphoneOrder,
  preferredMicrophoneInput,
  rememberMicrophones,
} from "../../lib/microphonePriority";
import { getLocalVoiceTranscriber } from "../../native/voiceTranscription";
import { createVoiceRecorder } from "../../native/voiceRecorder";
import { mobilePreferencesAtom, saveMobilePreferences } from "../../state/preferences";
import { getNativeShowcaseScene } from "../showcase/nativeShowcaseScene";
import {
  voiceInputBlocksSubmission,
  type VoiceTranscriber,
} from "@t3tools/client-runtime/voice-input";
import { createLazyVoiceRecorder } from "./lazyVoiceRecorder";
import { VOICE_WAVEFORM_SAMPLE_COUNT } from "./voiceInputMetering";
import { createVoiceInputTarget, VoiceInputSession } from "./voiceInputSession";
import { createVoiceRecordingPermission } from "./voiceRecordingPermission";
import {
  clearPendingVoiceRecording,
  clearPendingVoiceRecordingForUri,
  readPendingVoiceRecording,
  writePendingVoiceRecording,
} from "./pendingVoiceRecording";
import {
  hasExplicitVoiceGrantChoice,
  voiceGrantAtom,
  voiceRouteAtom,
  waitForVoiceGrantLoaded,
} from "./voiceDestination";
import { isNewTaskDraftKey } from "../../state/new-task-draft-key";
import {
  getComposerDraftSnapshot,
  rememberComposerDraftSelection,
  setComposerDraftText,
  updateComposerDraftSettings,
  waitForComposerDraftsLoaded,
} from "../../state/use-composer-drafts";
import { makePermissionStatusAtom } from "../../lib/permissionStatusAtom";
import {
  acquireAudioSession,
  activateAudioSession,
  releaseAudioSession,
} from "../../lib/audioSession";

// The native constructor expects platform-flattened options, as built by useAudioRecorder.
const { ios: IOS_RECORDING_OPTIONS, android: ANDROID_RECORDING_OPTIONS } =
  RecordingPresets.HIGH_QUALITY;
const VOICE_RECORDING_OPTIONS = {
  extension: RecordingPresets.HIGH_QUALITY.extension,
  sampleRate: RecordingPresets.HIGH_QUALITY.sampleRate,
  numberOfChannels: RecordingPresets.HIGH_QUALITY.numberOfChannels,
  bitRate: RecordingPresets.HIGH_QUALITY.bitRate,
  isMeteringEnabled: true,
  ...(Platform.OS === "ios" ? IOS_RECORDING_OPTIONS : ANDROID_RECORDING_OPTIONS),
};

function keepScreenAwake(tag: string): () => void {
  const activation = activateKeepAwakeAsync(tag);
  void activation.catch(() => {});
  // Release after activation settles, even if the recording ends immediately.
  return () => void activation.then(() => deactivateKeepAwake(tag)).catch(() => {});
}

export const deviceMicrophoneOrder = (saved?: ReadonlyArray<MicrophoneEntry>) =>
  microphoneOrder(saved, Platform.OS === "android" ? "android" : "ios");

/** "checking" until the first availability probe settles; re-probed on foreground. */
export const localVoiceTranscriberAtom = makePermissionStatusAtom<
  VoiceTranscriber | null | "checking"
>({
  label: "mobile:voice-input:transcriber",
  initial: "checking",
  read: () => getLocalVoiceTranscriber().catch(() => null),
}).pipe(Atom.keepAlive);

const voiceInputAvailableAtom = Atom.make((get) => {
  const route = get(voiceRouteAtom);
  if (route) return route.transcriber !== null;
  const transcriber = get(localVoiceTranscriberAtom);
  return transcriber !== null && transcriber !== "checking";
});

const TRANSCRIBER_RECONNECT_TIMEOUT_MS = 10_000;

function readCurrentTranscriber(registry: AtomRegistry.AtomRegistry): VoiceTranscriber | null {
  const route = registry.get(voiceRouteAtom);
  if (route) return route.transcriber;
  const transcriber = registry.get(localVoiceTranscriberAtom);
  return transcriber === "checking" ? null : transcriber;
}

function waitForTranscriber(
  registry: AtomRegistry.AtomRegistry,
  signal: AbortSignal,
): Promise<VoiceTranscriber | null> {
  const immediate = readCurrentTranscriber(registry);
  if (immediate || signal.aborted) return Promise.resolve(immediate);
  const initialRoute = registry.get(voiceRouteAtom);
  if (initialRoute === null && registry.get(localVoiceTranscriberAtom) !== "checking") {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: VoiceTranscriber | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      unsubscribeRoute();
      unsubscribeLocal();
      resolve(value);
    };
    const onAbort = () => finish(null);
    const check = () => {
      const route = registry.get(voiceRouteAtom);
      if (route) {
        if (route.transcriber) finish(route.transcriber);
        return;
      }
      const local = registry.get(localVoiceTranscriberAtom);
      if (local !== "checking") finish(local);
    };
    const unsubscribeRoute = registry.subscribe(voiceRouteAtom, check);
    const unsubscribeLocal = registry.subscribe(localVoiceTranscriberAtom, check);
    const timeout = setTimeout(
      () => finish(readCurrentTranscriber(registry)),
      TRANSCRIBER_RECONNECT_TIMEOUT_MS,
    );
    signal.addEventListener("abort", onAbort, { once: true });
    check();
  });
}

/**
 * The app has one microphone and one dictation at a time, so the session
 * lives for the registry's lifetime rather than any screen's.
 */
export const voiceInputAtom = Atom.make((get) => {
  const registry = get.registry;
  // Mounted so the recorder can read known microphones synchronously.
  get.mount(mobilePreferencesAtom);
  const audioLevels = makeMutable<ReadonlyArray<number>>(
    Array<number>(VOICE_WAVEFORM_SAMPLE_COUNT).fill(0),
  );
  let keepAwakeSequence = 0;
  let audioToken: ReturnType<typeof acquireAudioSession> | null = null;
  let recordingMicrophoneOrder: ReadonlyArray<MicrophoneEntry> | null = null;
  const recoveryAbort = new AbortController();
  const permission = createVoiceRecordingPermission(
    () => {
      void session.controller.appMovedToBackground();
    },
    () => {
      session.controller.appReturnedToForeground();
    },
  );
  const recorder = createLazyVoiceRecorder({
    getDestination: () => (registry.get(voiceRouteAtom) === null ? "local" : "environment"),
    create: (destination) =>
      destination === "local"
        ? createVoiceRecorder(VOICE_RECORDING_OPTIONS)
        : new AudioModule.AudioRecorder(VOICE_RECORDING_OPTIONS),
    onStatus: (status: RecordingStatus) => {
      session.controller.handleRecorderStatus({
        isFinished: status.isFinished,
        hasError: status.hasError || status.mediaServicesDidReset === true,
        error: status.error,
        url: status.url,
      });
    },
    selectInput: (inputs) => {
      const known = recordingMicrophoneOrder;
      if (!known) return null;
      const order = rememberMicrophones(known, inputs);
      if (order !== known) {
        void runAtomCommand(registry, saveMobilePreferences, {
          transform: (current) => ({
            microphones: rememberMicrophones(deviceMicrophoneOrder(current.microphones), inputs),
          }),
        });
      }
      return preferredMicrophoneInput(inputs, order);
    },
  });
  const session: VoiceInputSession = new VoiceInputSession({
    recorder,
    retryFailedRecording: true,
    canRetryRecording: (uri) => !uri.endsWith(".pcm"),
    isInBackground: () => AppState.currentState === "background",
    getTranscriber: () => readCurrentTranscriber(registry),
    waitForTranscriber: (signal) => waitForTranscriber(registry, signal),
    onPendingRecordingChange: (pending) => {
      if (!pending) {
        writePendingVoiceRecording(null);
        return;
      }
      // Raw PCM captures on Android only run live in-process; encoded files survive restarts.
      if (!session.persistent || pending.uri.endsWith(".pcm")) return;
      const project = isNewTaskDraftKey(pending.draft.ownerKey)
        ? getComposerDraftSnapshot(pending.draft.ownerKey).project
        : undefined;
      writePendingVoiceRecording({
        uri: pending.uri,
        ownerKey: pending.draft.ownerKey,
        label: session.label,
        startText: pending.draft.text,
        selection: pending.draft.selection,
        grantId: registry.get(voiceGrantAtom)?.id ?? null,
        recordedAt: Date.now(),
        ...(project ? { project } : {}),
      });
    },
    requestPermission: permission.requestPermission,
    configureRecording: async () => {
      const token = acquireAudioSession("recording");
      audioToken = token;
      try {
        const current = registry.get(mobilePreferencesAtom);
        const preferences = AsyncResult.isSuccess(current)
          ? current.value
          : await Effect.runPromise(
              AtomRegistry.getResult(registry, mobilePreferencesAtom).pipe(
                Effect.orElseSucceed(() => null),
              ),
            );
        recordingMicrophoneOrder = preferences
          ? deviceMicrophoneOrder(preferences.microphones)
          : null;
        const builtInMicFirst =
          Platform.OS === "ios" && recordingMicrophoneOrder?.[0]?.kind === "builtIn";
        await activateAudioSession(token, { allowBluetoothRecording: !builtInMicFirst });
      } catch (error) {
        await releaseAudioSession(token).catch(() => {});
        throw error;
      }
    },
    releaseRecording: async () => {
      if (audioToken) await releaseAudioSession(audioToken);
      audioToken = null;
    },
    deleteRecording: (uri) => new File(uri).delete(),
    sampleRecording: () => {
      const status = recorder.getStatus();
      return status?.isRecording
        ? { durationMillis: status.durationMillis, metering: status.metering }
        : null;
    },
    publishAudioLevels: (levels) => audioLevels.set(levels),
    keepAwake: () => keepScreenAwake(`voice-input:${++keepAwakeSequence}`),
  });
  let previousGrantId = registry.get(voiceGrantAtom)?.id ?? null;
  get.subscribe(voiceGrantAtom, (grant) => {
    const nextGrantId = grant?.id ?? null;
    if (nextGrantId === previousGrantId) return;
    previousGrantId = nextGrantId;
    if (!hasExplicitVoiceGrantChoice(registry)) {
      if (session.controller.currentState.phase !== "idle") session.controller.cancel();
      return;
    }
    recoveryAbort.abort();
    session.controller.cancel();
    clearPendingVoiceRecording(true);
  });
  get.subscribe(voiceRouteAtom, (route) => {
    if (route !== null && route.transcriber === null) {
      const phase = session.controller.currentState.phase;
      if (phase === "preparing") session.controller.cancel();
      else if (phase === "recording") void session.controller.stop();
    }
  });
  const pending = readPendingVoiceRecording();
  if (pending) {
    void (async () => {
      const signal = recoveryAbort.signal;
      const grant = await waitForVoiceGrantLoaded(registry);
      if (signal.aborted) return;
      if ((grant?.id ?? null) !== pending.grantId) {
        clearPendingVoiceRecording(true);
        return;
      }
      await waitForComposerDraftsLoaded();
      if (signal.aborted) return;
      const ownerKey = pending.ownerKey;
      const currentDraft = getComposerDraftSnapshot(ownerKey);
      const newTaskProject = isNewTaskDraftKey(ownerKey)
        ? (currentDraft.project ?? pending.project)
        : undefined;
      if (
        currentDraft.text !== pending.startText ||
        (isNewTaskDraftKey(ownerKey) && !newTaskProject)
      ) {
        clearPendingVoiceRecordingForUri(pending.uri, true);
        return;
      }
      if (session.controller.currentState.phase !== "idle") {
        clearPendingVoiceRecordingForUri(pending.uri, true);
        return;
      }
      await session.recover(
        {
          ...createVoiceInputTarget(
            ownerKey,
            () => getComposerDraftSnapshot(ownerKey).text,
            (text, selection) => {
              if (newTaskProject && !getComposerDraftSnapshot(ownerKey).project) {
                updateComposerDraftSettings(ownerKey, { project: newTaskProject });
              }
              setComposerDraftText(ownerKey, text);
              rememberComposerDraftSelection(ownerKey, text, selection);
            },
            pending.selection,
          ),
          ...(pending.label !== null ? { label: pending.label } : {}),
          persistent: true,
        },
        pending.uri,
      );
    })().catch(() => {});
  }
  get.addFinalizer(() => {
    recoveryAbort.abort();
    permission.dispose();
    session.dispose();
    recorder.release();
  });
  return { session, audioLevels };
}).pipe(Atom.keepAlive, Atom.withLabel("mobile:voice-input"));

export function useGlobalVoiceInput() {
  const { session, audioLevels } = useAtomValue(voiceInputAtom);
  const isTranscriberAvailable = useAtomValue(voiceInputAvailableAtom);
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot);
  return {
    ...snapshot,
    isAvailable: isTranscriberAvailable || getNativeShowcaseScene() !== null,
    audioLevels,
    isBusy: voiceInputBlocksSubmission(snapshot.state),
    session,
    stop: () => session.controller.stop(),
    cancel: () => session.controller.cancel(),
  };
}
