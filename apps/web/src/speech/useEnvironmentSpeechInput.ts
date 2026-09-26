import {
  cancelEnvironmentSpeechModelDownload,
  downloadEnvironmentSpeechModel,
  getEnvironmentSpeechModels,
  getEnvironmentSpeechStatus,
  postProcessEnvironmentTranscript,
  VoiceInputController,
  voiceInputBlocksSubmission,
  voiceInputFreezesEditor,
  type VoiceDraftSnapshot,
  type VoiceInputState,
} from "@t3tools/client-runtime/voice-input";
import type {
  EnvironmentId,
  EnvironmentSpeechModel,
  EnvironmentSpeechStatus,
  SpeechStreamText,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  useClientSettings,
  useClientSettingsHydrated,
  useEnvironmentSettings,
} from "../hooks/useSettings";
import { usePreparedConnection } from "../state/session";
import { runtime } from "../lib/runtime";
import { usePrimaryEnvironmentId } from "../state/environments";
import { createBrowserVoiceInputPlatform } from "./browserVoiceInput";
import { toastManager } from "../components/ui/toast";

const INITIAL_STATE: VoiceInputState<true> = { phase: "idle", error: null, errorAction: null };
const WAITING_STATE: VoiceInputState<true> = { phase: "preparing", error: null, errorAction: null };

type DraftInput = {
  readonly text: string;
  readonly selection: { readonly start: number; readonly end: number };
};

type HookInput = {
  readonly environmentId: EnvironmentId;
  readonly ownerKey: string;
  readonly draftText: string;
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
  const prepared = Option.getOrNull(usePreparedConnection(transcriptionEnvironmentId));
  const postProcessingPrepared = Option.getOrNull(usePreparedConnection(input.environmentId));
  const postProcessingEnabled = useEnvironmentSettings(
    input.environmentId,
    (settings) => settings.speechPostProcessingEnabled,
  );
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
    const platform = createBrowserVoiceInputPlatform({
      prepared,
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
      ...(postProcessingEnabled && postProcessingPrepared
        ? {
            postProcess: async (transcript: string, options: { readonly signal: AbortSignal }) => {
              const result = await runtime.runPromise(
                postProcessEnvironmentTranscript(postProcessingPrepared, transcript),
                options,
              );
              return result.text;
            },
            onPostProcessingError: () =>
              toastManager.add({
                type: "warning",
                title: "Post-processing failed",
                description: "The original transcription was added.",
              }),
          }
        : {}),
      readDraft,
      commitDraft: (text, selection) => latestInputRef.current.commitDraft(text, selection),
      onStateChange: (value) => {
        if (!disposed) {
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
      startRequestRef.current += 1;
      setQueuedStart(null);
      controller.dispose();
      if (controllerRef.current === controller) controllerRef.current = null;
    };
  }, [postProcessingEnabled, postProcessingPrepared, prepared]);

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
    if (previousOwnerRef.current === input.ownerKey) return;
    previousOwnerRef.current = input.ownerKey;
    startRequestRef.current += 1;
    setQueuedStart(null);
    controllerRef.current?.ownerChanged();
  }, [input.ownerKey]);

  const start = useCallback(async () => {
    const request = ++startRequestRef.current;
    const expectedController = controllerRef.current;
    const expectedOwner = latestInputRef.current.ownerKey;
    if (!expectedController || !prepared || !currentStatus?.supported) return;
    const stillCurrent = () =>
      request === startRequestRef.current &&
      controllerRef.current === expectedController &&
      latestInputRef.current.ownerKey === expectedOwner;
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
    await controllerRef.current?.start();
  }, []);

  return {
    available:
      currentStatus?.supported === true &&
      typeof navigator !== "undefined" &&
      Boolean(navigator.mediaDevices?.getUserMedia) &&
      typeof AudioWorkletNode !== "undefined",
    status: currentStatus,
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
    blocksSubmission: voiceInputBlocksSubmission(state),
    freezesEditor: voiceInputFreezesEditor(state),
    start,
    stop: useCallback(() => controllerRef.current?.stop() ?? Promise.resolve(), []),
    cancel: useCallback(() => {
      startRequestRef.current += 1;
      setQueuedStart(null);
      controllerRef.current?.cancel();
    }, []),
    skipPostProcessing: useCallback(() => controllerRef.current?.skipPostProcessing(), []),
  };
}
