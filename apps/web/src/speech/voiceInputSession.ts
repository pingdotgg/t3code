import {
  postProcessEnvironmentTranscript,
  VoiceInputController,
  voiceInputBlocksSubmission,
  type VoiceDraftSnapshot,
  type VoiceInputControllerDependencies,
  type VoiceInputErrorCode,
  type VoiceInputState,
} from "@t3tools/client-runtime/voice-input";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import type {
  CloudSpeechModelId,
  CloudSpeechProvider,
  ClientSettings,
  EnvironmentId,
  EnvironmentSpeechStatus,
  SpeechCustomWords,
  SpeechPostProcessingOptions,
  SpeechStreamText,
  SpeechTranscriptionOptions,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS, EnvironmentInternalError } from "@t3tools/contracts";
import { resolveSpeechVocabulary } from "@t3tools/shared/speech";
import * as Schema from "effect/Schema";
import { useEffect, useRef, useSyncExternalStore } from "react";

import { toastManager } from "../components/ui/toast";
import { chooseRecordingMicrophone } from "./browserMicrophones";
import {
  createAppleSpeechVoiceInputPlatform,
  createBrowserVoiceInputPlatform,
} from "./browserVoiceInput";
import { runEnvironmentSpeech } from "./runEnvironmentSpeech";
import { bindAudioGrant, readCleanupGrant } from "./voiceConsent";
import { msg } from "gt-react";
import { m } from "../i18n/messages";

