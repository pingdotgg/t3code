import {
  cancelEnvironmentSpeechModelDownload,
  downloadEnvironmentSpeechModel,
  getEnvironmentSpeechModels,
  getEnvironmentSpeechStatus,
  postProcessEnvironmentTranscript,
  VoiceInputController,
  voiceInputBlocksSubmission,
  type VoiceDraftSnapshot,
  type VoiceInputControllerDependencies,
  type VoiceInputState,
} from "@t3tools/client-runtime/voice-input";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
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
import { resolveSpeechVocabulary } from "@t3tools/shared/speech";
import * as Option from "effect/Option";
import { useEffect, useRef, useState } from "react";

import { useStableCallback } from "~/hooks/useStableCallback";
import { toastManager } from "../components/ui/toast";
import {
  useClientSettings,
  useClientSettingsHydrated,
  useEnvironmentSettings,
} from "../hooks/useSettings";
import { runtime } from "../lib/runtime";
import { useEnvironment } from "../state/environments";
import { useEnvironmentScope, usePreparedConnection } from "../state/session";
import { createBrowserVoiceInputPlatform } from "./browserVoiceInput";
import { bindAudioGrant, readCleanupGrant, useAudioGrant } from "./voiceConsent";

const INITIAL_STATE: VoiceInputState = { phase: "idle", error: null, errorAction: null };
const WAITING_STATE: VoiceInputState = { phase: "preparing", error: null, errorAction: null };
const INITIAL_SETUP = {
  open: false,
  step: 0,
  model: null as EnvironmentSpeechModel | null,
  downloading: false,
  error: null as string | null,
};

