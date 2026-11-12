import {
  postProcessEnvironmentTranscript,
  VoiceInputController,
  voiceInputBlocksSubmission,
  type VoiceDraftSnapshot,
  type VoiceInputControllerDependencies,
  type VoiceInputState,
} from "@t3tools/client-runtime/voice-input";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import type {
  CloudSpeechModelId,
  CloudSpeechProvider,
  ClientSettings,
  EnvironmentId,
  SpeechCustomWords,
  SpeechPostProcessingOptions,
  SpeechStreamText,
  SpeechTranscriptionOptions,
} from "@t3tools/contracts";
import { resolveSpeechVocabulary } from "@t3tools/shared/speech";
import { useEffect, useSyncExternalStore } from "react";

import { toastManager } from "../components/ui/toast";
import { chooseRecordingMicrophone } from "./browserMicrophones";
import { createBrowserVoiceInputPlatform } from "./browserVoiceInput";
import { runEnvironmentSpeech } from "./runEnvironmentSpeech";
import { bindAudioGrant, readCleanupGrant } from "./voiceConsent";

export const IDLE_VOICE_STATE: VoiceInputState = { phase: "idle", error: null, errorAction: null };

type DraftInput = {
  readonly text: string;
  readonly selection: { readonly start: number; readonly end: number };
};

/** What a recording needs from its editor, read once when it starts. */
export type VoiceRecordingContext = {
  readonly environmentId: EnvironmentId;
  readonly projectName: string | null;
  readonly projectWords: SpeechCustomWords;
  readonly clientSettings: ClientSettings;
  readonly cleanup: boolean;
  readonly cleanupPrepared: PreparedConnection | null;
};

export type VoiceInputTarget = {
  readonly ownerKey: string;
  /** Names the draft in the indicator shown while its editor is off screen. */
  readonly label: string | null;
  /** A target that can outlive its editor (a thread draft) keeps recording when the owner changes. */
  readonly persistent: boolean;
  readonly open: (() => void) | null;
  readonly readDraft: () => DraftInput | null;
  readonly commitDraft: (text: string, selection: DraftInput["selection"]) => void;
  readonly readContext: () => VoiceRecordingContext;
};

export type VoiceInputSessionSnapshot = {
  readonly state: VoiceInputState;
  readonly target: VoiceInputTarget | null;
  /** Wall-clock start of the current recording, so every view shows the same elapsed time. */
  readonly recordingStartedAt: number | null;
};

export type VoiceInputSessionActivity = {
  readonly level: number;
  readonly preview: SpeechStreamText | null;
};

type SessionKey = {
  readonly prepared: PreparedConnection;
  readonly grantId: string;
  readonly cloudProvider: CloudSpeechProvider | undefined;
  readonly cloudModel: CloudSpeechModelId | undefined;
};

const SILENT_ACTIVITY: VoiceInputSessionActivity = { level: 0, preview: null };

function cleanupContext({ text, selection }: DraftInput): DraftInput {
  const limit = 1_024;
  const start = Math.max(0, Math.min(selection.start, text.length));
  const end = Math.max(start, Math.min(selection.end, text.length));
  const before = text.slice(Math.max(0, start - limit), start);
  const selected = text.slice(start, Math.min(end, start + limit));
  return {
    text: before + selected + text.slice(end, end + limit),
    selection: { start: before.length, end: before.length + selected.length },
  };
}

/**
 * The browser has one microphone, so every editor shares one dictation per destination. The
 * recording belongs to the target that started it, not to whichever editor is mounted now.
 */
export class VoiceInputSession {
  readonly key: SessionKey;
  private readonly controller: VoiceInputController;
  private target: VoiceInputTarget | null = null;
  private snapshot: VoiceInputSessionSnapshot = {
    state: IDLE_VOICE_STATE,
    target: null,
    recordingStartedAt: null,
  };
  private activity = SILENT_ACTIVITY;
  private readonly listeners = new Set<() => void>();
  private readonly activityListeners = new Set<() => void>();
  private disposed = false;

