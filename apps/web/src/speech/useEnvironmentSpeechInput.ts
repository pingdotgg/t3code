import {
  cancelEnvironmentSpeechModelDownload,
  downloadEnvironmentSpeechModel,
  getEnvironmentSpeechModels,
  getEnvironmentSpeechStatus,
  postProcessEnvironmentTranscript,
  selectEnvironmentSpeechModel,
  VoiceInputController,
  voiceInputBlocksSubmission,
  type VoiceDraftSnapshot,
  type VoiceInputControllerDependencies,
  type VoiceInputState,
} from "@t3tools/client-runtime/voice-input";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import { AuthOrchestrationOperateScope, CLOUD_SPEECH_LABELS } from "@t3tools/contracts";
import type {
  EnvironmentId,
  EnvironmentSpeechModel,
  EnvironmentSpeechStatus,
  ProjectId,
  SpeechPostProcessingOptions,
  SpeechStreamText,
  SpeechTranscriptionOptions,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { chooseSetupSpeechModel, resolveSpeechVocabulary } from "@t3tools/shared/speech";
import { useNavigate } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { useStableCallback } from "~/hooks/useStableCallback";
import { toastManager } from "../components/ui/toast";
import {
  useClientSettings,
  useClientSettingsHydrated,
  useEnvironmentSettings,
} from "../hooks/useSettings";
import { useEnvironment } from "../state/environments";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentSession, useEnvironmentScope, usePreparedConnection } from "../state/session";
import { createBrowserVoiceInputPlatform } from "./browserVoiceInput";
import { preferredSpeechLanguages } from "./preferredSpeechLanguages";
import { runEnvironmentSpeech } from "./runEnvironmentSpeech";
import {
  bindAudioGrant,
  readCleanupGrant,
  subscribeVoiceConsent,
  useAudioChoice,
} from "./voiceConsent";

const INITIAL_STATE: VoiceInputState = { phase: "idle", error: null, errorAction: null };
const WAITING_STATE: VoiceInputState = { phase: "preparing", error: null, errorAction: null };
const INITIAL_SETUP = {
  open: false,
  step: 0,
  model: null as EnvironmentSpeechModel | null,
  language: null as string | null,
  downloading: false,
  catalogFailed: false,
  error: null as string | null,
};

// Every mounted editor shares one status probe per destination; starting a recording refreshes it.
const statusProbes = new WeakMap<PreparedConnection, Promise<EnvironmentSpeechStatus>>();
function probeSpeechStatus(prepared: PreparedConnection, refresh = false) {
  const cached = refresh ? undefined : statusProbes.get(prepared);
  if (cached) return cached;
  const probe = runEnvironmentSpeech(getEnvironmentSpeechStatus(prepared));
  statusProbes.set(prepared, probe);
  probe.catch(() => {
    if (statusProbes.get(prepared) === probe) statusProbes.delete(prepared);
  });
  return probe;
}

type DraftInput = {
  readonly text: string;
  readonly selection: { readonly start: number; readonly end: number };
};

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

type SubmissionDraft = {
  readonly readDraft: () => DraftInput | null;
  readonly commitDraft: HookInput["commitDraft"];
};

type HookInput = {
  /** The draft's own environment. Optional transcript cleanup runs there, never on the audio destination. */
  readonly environmentId: EnvironmentId;
  /** The draft's project: its vocabulary on that environment and its name become recognition hints. */
  readonly projectId?: ProjectId | null | undefined;
  readonly projectName?: string | null | undefined;
  readonly ownerKey: string;
  readonly draftText: string;
  readonly disabled?: boolean | undefined;
  /**
   * Until a destination is chosen, voice input is offered and its first gesture opens Voice
   * settings. False hides it instead, for editors whose draft would not survive the navigation.
   */
  readonly offerSetup?: boolean | undefined;
  /** False keeps the transcript off the cleanup provider even when cleanup is on; the model test uses it. */
  readonly cleanup?: boolean | undefined;
  /** Binds a confirmed send to a draft that can be reached after this editor leaves. */
  readonly captureSubmissionDraft?: (() => SubmissionDraft) | undefined;
  readonly readDraft: () => DraftInput;
  readonly commitDraft: (
    text: string,
    selection: { readonly start: number; readonly end: number },
  ) => void;
};