// Every mounted editor shares one status probe per destination; starting a recording refreshes it.
const statusProbes = new WeakMap<PreparedConnection, Promise<EnvironmentSpeechStatus>>();
function probeSpeechStatus(prepared: PreparedConnection, refresh = false) {
  const cached = refresh ? undefined : statusProbes.get(prepared);
  if (cached) return cached;
  const probe = runtime.runPromise(getEnvironmentSpeechStatus(prepared));
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

type HookInput = {
  /** The draft's own environment. Optional transcript cleanup runs there, never on the audio destination. */
  readonly environmentId: EnvironmentId;
  /** The draft's project: its vocabulary on that environment and its name become recognition hints. */
  readonly projectId?: ProjectId | null | undefined;
  readonly projectName?: string | null | undefined;
  readonly ownerKey: string;
  readonly draftText: string;
  readonly disabled?: boolean | undefined;
  /** False keeps the transcript off the cleanup provider even when cleanup is on; the model test uses it. */
  readonly cleanup?: boolean | undefined;
  readonly readDraft: () => DraftInput;
  readonly commitDraft: (
    text: string,
    selection: { readonly start: number; readonly end: number },
  ) => void;
};

/**
 * Microphone audio leaves this device only for the environment the person chose in
 * Voice settings. Nothing is inferred from the primary or the draft's environment, and
 * the recording is abandoned the moment that choice changes or its connection drops.
 */
export function useVoiceTranscriptionDestination() {
  const hydrated = useClientSettingsHydrated();
  const grant = useAudioGrant();
  const environmentId = hydrated && grant ? grant.destination.environmentId : null;
  const environment = useEnvironment(environmentId);
  const connection = Option.getOrNull(usePreparedConnection(environmentId));
  const canDictate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const supported = environment?.serverConfig?.environment.capabilities.voiceTranscription === true;
  return {
    environmentId,
    grantId: grant?.id ?? null,
    label: environment?.label ?? null,
    prepared: supported && canDictate ? connection : null,
  };
}

export function useEnvironmentSpeechInput(input: HookInput) {
  const destination = useVoiceTranscriptionDestination();
  const prepared = destination.prepared;
  const grantId = destination.grantId;
  const originatingEnvironment = useEnvironment(input.environmentId);
  const originatingConnection = Option.getOrNull(usePreparedConnection(input.environmentId));
  const canCleanUp = useEnvironmentScope(input.environmentId, AuthOrchestrationOperateScope);
  const cleanupPrepared =
    canCleanUp &&
    originatingEnvironment?.serverConfig?.environment.capabilities.voiceTranscription === true
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
    readonly value: EnvironmentSpeechStatus;
  } | null>(null);
  const [controllerState, setControllerState] = useState({
    prepared,
    grantId,
    value: INITIAL_STATE,
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
    setControllerState({ prepared, grantId, value: INITIAL_STATE });
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
    queuedStart === prepared && prepared
      ? WAITING_STATE
      : controllerState.prepared === prepared
        ? controllerState.value
        : INITIAL_STATE;

  const controllerRef = useRef<VoiceInputController | null>(null);
  const startRequestRef = useRef(0);
  const pendingSubmissionRef = useRef<{
    ownerKey: string;
    submit: (text: string) => void;
    text?: string;
  } | null>(null);
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
        }
      | undefined;

    const readDraft = (): VoiceDraftSnapshot => {
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
      return {
        ownerKey: current.ownerKey,
        text: draft.text,
        selection: draft.selection,
        revision: draftRevisionRef.current.revision,
      };
    };
    const platform = createBrowserVoiceInputPlatform({
      prepared,
      hasAudioConsent,
      getTranscriptionOptions: (): SpeechTranscriptionOptions => {
        const {
          clientSettings: settings,
          projectWords: project,
          input: current,
        } = latestRef.current;
        const cleanupGrant = current.cleanup === false ? null : readCleanupGrant();
        const cleanupEnabled = cleanupGrant !== null;
        const cue = cleanupEnabled ? settings.speechCorrectionWord : "";
        const speechCustomWords = resolveSpeechVocabulary({
          personal: settings.speechCustomWords,
          project,
          hints: [cue, current.projectName ?? ""],
        });
        recordingPreferences = {
          cleanupGrant,
          environmentId: current.environmentId,
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
      const { input: current, cleanupPrepared: target } = latestRef.current;
      if (
        !preferences?.cleanup ||
        !hasAudioConsent() ||
        preferences.cleanupGrant !== readCleanupGrant() ||
        current.cleanup === false ||
        current.environmentId !== preferences.environmentId ||
        current.ownerKey !== options.draft.ownerKey
      )
        return null;
      if (!target)
        return Promise.reject(
          new Error("The draft's environment is unavailable for transcript cleanup."),
        );
      return runtime
        .runPromise(
          postProcessEnvironmentTranscript(
            target,
            transcript,
            cleanupContext(options.draft),
            preferences.cleanup,
            () => hasAudioConsent() && preferences.cleanupGrant === readCleanupGrant(),
          ),
          options,
        )
        .then((result) => result.text);
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
        if (latestRef.current.input.disabled) return;
        latestRef.current.input.commitDraft(text, selection);
        if (pendingSubmissionRef.current) pendingSubmissionRef.current.text = text;
      },
      onStateChange: (value) => {
        if (disposed) return;
        if (value.phase === "error") pendingSubmissionRef.current = null;
        setControllerState({ prepared, grantId, value });
        if (value.phase !== "recording" && value.phase !== "transcribing") setPreview(null);
      },
    });
    controllerRef.current = controller;
    return () => {
      disposed = true;
      pendingSubmissionRef.current = null;
      startRequestRef.current += 1;
      setQueuedStart(null);
      controller.dispose();
      if (controllerRef.current === controller) controllerRef.current = null;
    };
  }, [prepared, grantId]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- probes the chosen environment's speech status once its connection is available
  useEffect(() => {
    if (!prepared) return;
    let disposed = false;
    void probeSpeechStatus(prepared)
      .then((value) => {
        if (!disposed) setStatus({ prepared, value });
      })
      .catch(() => {
        if (!disposed) setStatus(null);
      });
    return () => {
      disposed = true;
    };
  }, [prepared]);
  const currentStatus = status?.prepared === prepared ? status.value : null;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- polls download progress while the setup dialog owns an active model download
  useEffect(() => {
    if (!setup.open || !setup.downloading || !prepared || !currentStatus?.supported) return;
    const modelId = currentStatus.modelId;
    let disposed = false;
    let refreshing = false;
    const timer = window.setInterval(() => {
      if (refreshing) return;
      refreshing = true;
      void runtime
        .runPromise(getEnvironmentSpeechModels(prepared))
        .then((result) => {
          if (disposed) return;
          const model = result.models.find((candidate) => candidate.id === modelId) ?? null;
          setSetup((current) => ({ ...current, model }));
        })
        .catch(() => undefined)
        .finally(() => {
          refreshing = false;
        });
    }, 350);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [currentStatus, prepared, setup.downloading, setup.open]);

  const previousOwnerRef = useRef(input.ownerKey);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- abandons the recording and any queued submission when the draft's owner changes
  useEffect(() => {
    if (previousOwnerRef.current === input.ownerKey && !input.disabled) return;
    previousOwnerRef.current = input.ownerKey;
    pendingSubmissionRef.current = null;
    startRequestRef.current += 1;
    controllerRef.current?.ownerChanged();
  }, [input.ownerKey, input.disabled]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- delivers a queued submission only after the transcript has committed to the draft
  useEffect(() => {
    const pending = pendingSubmissionRef.current;
    if (state.phase !== "idle" || !pending) return;
    pendingSubmissionRef.current = null;
    if (!input.disabled && pending.ownerKey === input.ownerKey && pending.text !== undefined)
      pending.submit(pending.text);
  }, [state, input.ownerKey, input.disabled]);

  const submitAfterDictation = useStableCallback((submit: (text: string) => void) => {
    if (latestRef.current.input.disabled || state.phase === "preparing") return;
    const controller = controllerRef.current;
    if (!controller || !voiceInputBlocksSubmission(state)) {
      submit(latestRef.current.input.readDraft().text);
      return;
    }
    if (pendingSubmissionRef.current) return;
    pendingSubmissionRef.current = { ownerKey: latestRef.current.input.ownerKey, submit };
    if (controller.currentState.phase === "recording") void controller.stop();
  });

  const start = useStableCallback(async () => {
    const request = ++startRequestRef.current;
    const controller = controllerRef.current;
    const owner = latestRef.current.input.ownerKey;
    if (latestRef.current.input.disabled || !controller || !prepared) return;
    const stillCurrent = () =>
      request === startRequestRef.current &&
      controllerRef.current === controller &&
      latestRef.current.input.ownerKey === owner &&
      !latestRef.current.input.disabled;
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
    setQueuedStart(null);
    setStatus({ prepared, value: latestStatus });
    if (!latestStatus.supported) {
      toastManager.add({
        type: "error",
        title: "Voice input is not available",
        description: latestStatus.reason,
      });
      return;
    }
    if (latestStatus.state === "missing-model") {
      setSetup({ ...INITIAL_SETUP, open: true });
      return;
    }
    setLevel(0);
    await controller.start();
  });

  const downloadSetupModel = useStableCallback(async () => {
    if (!prepared || !currentStatus?.supported || setup.downloading) return;
    const request = ++startRequestRef.current;
    setSetup((current) => ({ ...current, downloading: true, error: null }));
    try {
      await runtime.runPromise(downloadEnvironmentSpeechModel(prepared, currentStatus.modelId));
      if (request !== startRequestRef.current) return;
      const next = await probeSpeechStatus(prepared, true);
      if (request !== startRequestRef.current) return;
      setStatus({ prepared, value: next });
      setSetup((current) => ({
        ...current,
        downloading: false,
        step: next.supported && next.state !== "missing-model" ? 1 : current.step,
        error:
          next.supported && next.state !== "missing-model"
            ? null
            : "The model is not ready. Try downloading it again.",
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
    if (!prepared || !currentStatus?.supported) return;
    startRequestRef.current += 1;
    setSetup((current) => ({ ...current, open: false, downloading: false }));
    try {
      await runtime.runPromise(
        cancelEnvironmentSpeechModelDownload(prepared, currentStatus.modelId),
      );
    } catch (error) {
      setSetup((current) => ({
        ...current,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  });

  return {
    available:
      prepared !== null &&
      currentStatus?.supported === true &&
      typeof navigator !== "undefined" &&
      Boolean(navigator.mediaDevices?.getUserMedia) &&
      typeof AudioWorkletNode !== "undefined",
    status: currentStatus,
    transcriptionEnvironmentId: destination.environmentId,
    transcriptionEnvironmentLabel: destination.label,
    setup: {
      ...setup,
      setOpen: (open: boolean) => setSetup((current) => ({ ...current, open })),
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
    stop: useStableCallback(() => controllerRef.current?.stop() ?? Promise.resolve()),
    cancel: useStableCallback(() => {
      pendingSubmissionRef.current = null;
      startRequestRef.current += 1;
      setQueuedStart(null);
      controllerRef.current?.cancel();
    }),
    skipPostProcessing: useStableCallback(() => controllerRef.current?.skipPostProcessing()),
  };
}
