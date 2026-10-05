import {
  cancelEnvironmentSpeechModelDownload,
  downloadEnvironmentSpeechModel,
  getEnvironmentSpeechModels,
  getEnvironmentSpeechStatus,
  VoiceTranscriptionError,
  postProcessEnvironmentTranscript,
  VoiceInputController,
  voiceInputBlocksSubmission,
  voiceInputFreezesEditor,
  type VoiceDraftSnapshot,
  type VoiceInputControllerDependencies,
  type VoiceInputState,
} from "@t3tools/client-runtime/voice-input";
import type {
  EnvironmentId,
  SpeechPostProcessingOptions,
  ProjectId,
  EnvironmentSpeechModel,
  EnvironmentSpeechStatus,
  SpeechStreamText,
} from "@t3tools/contracts";
import { SpeechTranscriptionOptions } from "@t3tools/contracts";
import { mergeSpeechCustomWords } from "@t3tools/shared/speech";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import { useCallback, useEffect, useRef, useState } from "react";

import { useClientSettings, useClientSettingsHydrated } from "../hooks/useSettings";
import { usePreparedConnection } from "../state/session";
import { runtime } from "../lib/runtime";
import { useEnvironment, usePrimaryEnvironmentId } from "../state/environments";
import { createBrowserVoiceInputPlatform } from "./browserVoiceInput";
import { toastManager } from "../components/ui/toast";

const decodeTranscriptionOptions = Schema.decodeSync(SpeechTranscriptionOptions);

const INITIAL_STATE: VoiceInputState<true> = { phase: "idle", error: null, errorAction: null };
const WAITING_STATE: VoiceInputState<true> = { phase: "preparing", error: null, errorAction: null };

type DraftInput = {
  readonly text: string;
  readonly selection: { readonly start: number; readonly end: number };
};

type HookInput = {
  readonly environmentId: EnvironmentId;
  readonly projectName?: string | undefined;
  readonly projectId?: ProjectId | undefined;
  readonly ownerKey: string;
  readonly draftText: string;
  readonly disabled?: boolean | undefined;
  readonly readDraft: () => DraftInput;
  readonly commitDraft: (
    text: string,
    selection: { readonly start: number; readonly end: number },
  ) => void;
};