type PendingSubmission = {
  readonly environmentId: EnvironmentId;
  readonly ownerKey: string;
  readonly submit: (text: string) => void;
  readonly cancel?: (() => void) | undefined;
  readonly draft?: SubmissionDraft | undefined;
  readonly snapshot?: VoiceDraftSnapshot | undefined;
  text?: string;
};

type ConfirmedSubmission = {
  readonly pending: PendingSubmission;
  readonly controller: VoiceInputController;
  readonly prepared: PreparedConnection;
  readonly grantId: string;
  readonly state: VoiceInputState;
  readonly cancel: () => void;
  readonly releaseSession: () => void;
  unsubscribeConsent: () => void;
};

// A confirmed send outlives its editor; remounts need its phase and cancellation, not its controller lifecycle.
const confirmedSubmissions = new Map<string, ConfirmedSubmission>();
const submissionListeners = new Set<() => void>();
const submissionKey = (environmentId: EnvironmentId, ownerKey: string) =>
  JSON.stringify([environmentId, ownerKey]);
const subscribeSubmissions = (notify: () => void) => {
  submissionListeners.add(notify);
  return () => {
    submissionListeners.delete(notify);
  };
};
const notifySubmissions = () => {
  for (const notify of submissionListeners) notify();
};
function clearConfirmedSubmission(pending: PendingSubmission) {
  const key = submissionKey(pending.environmentId, pending.ownerKey);
  const entry = confirmedSubmissions.get(key);
  if (entry?.pending !== pending) return;
  entry.unsubscribeConsent();
  entry.releaseSession();
  confirmedSubmissions.delete(key);
  notifySubmissions();
}

/**
 * Microphone audio leaves this device only for the environment the person chose in
 * Voice settings. Nothing is inferred from the primary or the draft's environment, and
 * the recording is abandoned the moment that choice changes or its connection drops.
 */
export function useVoiceTranscriptionDestination() {
  const hydrated = useClientSettingsHydrated();
  const choice = useAudioChoice();
  const grant = choice === "off" ? null : choice;
  const environmentId = hydrated && grant ? grant.destination.environmentId : null;
  const environment = useEnvironment(environmentId);
  const connection = Option.getOrNull(usePreparedConnection(environmentId));
  const canDictate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const cloud = grant?.destination.kind === "cloud" ? grant.destination : undefined;
  const provider = cloud?.provider;
  const model = cloud?.provider === "openrouter" ? cloud.model : undefined;
  const supported =
    environment?.serverConfig?.environment.capabilities[
      provider ? "cloudVoiceTranscription" : "voiceTranscription"
    ] === true;
  return {
    ...(hydrated && choice === null ? { offerFirstRunSetup: true } : {}),
    environmentId,
    ...(provider ? { cloudProvider: provider } : {}),
    ...(model ? { cloudModel: model } : {}),
    grantId: grant?.id ?? null,
    label:
      provider && environment
        ? `${CLOUD_SPEECH_LABELS[provider]} via ${environment.label}`
        : (environment?.label ?? null),
    prepared: supported && canDictate ? connection : null,
  };
}