  constructor(key: SessionKey) {
    this.key = key;
    const hasAudioConsent = bindAudioGrant(key.grantId);
    let recordingPreferences:
      | {
          readonly cleanup: SpeechPostProcessingOptions | null;
          readonly cleanupGrant: string | null;
          readonly cleanupPrepared: PreparedConnection | null;
        }
      | undefined;
    const platform = createBrowserVoiceInputPlatform({
      prepared: key.prepared,
      cloudProvider: key.cloudProvider,
      cloudModel: key.cloudModel,
      hasAudioConsent,
      getTranscriptionOptions: (): SpeechTranscriptionOptions => {
        const context = this.target?.readContext();
        if (!context) throw new Error("Voice input has no draft to record into.");
        const settings = context.clientSettings;
        const cleanupGrant = context.cleanup ? readCleanupGrant() : null;
        const cleanupEnabled = cleanupGrant !== null;
        const cue = cleanupEnabled && context.cleanupPrepared ? settings.speechCorrectionWord : "";
        const speechCustomWords = resolveSpeechVocabulary({
          personal: settings.speechCustomWords,
          project: context.projectWords,
          hints: [cue, context.projectName ?? ""],
        });
        recordingPreferences = {
          cleanupGrant,
          cleanupPrepared: context.cleanupPrepared,
          cleanup: cleanupEnabled
            ? {
                speechCustomWords,
                speechPostProcessingPrompt: settings.speechPostProcessingPrompt,
                ...(cue.trim() ? { speechCorrectionWord: cue } : {}),
              }
            : null,
        };
        return {
          speechLanguage: settings.speechLanguage,
          speechTranslateToEnglish: settings.speechTranslateToEnglish,
          speechCustomWords,
          speechRemoveFillerWords: settings.speechRemoveFillerWords,
          ...(cue.trim() ? { speechCorrectionWord: cue } : {}),
          speechSilenceFiltering: settings.speechSilenceFiltering,
        };
      },
      getMicrophoneId: chooseRecordingMicrophone,
      onLevel: (level) => this.publishActivity({ ...this.activity, level }),
      onDurationLimit: () => void this.controller.stop(),
      onText: (preview) => {
        if (!this.disposed) this.publishActivity({ ...this.activity, preview });
      },
      onError: (message) => {
        if (!this.disposed) void this.controller.interruptRecording(message);
      },
    });
    const postProcess: NonNullable<VoiceInputControllerDependencies["postProcess"]> = (
      transcript,
      options,
    ) => {
      const preferences = recordingPreferences;
      if (
        !preferences?.cleanup ||
        !hasAudioConsent() ||
        preferences.cleanupGrant !== readCleanupGrant() ||
        this.target?.ownerKey !== options.draft.ownerKey
      )
        return null;
      if (!preferences.cleanupPrepared)
        return Promise.reject(
          new Error("The draft's environment is unavailable for transcript cleanup."),
        );
      return runEnvironmentSpeech(
        postProcessEnvironmentTranscript(
          preferences.cleanupPrepared,
          transcript,
          cleanupContext(options.draft),
          preferences.cleanup,
          () => hasAudioConsent() && preferences.cleanupGrant === readCleanupGrant(),
        ),
        options,
      ).then((result) => result.text);
    };
    this.controller = new VoiceInputController({
      retryFailedRecording: true,
      recorder: platform.recorder,
      getTranscriber: () => platform.transcriber,
      requestPermission: async () => ({ granted: true, canAskAgain: true }),
      configureRecording: async () => undefined,
      releaseRecording: async () => platform.cancelRecording(),
      deleteRecording: platform.deleteRecording,
      postProcess,
      onPostProcessingError: () =>
        toastManager.add({
          type: "warning",
          title: "Transcript cleanup failed",
          description: "The original transcript was added.",
        }),
      readDraft: (): VoiceDraftSnapshot | null => {
        const target = this.target;
        const draft = target?.readDraft();
        return target && draft ? { ownerKey: target.ownerKey, ...draft } : null;
      },
      commitDraft: (text, selection) => this.target?.commitDraft(text, selection),
      onStateChange: (state) => {
        if (this.disposed) return;
        const recordingStartedAt =
          state.phase !== "recording" ? null : (this.snapshot.recordingStartedAt ?? Date.now());
        this.publish({ ...this.snapshot, state, recordingStartedAt });
        if (state.phase !== "recording" && state.phase !== "transcribing")
          this.publishActivity(SILENT_ACTIVITY);
      },
    });
  }

  get state(): VoiceInputState {
    return this.controller.currentState;
  }

  get ownerKey(): string | null {
    return this.target?.ownerKey ?? null;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): VoiceInputSessionSnapshot => this.snapshot;

  readonly subscribeActivity = (listener: () => void): (() => void) => {
    this.activityListeners.add(listener);
    return () => this.activityListeners.delete(listener);
  };

  readonly getActivity = (): VoiceInputSessionActivity => this.activity;

  /** Starts recording into `target`, or does nothing while another draft holds the microphone. */
  start(target: VoiceInputTarget): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const busyElsewhere =
      voiceInputBlocksSubmission(this.controller.currentState) &&
      this.target?.ownerKey !== target.ownerKey;
    if (busyElsewhere) return Promise.resolve();
    this.target = target;
    this.publishActivity(SILENT_ACTIVITY);
    this.publish({ ...this.snapshot, target });
    return this.controller.start();
  }

  stop(): Promise<void> {
    return this.controller.stop();
  }

  cancel(): void {
    this.controller.cancel();
  }

  skipPostProcessing(): void {
    this.controller.skipPostProcessing();
  }

  /** The editor for `ownerKey` now shows another draft; only a persistent target keeps going. */
  ownerChanged(ownerKey: string): void {
    if (this.target?.ownerKey !== ownerKey || this.target.persistent) return;
    this.controller.ownerChanged();
  }

  dispose(): void {
    this.disposed = true;
    this.controller.dispose();
    this.listeners.clear();
    this.activityListeners.clear();
  }

  private publish(snapshot: VoiceInputSessionSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }

  private publishActivity(activity: VoiceInputSessionActivity): void {
    if (activity.level === this.activity.level && activity.preview === this.activity.preview)
      return;
    this.activity = activity;
    for (const listener of this.activityListeners) listener();
  }
}