export function useEnvironmentSpeechInput(input: HookInput) {
  const clientSettingsHydrated = useClientSettingsHydrated();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const configuredEnvironmentId = useClientSettings(
    (settings) => settings.voiceTranscriptionEnvironmentId,
  );
  const transcriptionEnvironmentId = clientSettingsHydrated
    ? (configuredEnvironmentId ?? primaryEnvironmentId)
    : null;
  const transcriptionEnvironment = useEnvironment(transcriptionEnvironmentId);
  const transcriptionConnection = Option.getOrNull(
    usePreparedConnection(transcriptionEnvironmentId),
  );
  const originatingEnvironment = useEnvironment(input.environmentId);
  const cleanupConnection = Option.getOrNull(usePreparedConnection(input.environmentId));
  const prepared =
    transcriptionEnvironment?.serverConfig?.environment.capabilities.voiceTranscription === true
      ? transcriptionConnection
      : null;
  const postProcessingPrepared =
    originatingEnvironment?.serverConfig?.environment.capabilities.voiceTranscription === true
      ? cleanupConnection
      : null;
  const clientSettings = useClientSettings();
  const preferencesRef = useRef({ clientSettings, originatingEnvironment });
  useEffect(() => {
    preferencesRef.current = { clientSettings, originatingEnvironment };
  }, [clientSettings, originatingEnvironment]);
  const microphoneId = useClientSettings((settings) => settings.voiceMicrophone);
  const [status, setStatus] = useState<{
    readonly prepared: NonNullable<typeof prepared>;
    readonly value: EnvironmentSpeechStatus;
  } | null>(null);
  const [controllerState, setControllerState] = useState({ prepared, value: INITIAL_STATE });
  const [queuedStart, setQueuedStart] = useState<{
    readonly prepared: NonNullable<typeof prepared>;
    readonly request: number;
  } | null>(null);
  if (controllerState.prepared !== prepared) {
    setControllerState({ prepared, value: INITIAL_STATE });
  }
  const state: VoiceInputState<true> =
    queuedStart?.prepared === prepared
      ? WAITING_STATE
      : controllerState.prepared === prepared
        ? controllerState.value
        : INITIAL_STATE;
  const [level, setLevel] = useState(0);
  const [preview, setPreview] = useState<SpeechStreamText | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const [setupStep, setSetupStep] = useState(0);
  const [setupModel, setSetupModel] = useState<EnvironmentSpeechModel | null>(null);
  const [setupDownloading, setSetupDownloading] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);
  const setupCancelledRef = useRef(false);
  const controllerRef = useRef<VoiceInputController<true> | null>(null);
  const startRequestRef = useRef(0);
  const pendingSubmissionRef = useRef<{
    ownerKey: string;
    submit: (text: string) => void;
    text?: string;
  } | null>(null);
  const latestInputRef = useRef(input);
  const microphoneIdRef = useRef(microphoneId);
  const draftRevisionRef = useRef({ ownerKey: input.ownerKey, text: input.draftText, revision: 0 });

  useEffect(() => {
    latestInputRef.current = input;
    const revision = draftRevisionRef.current;
    if (revision.ownerKey !== input.ownerKey || revision.text !== input.draftText) {
      draftRevisionRef.current = {
        ownerKey: input.ownerKey,
        text: input.draftText,
        revision: revision.revision + 1,
      };
    }
  }, [input]);

  useEffect(() => {
    microphoneIdRef.current = microphoneId;
  }, [microphoneId]);

  useEffect(() => {
    if (!prepared || typeof navigator === "undefined") return;

    const readDraft = (): VoiceDraftSnapshot => {
      const current = latestInputRef.current;
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

    let disposed = false;
    let controller: VoiceInputController<true>;
    let recordingPreferences: SpeechPostProcessingOptions | undefined;
    const platform = createBrowserVoiceInputPlatform({
      prepared,
      getTranscriptionOptions: () => {
        const { clientSettings, originatingEnvironment } = preferencesRef.current;
        const { projectId, projectName } = latestInputRef.current;
        if (projectId && !originatingEnvironment?.serverConfig) {
          throw new VoiceTranscriptionError(
            "preparation-failed",
            "Reconnect the project environment to load its dictionary.",
          );
        }
        const projectWords =
          projectId && originatingEnvironment?.serverConfig
            ? resolveProjectSettings(originatingEnvironment.serverConfig.settings, projectId)
                .settings.speechProjectCustomWords
            : [];
        const speechCustomWords = mergeSpeechCustomWords(
          clientSettings.speechCustomWords,
          projectWords,
        );
        recordingPreferences = {
          speechPostProcessingEnabled: clientSettings.speechPostProcessingEnabled,
          speechCorrectionWord: clientSettings.speechCorrectionWord,
          speechPostProcessingPrompt: { ...clientSettings.speechPostProcessingPrompt },
          speechCustomWords,
        };
        try {
          return decodeTranscriptionOptions({
            ...clientSettings,
            speechCustomWords,
            ...(projectName && projectName.length <= 200 ? { projectName } : {}),
          });
        } catch (cause) {
          throw new VoiceTranscriptionError(
            "preparation-failed",
            "Personal and project dictionaries together cannot exceed 100 words.",
            { cause },
          );
        }
      },
      getMicrophoneId: () => microphoneIdRef.current,
      onLevel: setLevel,
      onDurationLimit: () => void controller.stop(),
      onText: (text) => {
        if (!disposed) setPreview(text);
      },
      onError: (message) => {
        if (!disposed) void controller.interruptRecording(message);
      },
    });
    controller = new VoiceInputController<true>({
      recorder: platform.recorder,
      getTranscriber: () => platform.transcriber,
      requestPermission: async () => ({ granted: true, canAskAgain: true }),
      configureRecording: async () => undefined,
      releaseRecording: async () => platform.cancelRecording(),
      deleteRecording: platform.deleteRecording,
      get postProcess(): VoiceInputControllerDependencies<true>["postProcess"] {
        const preferences = recordingPreferences;
        if (!preferences?.speechPostProcessingEnabled) return undefined;
        return async (transcript, options) => {
          if (!postProcessingPrepared)
            throw new Error("The project environment is unavailable for transcript cleanup.");
          const result = await runtime.runPromise(
            postProcessEnvironmentTranscript(
              postProcessingPrepared,
              transcript,
              { text: options.draft.text, selection: options.draft.selection },
              preferences,
            ),
            options,
          );
          return result.text;
        };
      },
      onPostProcessingError: () =>
        toastManager.add({
          type: "warning",
          title: "Post-processing failed",
          description: "The original transcription was added.",
        }),
      readDraft,
      commitDraft: (text, selection) => {
        if (latestInputRef.current.disabled) return;
        latestInputRef.current.commitDraft(text, selection);
        if (pendingSubmissionRef.current) pendingSubmissionRef.current.text = text;
      },
      onStateChange: (value) => {
        if (!disposed) {
          if (value.phase === "error") pendingSubmissionRef.current = null;
          setControllerState({ prepared, value });
          if (value.phase !== "recording" && value.phase !== "transcribing") setPreview(null);
        }
      },
    });
    controllerRef.current = controller;
    setControllerState({ prepared, value: INITIAL_STATE });
    setPreview(null);
    setLevel(0);
    return () => {
      disposed = true;
      pendingSubmissionRef.current = null;
      startRequestRef.current += 1;
      setQueuedStart(null);
      controller.dispose();
      if (controllerRef.current === controller) controllerRef.current = null;
    };
  }, [postProcessingPrepared, prepared]);

  useEffect(() => {
    if (!prepared) return;
    let disposed = false;
    void runtime
      .runPromise(getEnvironmentSpeechStatus(prepared))
      .then((next) => {
        if (!disposed) setStatus({ prepared, value: next });
      })
      .catch(() => {
        if (!disposed) setStatus(null);
      });
    return () => {
      disposed = true;
    };
  }, [prepared]);

  const currentStatus = status?.prepared === prepared ? status.value : null;

  useEffect(() => {
    if (!setupOpen || !setupDownloading || !prepared || !currentStatus?.supported) return;
    let disposed = false;
    let refreshing = false;
    const timer = window.setInterval(() => {
      if (refreshing) return;
      refreshing = true;
      void runtime
        .runPromise(getEnvironmentSpeechModels(prepared))
        .then((result) => {
          if (!disposed)
            setSetupModel(
              result.models.find((model) => model.id === currentStatus.modelId) ?? null,
            );
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
  }, [currentStatus, prepared, setupDownloading, setupOpen]);

  const previousOwnerRef = useRef(input.ownerKey);
  useEffect(() => {
    if (previousOwnerRef.current === input.ownerKey && !input.disabled) return;
    previousOwnerRef.current = input.ownerKey;
    pendingSubmissionRef.current = null;
    startRequestRef.current += 1;
    setQueuedStart(null);
    controllerRef.current?.ownerChanged();
    setSetupOpen(false);
  }, [input.ownerKey, input.disabled]);

  useEffect(() => {
    const pending = pendingSubmissionRef.current;
    if (state.phase !== "idle" || !pending) return;
    pendingSubmissionRef.current = null;
    if (!input.disabled && pending.ownerKey === input.ownerKey && pending.text !== undefined)
      pending.submit(pending.text);
  }, [state, input.ownerKey, input.disabled]);

  const submitAfterDictation = useCallback(
    (submit: (text: string) => void) => {
      if (latestInputRef.current.disabled || state.phase === "preparing") return;
      const controller = controllerRef.current;
      if (!controller || !voiceInputBlocksSubmission(state)) {
        submit(latestInputRef.current.readDraft().text);
        return;
      }
      if (pendingSubmissionRef.current) return;
      pendingSubmissionRef.current = { ownerKey: latestInputRef.current.ownerKey, submit };
      if (controller.currentState.phase === "recording") void controller.stop();
    },
    [state],
  );

  const start = useCallback(async () => {
    const request = ++startRequestRef.current;
    const expectedController = controllerRef.current;
    const expectedOwner = latestInputRef.current.ownerKey;
    if (
      latestInputRef.current.disabled ||
      !expectedController ||
      !prepared ||
      !currentStatus?.supported
    )
      return;
    const stillCurrent = () =>
      request === startRequestRef.current &&
      controllerRef.current === expectedController &&
      latestInputRef.current.ownerKey === expectedOwner &&
      !latestInputRef.current.disabled;
    setQueuedStart({ prepared, request });
    let latestStatus: EnvironmentSpeechStatus;
    try {
      latestStatus = await runtime.runPromise(getEnvironmentSpeechStatus(prepared));
      if (!stillCurrent()) return;
      if (latestStatus.supported && latestStatus.state === "transcribing") {
        setQueuedStart({ prepared, request });
        // Remember the press and start when the previous stream drains,
        // like Handy does, instead of erroring after a fixed wait.
        // Esc, cancel, or a draft change (stillCurrent) abandons the queue.
        while (latestStatus.supported && latestStatus.state === "transcribing") {
          await new Promise<void>((resolve) => window.setTimeout(resolve, 250));
          if (!stillCurrent()) return;
          latestStatus = await runtime.runPromise(getEnvironmentSpeechStatus(prepared));
          if (!stillCurrent()) return;
        }
      }
    } catch (error) {
      if (!stillCurrent()) return;
      toastManager.add({
        type: "error",
        title: "Could not start voice input",
        description: error instanceof Error ? error.message : String(error),
      });
      setQueuedStart(null);
      return;
    }
    setQueuedStart(null);
    if (!latestStatus.supported) return;
    setStatus({ prepared, value: latestStatus });
    if (latestStatus.state === "missing-model") {
      setSetupStep(0);
      setSetupOpen(true);
      return;
    }
    if (!stillCurrent()) return;
    setLevel(0);
    await expectedController.start();
  }, [currentStatus, prepared]);

  const downloadSetupModel = useCallback(async () => {
    if (!prepared || !currentStatus?.supported || setupDownloading) return;
    setupCancelledRef.current = false;
    setSetupDownloading(true);
    setSetupError(null);
    try {
      await runtime.runPromise(downloadEnvironmentSpeechModel(prepared, currentStatus.modelId));
      if (setupCancelledRef.current) return;
      const next = await runtime.runPromise(getEnvironmentSpeechStatus(prepared));
      setStatus({ prepared, value: next });
      if (!next.supported || next.state === "missing-model") {
        setSetupError("The model is not ready. Try downloading it again.");
        return;
      }
      setSetupStep(1);
    } catch {
      if (!setupCancelledRef.current)
        setSetupError(
          "Could not download the model. Check this environment's connection and try again.",
        );
    } finally {
      setSetupDownloading(false);
    }
  }, [currentStatus, prepared, setupDownloading]);

  const cancelSetupDownload = useCallback(async () => {
    if (!prepared || !currentStatus?.supported) return;
    setupCancelledRef.current = true;
    setSetupOpen(false);
    try {
      await runtime.runPromise(
        cancelEnvironmentSpeechModelDownload(prepared, currentStatus.modelId),
      );
    } catch (error) {
      setSetupError(error instanceof Error ? error.message : String(error));
    }
  }, [currentStatus, prepared]);

  const startAfterSetup = useCallback(async () => {
    setSetupOpen(false);
    await start();
  }, [start]);

  return {
    available:
      currentStatus?.supported === true &&
      typeof navigator !== "undefined" &&
      Boolean(navigator.mediaDevices?.getUserMedia) &&
      typeof AudioWorkletNode !== "undefined",
    status: currentStatus,
    transcriptionEnvironmentId,
    setup: {
      open: setupOpen,
      step: setupStep,
      model: setupModel,
      downloading: setupDownloading,
      error: setupError,
      setOpen: setSetupOpen,
      download: downloadSetupModel,
      cancelDownload: cancelSetupDownload,
      startRecording: startAfterSetup,
    },
    state,
    progress: null,
    preview: state.phase === "recording" || state.phase === "transcribing" ? preview : null,
    level,
    preparing: state.phase === "preparing",
    blocksSubmission: voiceInputBlocksSubmission(state),
    freezesEditor: voiceInputFreezesEditor(state),
    start,
    submitAfterDictation,
    stop: useCallback(() => controllerRef.current?.stop() ?? Promise.resolve(), []),
    cancel: useCallback(() => {
      pendingSubmissionRef.current = null;
      startRequestRef.current += 1;
      setQueuedStart(null);
      controllerRef.current?.cancel();
    }, []),
    skipPostProcessing: useCallback(() => controllerRef.current?.skipPostProcessing(), []),
  };
}