export function useEnvironmentSpeechInput(input: HookInput) {
  const navigate = useNavigate();
  const destination = useVoiceTranscriptionDestination();
  const prepared = destination.prepared;
  const grantId = destination.grantId;
  const cloudProvider = destination.cloudProvider;
  const cloudModel = destination.cloudModel;
  const retainedSubmission = useSyncExternalStore(
    subscribeSubmissions,
    () => confirmedSubmissions.get(submissionKey(input.environmentId, input.ownerKey)),
    () => undefined,
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- revokes retained speech work when the destination connection or this owner's permission changes
  useEffect(() => {
    for (const entry of confirmedSubmissions.values()) {
      if (entry.grantId !== grantId || entry.prepared !== prepared) entry.cancel();
    }
    if (input.disabled)
      confirmedSubmissions.get(submissionKey(input.environmentId, input.ownerKey))?.cancel();
  }, [prepared, grantId, input.disabled, input.environmentId, input.ownerKey]);
  const draftCapabilities = useEnvironment(input.environmentId)?.serverConfig?.environment
    .capabilities;
  const originatingConnection = Option.getOrNull(usePreparedConnection(input.environmentId));
  const canCleanUp = useEnvironmentScope(input.environmentId, AuthOrchestrationOperateScope);
  const cleanupPrepared =
    canCleanUp &&
    (draftCapabilities?.voiceTranscription || draftCapabilities?.cloudVoiceTranscription)
      ? originatingConnection
      : null;
  const clientSettings = useClientSettings();
  const projectId = input.projectId ?? null;
  const projectWords = useEnvironmentSettings(
    input.environmentId,
    (settings) => resolveProjectSettings(settings, projectId).settings.speechProjectCustomWords,
  );
  const [status, setStatus] = useState<{
    readonly prepared: PreparedConnection;
    readonly value: EnvironmentSpeechStatus | null;
  } | null>(null);
  const [controllerState, setControllerState] = useState({
    prepared,
    grantId,
    value: INITIAL_STATE,
    ownerKey: input.ownerKey,
  });
  const [queuedStart, setQueuedStart] = useState<PreparedConnection | null>(null);
  const [level, setLevel] = useState(0);
  const [preview, setPreview] = useState<SpeechStreamText | null>(null);
  const [setup, setSetup] = useState(INITIAL_SETUP);
  const [previousOwner, setPreviousOwner] = useState({
    key: input.ownerKey,
    disabled: input.disabled,
  });
  if (controllerState.prepared !== prepared || controllerState.grantId !== grantId) {
    setControllerState({ prepared, grantId, value: INITIAL_STATE, ownerKey: input.ownerKey });
    setSetup(INITIAL_SETUP);
    setQueuedStart(null);
    setPreview(null);
    setLevel(0);
  }
  if (previousOwner.key !== input.ownerKey || previousOwner.disabled !== input.disabled) {
    setPreviousOwner({ key: input.ownerKey, disabled: input.disabled });
    setQueuedStart(null);
    setSetup(INITIAL_SETUP);
  }
  const state: VoiceInputState =
    retainedSubmission?.state ??
    (queuedStart === prepared && prepared
      ? WAITING_STATE
      : controllerState.prepared === prepared && controllerState.ownerKey === input.ownerKey
        ? controllerState.value
        : INITIAL_STATE);

  const controllerRef = useRef<VoiceInputController | null>(null);
  const startRequestRef = useRef(0);
  const pendingSubmissionRef = useRef<PendingSubmission | null>(null);
  const cancelSubmission = useStableCallback(() => {
    const pending = pendingSubmissionRef.current;
    pendingSubmissionRef.current = null;
    if (pending) clearConfirmedSubmission(pending);
    pending?.cancel?.();
  });
  const lastSnapshotRef = useRef<VoiceDraftSnapshot | null>(null);
  const mountedRef = useRef(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- distinguishes composer unmount from a changed destination in the controller cleanup
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const latestRef = useRef({ input, clientSettings, cleanupPrepared, projectWords });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- publishes committed props and settings to the asynchronous recording controller
  useEffect(() => {
    latestRef.current = { input, clientSettings, cleanupPrepared, projectWords };
  });
  const draftRevisionRef = useRef({ ownerKey: input.ownerKey, text: input.draftText, revision: 0 });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tracks committed draft revisions so a late transcript cannot overwrite an edited draft
  useEffect(() => {
    const revision = draftRevisionRef.current;
    if (revision.ownerKey !== input.ownerKey || revision.text !== input.draftText) {
      draftRevisionRef.current = {
        ownerKey: input.ownerKey,
        text: input.draftText,
        revision: revision.revision + 1,
      };
    }
  }, [input.ownerKey, input.draftText]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- owns the recording controller bound to the consented destination; it is disposed with the consent
  useEffect(() => {
    if (!prepared || !grantId || typeof navigator === "undefined") return;
    const hasAudioConsent = bindAudioGrant(grantId);
    let disposed = false;
    let controller: VoiceInputController;
    let recordingPreferences:
      | {
          readonly cleanup: SpeechPostProcessingOptions | null;
          readonly cleanupGrant: string | null;
          readonly environmentId: EnvironmentId;
          readonly target: PreparedConnection | null;
        }
      | undefined;

    const readDraft = (): VoiceDraftSnapshot | null => {
      const pending = pendingSubmissionRef.current;
      if (pending?.draft && pending.snapshot) {
        const draft = pending.draft.readDraft();
        return draft && { ...pending.snapshot, text: draft.text };
      }
      const current = latestRef.current.input;
      const draft = current.readDraft();
      const revision = draftRevisionRef.current;
      if (revision.ownerKey !== current.ownerKey || revision.text !== draft.text) {
        draftRevisionRef.current = {
          ownerKey: current.ownerKey,
          text: draft.text,
          revision: revision.revision + 1,
        };
      }
      lastSnapshotRef.current = {
        ownerKey: current.ownerKey,
        text: draft.text,
        selection: draft.selection,
        revision: draftRevisionRef.current.revision,
      };
      return lastSnapshotRef.current;
    };
    const platform = createBrowserVoiceInputPlatform({
      prepared,
      cloudProvider,
      cloudModel,
      hasAudioConsent,
      getTranscriptionOptions: (): SpeechTranscriptionOptions => {
        const {
          clientSettings: settings,
          projectWords: project,
          input: current,
        } = latestRef.current;
        const cleanupGrant = current.cleanup === false ? null : readCleanupGrant();
        const cleanupEnabled = cleanupGrant !== null;
        const cue =
          cleanupEnabled && latestRef.current.cleanupPrepared ? settings.speechCorrectionWord : "";
        const speechCustomWords = resolveSpeechVocabulary({
          personal: settings.speechCustomWords,
          project,
          hints: [cue, current.projectName ?? ""],
        });
        recordingPreferences = {
          cleanupGrant,
          environmentId: current.environmentId,
          target: latestRef.current.cleanupPrepared,
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
      getMicrophoneId: () => latestRef.current.clientSettings.voiceMicrophone,
      onLevel: setLevel,
      onDurationLimit: () => void controller.stop(),
      onText: (text) => {
        if (!disposed) setPreview(text);
      },
      onError: (message) => {
        if (!disposed) void controller.interruptRecording(message);
      },
    });
    const postProcess: NonNullable<VoiceInputControllerDependencies["postProcess"]> = (
      transcript,
      options,
    ) => {
      const preferences = recordingPreferences;
      const { input: current, cleanupPrepared } = latestRef.current;
      const submission = pendingSubmissionRef.current;
      const target = submission?.draft ? preferences?.target : cleanupPrepared;
      if (
        !preferences?.cleanup ||
        !hasAudioConsent() ||
        preferences.cleanupGrant !== readCleanupGrant() ||
        (!submission?.draft &&
          (current.cleanup === false ||
            current.environmentId !== preferences.environmentId ||
            current.ownerKey !== options.draft.ownerKey))
      )
        return null;
      if (!target)
        return Promise.reject(
          new Error("The draft's environment is unavailable for transcript cleanup."),
        );
      return runEnvironmentSpeech(
        postProcessEnvironmentTranscript(
          target,
          transcript,
          cleanupContext(options.draft),
          preferences.cleanup,
          () => hasAudioConsent() && preferences.cleanupGrant === readCleanupGrant(),
        ),
        options,
      ).then((result) => result.text);
    };
    controller = new VoiceInputController({
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
      readDraft,
      commitDraft: (text, selection) => {
        const pending = pendingSubmissionRef.current;
        if (pending?.draft) {
          if (
            !hasAudioConsent() ||
            (recordingPreferences?.cleanupGrant &&
              recordingPreferences.cleanupGrant !== readCleanupGrant())
          ) {
            cancelSubmission();
            return;
          }
          pending.draft.commitDraft(text, selection);
        } else {
          if (latestRef.current.input.disabled) return;
          latestRef.current.input.commitDraft(text, selection);
        }
        if (pending) pending.text = text;
      },
      onStateChange: (value) => {
        const pending = pendingSubmissionRef.current;
        if (value.phase === "error") {
          cancelSubmission();
          if (pending?.draft) {
            toastManager.add({
              type: "error",
              title: "Voice message was not sent",
              description: value.error,
            });
          }
        }
        if (value.phase === "idle" && pending?.draft) {
          clearConfirmedSubmission(pending);
          pendingSubmissionRef.current = null;
          if (pending.text !== undefined) pending.submit(pending.text);
          else pending.cancel?.();
        }
        if (pending?.draft && value.phase !== "idle" && value.phase !== "error") {
          const key = submissionKey(pending.environmentId, pending.ownerKey);
          const entry = confirmedSubmissions.get(key);
          if (entry?.pending === pending) {
            confirmedSubmissions.set(key, { ...entry, state: value });
            notifySubmissions();
          }
        }
        if (disposed) {
          if (value.phase === "error") controller.dispose();
          return;
        }
        setControllerState({
          prepared,
          grantId,
          value,
          ownerKey: lastSnapshotRef.current?.ownerKey ?? latestRef.current.input.ownerKey,
        });
        if (value.phase !== "recording" && value.phase !== "transcribing") setPreview(null);
      },
    });
    controllerRef.current = controller;
    return () => {
      disposed = true;
      startRequestRef.current += 1;
      setQueuedStart(null);
      if (mountedRef.current || !pendingSubmissionRef.current?.draft) {
        cancelSubmission();
        controller.dispose();
      }
      if (controllerRef.current === controller) controllerRef.current = null;
    };
  }, [prepared, grantId, cloudProvider, cloudModel, cancelSubmission]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- probes the chosen environment's speech status once its connection is available
  useEffect(() => {
    if (!prepared || cloudProvider) return;
    let disposed = false;
    void probeSpeechStatus(prepared)
      .then((value) => {
        if (!disposed) setStatus({ prepared, value });
      })
      .catch(() => {
        if (!disposed) setStatus({ prepared, value: null });
      });
    return () => {
      disposed = true;
    };
  }, [prepared, cloudProvider]);
  const currentStatus = !cloudProvider && status?.prepared === prepared ? status.value : null;
  const setupModelId = setup.model?.id;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- polls download progress while the setup dialog owns an active model download
  useEffect(() => {
    if (!setup.open || !setup.downloading || !prepared || !setupModelId) return;
    let disposed = false;
    let refreshing = false;
    const timer = window.setInterval(() => {
      if (refreshing) return;
      refreshing = true;
      void runEnvironmentSpeech(getEnvironmentSpeechModels(prepared))
        .then((result) => {
          if (disposed) return;
          const model = result.models.find((candidate) => candidate.id === setupModelId) ?? null;
          if (model) setSetup((current) => ({ ...current, model }));
        })
        .catch(() => undefined)
        .finally(() => {
          refreshing = false;
        });
    }, 1_000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [prepared, setup.downloading, setup.open, setupModelId]);

  const previousOwnerRef = useRef(input.ownerKey);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- cancels unsent dictation on navigation while a captured submission keeps its original draft
  useEffect(() => {
    if (previousOwnerRef.current === input.ownerKey && !input.disabled) return;
    previousOwnerRef.current = input.ownerKey;
    startRequestRef.current += 1;
    const pending = pendingSubmissionRef.current;
    if (pending?.draft && (pending.ownerKey !== input.ownerKey || !input.disabled)) return;
    cancelSubmission();
    controllerRef.current?.ownerChanged();
  }, [input.ownerKey, input.disabled, cancelSubmission]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- editor-owned submissions wait for React to commit the inserted transcript
  useEffect(() => {
    const pending = pendingSubmissionRef.current;
    if (state.phase !== "idle" || !pending || pending.draft) return;
    pendingSubmissionRef.current = null;
    if (!input.disabled && pending.ownerKey === input.ownerKey && pending.text !== undefined)
      pending.submit(pending.text);
    else pending.cancel?.();
  }, [state, input.ownerKey, input.disabled]);

  const submitAfterDictation = useStableCallback(
    (submit: (text: string) => void, cancel?: () => void) => {
      const current = latestRef.current.input;
      if (
        current.disabled ||
        state.phase === "preparing" ||
        pendingSubmissionRef.current ||
        confirmedSubmissions.has(submissionKey(current.environmentId, current.ownerKey))
      ) {
        cancel?.();
        return;
      }
      const controller = controllerRef.current;
      if (!controller || !voiceInputBlocksSubmission(state)) {
        submit(current.readDraft().text);
        return;
      }
      if (!voiceInputBlocksSubmission(controller.currentState)) {
        cancel?.();
        return;
      }
      const pending: PendingSubmission = {
        environmentId: current.environmentId,
        ownerKey: current.ownerKey,
        submit,
        cancel,
        draft: current.captureSubmissionDraft?.(),
        snapshot: lastSnapshotRef.current ?? undefined,
      };
      pendingSubmissionRef.current = pending;
      if (pending.draft && prepared && grantId) {
        const entry: ConfirmedSubmission = {
          pending,
          controller,
          prepared,
          grantId,
          state: controller.currentState,
          // Remounts must not mistake an expired permission cache for revoked access.
          releaseSession: appAtomRegistry.mount(
            environmentSession.sessionStateAtom(prepared.environmentId),
          ),
          cancel: () => {
            cancelSubmission();
            controller.dispose();
          },
          unsubscribeConsent: () => {},
        };
        confirmedSubmissions.set(submissionKey(current.environmentId, current.ownerKey), entry);
        const hasConsent = bindAudioGrant(grantId);
        const cleanupGrant = current.cleanup === false ? null : readCleanupGrant();
        entry.unsubscribeConsent = subscribeVoiceConsent(() => {
          if (!hasConsent() || (cleanupGrant && cleanupGrant !== readCleanupGrant()))
            entry.cancel();
        });
        notifySubmissions();
      }
      if (controller.currentState.phase === "recording") void controller.stop();
    },
  );

  const loadSetupCatalog = useStableCallback(
    async (connection: PreparedConnection, selectedModelId: string, request: number) => {
      setSetup({ ...INITIAL_SETUP, open: true });
      const catalog = await runEnvironmentSpeech(getEnvironmentSpeechModels(connection)).catch(
        () => null,
      );
      if (request !== startRequestRef.current) return;
      const choice = chooseSetupSpeechModel(catalog?.models ?? [], {
        selectedModelId,
        intent: latestRef.current.clientSettings.speechLanguage,
        preferred: preferredSpeechLanguages(),
      });
      setSetup((current) => ({
        ...current,
        model: choice?.model ?? null,
        language: choice?.language ?? null,
        catalogFailed: catalog === null,
        error: choice
          ? null
          : catalog
            ? "No model matches your language. Choose a model or change the language in Voice settings."
            : "Could not load transcription models. Check the connection and try again.",
      }));
    },
  );

  const start = useStableCallback(async () => {
    if (latestRef.current.input.disabled || (setup.open && setup.downloading)) return;
    if (confirmedSubmissions.size > 0 || pendingSubmissionRef.current) {
      toastManager.add({ type: "info", title: "Finishing the previous voice message" });
      return;
    }
    if (!grantId) {
      if (destination.offerFirstRunSetup && latestRef.current.input.offerSetup !== false)
        await navigate({ to: "/settings/voice", hash: "voice-transcription-destination" });
      return;
    }
    const request = ++startRequestRef.current;
    const controller = controllerRef.current;
    const owner = latestRef.current.input.ownerKey;
    if (!controller || !prepared) return;
    if (cloudProvider) {
      setLevel(0);
      await controller.start();
      return;
    }
    const stillCurrent = () =>
      request === startRequestRef.current &&
      controllerRef.current === controller &&
      latestRef.current.input.ownerKey === owner &&
      !latestRef.current.input.disabled;
    setSetup(INITIAL_SETUP);
    setQueuedStart(prepared);
    let latestStatus: EnvironmentSpeechStatus;
    try {
      latestStatus = await probeSpeechStatus(prepared, true);
    } catch (error) {
      if (!stillCurrent()) return;
      setQueuedStart(null);
      toastManager.add({
        type: "error",
        title: "Could not start voice input",
        description: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    if (!stillCurrent()) return;
    setStatus({ prepared, value: latestStatus });
    setQueuedStart(null);
    if (latestStatus.supported && latestStatus.state === "missing-model") {
      return loadSetupCatalog(prepared, latestStatus.modelId, request);
    }
    if (!latestStatus.supported) {
      toastManager.add({
        type: "error",
        title: "Voice input is not available",
        description: latestStatus.reason,
      });
      return;
    }
    setLevel(0);
    await controller.start();
  });

  const downloadSetupModel = useStableCallback(async () => {
    if (!prepared || !currentStatus?.supported || !setupModelId || setup.downloading) return;
    const modelId = setupModelId;
    const request = ++startRequestRef.current;
    setSetup((current) => ({ ...current, downloading: true, error: null }));
    try {
      const { models } = await runEnvironmentSpeech(
        downloadEnvironmentSpeechModel(prepared, modelId),
      );
      if (request !== startRequestRef.current) return;
      // A download cancelled from elsewhere still resolves, so select the model only once it landed.
      const installed = models.some(({ id, state }) => id === modelId && state === "installed");
      if (installed && modelId !== currentStatus.modelId) {
        try {
          await runEnvironmentSpeech(selectEnvironmentSpeechModel(prepared, modelId));
        } catch {
          if (request !== startRequestRef.current) return;
          setSetup((current) => ({
            ...current,
            downloading: false,
            error: "The model downloaded, but this environment could not select it. Try again.",
          }));
          return;
        }
      }
      if (request !== startRequestRef.current) return;
      const next = await probeSpeechStatus(prepared, true);
      if (request !== startRequestRef.current) return;
      setStatus({ prepared, value: next });
      const ready =
        installed && next.supported && next.modelId === modelId && next.state !== "missing-model";
      setSetup((current) => ({
        ...current,
        downloading: false,
        step: ready ? 1 : current.step,
        error: ready ? null : "The model is not ready. Try downloading it again.",
      }));
    } catch {
      if (request !== startRequestRef.current) return;
      setSetup((current) => ({
        ...current,
        downloading: false,
        error: "Could not download the model. Check this environment's connection and try again.",
      }));
    }
  });

  const cancelSetupDownload = useStableCallback(async () => {
    if (!prepared || !setupModelId) return;
    startRequestRef.current += 1;
    setSetup((current) => ({ ...current, open: false, downloading: false }));
    try {
      await runEnvironmentSpeech(cancelEnvironmentSpeechModelDownload(prepared, setupModelId));
    } catch (error) {
      setSetup((current) => ({
        ...current,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  });

  const destinationReady =
    grantId === null
      ? Boolean(destination.offerFirstRunSetup) && input.offerSetup !== false
      : prepared !== null &&
        (cloudProvider !== undefined ||
          (status?.prepared === prepared && status.value?.supported !== false));
  return {
    available:
      destinationReady &&
      typeof navigator !== "undefined" &&
      Boolean(navigator.mediaDevices?.getUserMedia) &&
      typeof AudioWorkletNode !== "undefined",
    status: currentStatus,
    transcriptionEnvironmentId: destination.environmentId,
    transcriptionEnvironmentLabel: destination.label,
    setup: {
      ...setup,
      setOpen: (open: boolean) => setSetup((current) => ({ ...current, open })),
      retryCatalog:
        setup.open && setup.catalogFailed && prepared && currentStatus?.supported
          ? () => loadSetupCatalog(prepared, currentStatus.modelId, ++startRequestRef.current)
          : null,
      download: downloadSetupModel,
      cancelDownload: cancelSetupDownload,
      startRecording: async () => {
        setSetup((current) => ({ ...current, open: false }));
        await start();
      },
    },
    state,
    preview: state.phase === "recording" || state.phase === "transcribing" ? preview : null,
    level,
    preparing: state.phase === "preparing",
    blocksSubmission: voiceInputBlocksSubmission(state),
    freezesEditor: voiceInputBlocksSubmission(state),
    start,
    submitAfterDictation,
    stop: useStableCallback(
      () =>
        (
          confirmedSubmissions.get(submissionKey(input.environmentId, input.ownerKey))
            ?.controller ?? controllerRef.current
        )?.stop() ?? Promise.resolve(),
    ),
    cancel: useStableCallback(() => {
      const retained = confirmedSubmissions.get(submissionKey(input.environmentId, input.ownerKey));
      if (retained) {
        retained.cancel();
        return;
      }
      const pending = pendingSubmissionRef.current;
      if (pending?.draft && pending.ownerKey !== latestRef.current.input.ownerKey) return;
      cancelSubmission();
      startRequestRef.current += 1;
      setQueuedStart(null);
      setSetup(INITIAL_SETUP);
      controllerRef.current?.cancel();
    }),
    skipPostProcessing: useStableCallback(() =>
      (
        confirmedSubmissions.get(submissionKey(input.environmentId, input.ownerKey))?.controller ??
        controllerRef.current
      )?.skipPostProcessing(),
    ),
  };
}