const isEnvironmentInternalError = Schema.is(EnvironmentInternalError);

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
  /** Null is Apple Speech, which transcribes on this Mac without an environment. */
  readonly environmentId: EnvironmentId | null;
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
  private prepared: PreparedConnection | null;
  private readonly controller: VoiceInputController;
  private target: VoiceInputTarget | null = null;
  private pendingSubmission: {
    readonly ownerKey: string;
    readonly submit: (text: string) => void;
    text?: string;
  } | null = null;
  private snapshot: VoiceInputSessionSnapshot = {
    state: IDLE_VOICE_STATE,
    target: null,
    recordingStartedAt: null,
  };
  private activity = SILENT_ACTIVITY;
  private readonly listeners = new Set<() => void>();
  private readonly activityListeners = new Set<() => void>();
  private disposed = false;
  private onSpeechStatus: ((status: EnvironmentSpeechStatus) => void) | undefined;

  constructor(key: SessionKey, prepared: PreparedConnection | null) {
    this.key = key;
    this.prepared = prepared;
    const hasAudioConsent = bindAudioGrant(key.grantId);
    let recordingPreferences:
      | {
          readonly cleanup: SpeechPostProcessingOptions | null;
          readonly cleanupGrant: string | null;
          readonly cleanupPrepared: PreparedConnection | null;
        }
      | undefined;
    const platformInput = {
      hasAudioConsent,
      getStatusListener: () => this.onSpeechStatus,
      getStreamingEnabled: () =>
        this.target?.readContext().clientSettings.speechStreaming ??
        DEFAULT_CLIENT_SETTINGS.speechStreaming,
      getTranscriptionOptions: (): SpeechTranscriptionOptions => {
        const context = this.target?.readContext();
        if (!context) throw new Error(m(msg("Voice input has no draft to record into.")));
        const settings = context.clientSettings;
        const cleanupGrant = context.cleanup ? readCleanupGrant() : null;
        const cleanupEnabled = cleanupGrant !== null;
        const cue = cleanupEnabled && context.cleanupPrepared ? settings.speechCorrectionWord : "";
        const { speechCustomWords, speechHints } = resolveSpeechVocabulary({
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
          ...(speechHints.length > 0 ? { speechHints } : {}),
          speechRemoveFillerWords: settings.speechRemoveFillerWords,
          ...(cue.trim() ? { speechCorrectionWord: cue } : {}),
          speechSilenceFiltering: settings.speechSilenceFiltering,
        };
      },
      getMicrophoneId: chooseRecordingMicrophone,
      onLevel: (level: number) => this.publishActivity({ ...this.activity, level }),
      onDurationLimit: () => void this.controller.stop(),
      onError: (message: string, code?: VoiceInputErrorCode) => {
        if (!this.disposed) void this.controller.interruptRecording(message, null, code);
      },
    };
    const platform = key.environmentId
      ? createBrowserVoiceInputPlatform({
          ...platformInput,
          getPrepared: () => this.prepared,
          cloudProvider: key.cloudProvider,
          cloudModel: key.cloudModel,
          onText: (preview) => {
            if (!this.disposed) this.publishActivity({ ...this.activity, preview });
          },
        })
      : createAppleSpeechVoiceInputPlatform(platformInput);
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
          new Error(m(msg("The draft's environment is unavailable for transcript cleanup."))),
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
      resolve: m,
      retryFailedRecording: true,
      recorder: platform.recorder,
      getTranscriber: () => platform.transcriber,
      requestPermission: async () => ({ granted: true, canAskAgain: true }),
      configureRecording: async () => undefined,
      releaseRecording: async () => platform.cancelRecording(),
      deleteRecording: platform.deleteRecording,
      postProcess,
      onPostProcessingError: (error) => {
        const added = m(msg("The original transcript was added."));
        const detail = isEnvironmentInternalError(error) ? error.detail : undefined;
        toastManager.add({
          type: "warning",
          title: m(msg("Transcript cleanup failed")),
          description: detail ? `${detail} ${added}` : added,
        });
      },
      readDraft: (): VoiceDraftSnapshot | null => {
        const target = this.target;
        const draft = target?.readDraft();
        return target && draft ? { ownerKey: target.ownerKey, ...draft } : null;
      },
      commitDraft: (text, selection) => {
        const ownerKey = this.target?.ownerKey ?? null;
        this.target?.commitDraft(text, selection);
        if (ownerKey !== null && this.pendingSubmission?.ownerKey === ownerKey) {
          this.pendingSubmission.text = text;
        }
      },
      onStateChange: (state) => {
        if (this.disposed) return;
        const recordingStartedAt =
          state.phase !== "recording" ? null : (this.snapshot.recordingStartedAt ?? Date.now());
        this.publish({ ...this.snapshot, state, recordingStartedAt });
        if (state.phase !== "recording" && state.phase !== "transcribing")
          this.publishActivity(SILENT_ACTIVITY);
        if (state.phase === "error") {
          this.pendingSubmission = null;
          return;
        }
        if (state.phase === "idle" && this.pendingSubmission !== null) {
          const pending = this.pendingSubmission;
          this.pendingSubmission = null;
          if (pending.text !== undefined) pending.submit(pending.text);
        }
      },
    });
  }

  get state(): VoiceInputState {
    return this.controller.currentState;
  }

  /** A reconnect to the same destination replaces the transport; null while it is down. */
  updatePrepared(prepared: PreparedConnection | null): void {
    this.prepared = prepared;
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
  start(
    target: VoiceInputTarget,
    onSpeechStatus?: (status: EnvironmentSpeechStatus) => void,
  ): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const busyElsewhere =
      voiceInputBlocksSubmission(this.controller.currentState) &&
      this.target?.ownerKey !== target.ownerKey;
    if (busyElsewhere) return Promise.resolve();
    this.pendingSubmission = null;
    this.target = target;
    this.onSpeechStatus = onSpeechStatus;
    this.publishActivity(SILENT_ACTIVITY);
    this.publish({ ...this.snapshot, target });
    return this.controller.start();
  }

  /** A newly mounted editor for the recording's draft replaces the target that started it. */
  adopt(target: VoiceInputTarget): void {
    if (this.disposed || this.target?.ownerKey !== target.ownerKey) return;
    this.target = target;
    this.publish({ ...this.snapshot, target });
  }

  /** Queues a submission to run once the active dictation commits its transcript. */
  queueSubmission(ownerKey: string, submit: (text: string) => void): boolean {
    if (
      this.disposed ||
      this.target?.ownerKey !== ownerKey ||
      !voiceInputBlocksSubmission(this.controller.currentState) ||
      this.pendingSubmission !== null
    ) {
      return false;
    }
    this.pendingSubmission = { ownerKey, submit };
    if (this.controller.currentState.phase === "recording") {
      void this.controller.stop();
    }
    return true;
  }

  stop(): Promise<void> {
    return this.controller.stop();
  }

  cancel(): void {
    this.pendingSubmission = null;
    this.controller.cancel();
  }

  skipPostProcessing(): void {
    this.controller.skipPostProcessing();
  }

  /** The editor for `ownerKey` now shows another draft; only a persistent target keeps going. */
  ownerChanged(ownerKey: string): void {
    if (this.target?.ownerKey !== ownerKey || this.target.persistent) return;
    this.pendingSubmission = null;
    this.controller.ownerChanged();
  }

  dispose(): void {
    this.disposed = true;
    this.pendingSubmission = null;
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
    session.key.environmentId === key.environmentId &&
    session.key.grantId === key.grantId &&
    session.key.cloudProvider === key.cloudProvider &&
    session.key.cloudModel === key.cloudModel
  );
}