const sessions = new Map<VoiceInputSession, number>();
const registryListeners = new Set<() => void>();

function sameKey(session: VoiceInputSession, key: SessionKey): boolean {
  return (
    session.key.prepared === key.prepared &&
    session.key.grantId === key.grantId &&
    session.key.cloudProvider === key.cloudProvider &&
    session.key.cloudModel === key.cloudModel
  );
}

function findSession(key: SessionKey): VoiceInputSession | null {
  for (const session of sessions.keys()) if (sameKey(session, key)) return session;
  return null;
}

/** Every holder of a destination shares one session; the last release disposes it. */
function retainVoiceInputSession(key: SessionKey): () => void {
  const session = findSession(key) ?? new VoiceInputSession(key);
  sessions.set(session, (sessions.get(session) ?? 0) + 1);
  for (const listener of registryListeners) listener();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const count = (sessions.get(session) ?? 1) - 1;
    if (count > 0) {
      sessions.set(session, count);
      return;
    }
    sessions.delete(session);
    session.dispose();
    for (const listener of registryListeners) listener();
  };
}

function subscribeRegistry(listener: () => void): () => void {
  registryListeners.add(listener);
  return () => registryListeners.delete(listener);
}

/** Holds the destination's shared session while mounted; null until it is retained. */
export function useRetainedVoiceInputSession(input: {
  readonly prepared: PreparedConnection | null;
  readonly grantId: string | null;
  readonly cloudProvider?: CloudSpeechProvider | undefined;
  readonly cloudModel?: CloudSpeechModelId | undefined;
}): VoiceInputSession | null {
  const { prepared, grantId, cloudProvider, cloudModel } = input;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- retains the shared recording session for this destination while mounted
  useEffect(() => {
    if (!prepared || !grantId || typeof navigator === "undefined") return;
    return retainVoiceInputSession({ prepared, grantId, cloudProvider, cloudModel });
  }, [prepared, grantId, cloudProvider, cloudModel]);
  return useSyncExternalStore(subscribeRegistry, () =>
    prepared && grantId ? findSession({ prepared, grantId, cloudProvider, cloudModel }) : null,
  );
}

const IDLE_SNAPSHOT: VoiceInputSessionSnapshot = {
  state: IDLE_VOICE_STATE,
  target: null,
  recordingStartedAt: null,
};
const noSubscription = () => () => {};

export function useVoiceInputSessionSnapshot(
  session: VoiceInputSession | null,
): VoiceInputSessionSnapshot {
  return useSyncExternalStore(
    session?.subscribe ?? noSubscription,
    session ? session.getSnapshot : () => IDLE_SNAPSHOT,
  );
}

export function useVoiceInputSessionActivity(
  session: VoiceInputSession | null,
  ownerKey: string | null,
): VoiceInputSessionActivity {
  // Activity changes many times a second, so only the owning editor reads it.
  const owns = useSyncExternalStore(
    session?.subscribe ?? noSubscription,
    () => session !== null && ownerKey !== null && session.ownerKey === ownerKey,
  );
  return useSyncExternalStore(owns && session ? session.subscribeActivity : noSubscription, () =>
    owns && session ? session.getActivity() : SILENT_ACTIVITY,
  );
}

// Editors register the owner they show, so the indicator appears only while its draft is off screen.
const presentedOwners = new Map<string, number>();
const presentationListeners = new Set<() => void>();

export function presentVoiceOwner(ownerKey: string): () => void {
  presentedOwners.set(ownerKey, (presentedOwners.get(ownerKey) ?? 0) + 1);
  for (const listener of presentationListeners) listener();
  return () => {
    const count = (presentedOwners.get(ownerKey) ?? 1) - 1;
    if (count > 0) presentedOwners.set(ownerKey, count);
    else presentedOwners.delete(ownerKey);
    for (const listener of presentationListeners) listener();
  };
}

function subscribePresentation(listener: () => void): () => void {
  presentationListeners.add(listener);
  return () => presentationListeners.delete(listener);
}

export function useVoiceOwnerPresented(ownerKey: string | null): boolean {
  return useSyncExternalStore(
    subscribePresentation,
    () => ownerKey !== null && presentedOwners.has(ownerKey),
  );
}