function findSession(key: SessionKey): VoiceInputSession | null {
  for (const session of sessions.keys()) if (sameKey(session, key)) return session;
  return null;
}

/**
 * Every holder of a destination shares one session; the last release disposes it. Offline,
 * a holder joins an existing session but never creates one.
 */
function retainVoiceInputSession(key: SessionKey, prepared: PreparedConnection | null) {
  const session =
    findSession(key) ??
    (prepared || key.environmentId === null ? new VoiceInputSession(key, prepared) : null);
  if (!session) return null;
  session.updatePrepared(prepared);
  sessions.set(session, (sessions.get(session) ?? 0) + 1);
  for (const listener of registryListeners) listener();
  let released = false;
  return {
    session,
    release: () => {
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
    },
  };
}

function subscribeRegistry(listener: () => void): () => void {
  registryListeners.add(listener);
  return () => registryListeners.delete(listener);
}

/**
 * Holds the destination's shared session while mounted; null until it is retained. The
 * session is first retained on a live connection and then survives it dropping for as long
 * as `retainOnDisconnect` holds, so a reconnect resumes the same recording.
 */
export function useRetainedVoiceInputSession(input: {
  readonly environmentId: EnvironmentId | null;
  readonly prepared: PreparedConnection | null;
  readonly grantId: string | null;
  readonly retainOnDisconnect: boolean;
  readonly onDevice?: boolean | undefined;
  readonly cloudProvider?: CloudSpeechProvider | undefined;
  readonly cloudModel?: CloudSpeechModelId | undefined;
}): VoiceInputSession | null {
  const { grantId, cloudProvider, cloudModel } = input;
  const onDevice = input.onDevice === true;
  const environmentId = onDevice ? null : input.environmentId;
  const prepared = onDevice ? null : input.prepared;
  const retain = onDevice || input.retainOnDisconnect;
  const keyed = grantId !== null && (onDevice || environmentId !== null);
  const leaseRef = useRef<ReturnType<typeof retainVoiceInputSession>>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- releases the shared recording session on unmount
  useEffect(
    () => () => {
      leaseRef.current?.release();
      leaseRef.current = null;
    },
    [],
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- acquires, refreshes, or releases the shared recording session as the destination and its transport change
  useEffect(() => {
    const key = keyed && grantId ? { environmentId, grantId, cloudProvider, cloudModel } : null;
    const lease = leaseRef.current;
    if (lease && (!key || !retain || !sameKey(lease.session, key))) {
      lease.release();
      leaseRef.current = null;
    }
    if (leaseRef.current) leaseRef.current.session.updatePrepared(prepared);
    else if (key && retain && typeof navigator !== "undefined")
      leaseRef.current = retainVoiceInputSession(key, prepared);
  }, [keyed, environmentId, grantId, cloudProvider, cloudModel, prepared, retain]);
  return useSyncExternalStore(subscribeRegistry, () =>
    keyed && grantId ? findSession({ environmentId, grantId, cloudProvider, cloudModel }) : null,
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
