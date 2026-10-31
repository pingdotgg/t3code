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
import { useEffect, useRef, useState } from "react";

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
// The last status each connection answered. A composer that mounts later (a
// new draft, a thread switch) shows its mic at once instead of after a fetch.
const lastStatusByConnection = new WeakMap<object, EnvironmentSpeechStatus>();

type DraftInput = {
  readonly text: string;
  readonly selection: { readonly start: number; readonly end: number };
};

type HookInput = {
  readonly environmentId: EnvironmentId;
  readonly projectName?: string | undefined;
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
  const [controllerState, setControllerState] = useState({
    prepared,
    postProcessingEnabled,
    postProcessingPrepared,
    value: INITIAL_STATE,
  });
  const [queuedStart, setQueuedStart] = useState<{
    readonly prepared: NonNullable<typeof prepared>;
    readonly request: number;
  } | null>(null);
  const [level, setLevel] = useState(0);
  const [preview, setPreview] = useState<SpeechStreamText | null>(null);
  const controllerChanged =
    controllerState.prepared !== prepared ||
    controllerState.postProcessingEnabled !== postProcessingEnabled ||
    controllerState.postProcessingPrepared !== postProcessingPrepared;
  if (controllerChanged) {
    setControllerState({
      prepared,
      postProcessingEnabled,
      postProcessingPrepared,
      value: INITIAL_STATE,
    });
    setPreview(null);
    setLevel(0);
  }
  const state: VoiceInputState<true> =
    queuedStart?.prepared === prepared
      ? WAITING_STATE
      : controllerChanged
        ? INITIAL_STATE
        : controllerState.value;
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

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Publish committed draft ownership and callbacks before asynchronous recorder completions read them.
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

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Publish the selected microphone before the external recorder starts its next capture.
  useEffect(() => {
    microphoneIdRef.current = microphoneId;
  }, [microphoneId]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Own the external recorder and transcription controller for this environment connection.
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
      getProjectName: () => {
        const name = latestInputRef.current.projectName;
        return name && name.length <= 200 ? name : undefined;
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
      releaseRecording: async () => platform.releaseRecording(),
      deleteRecording: platform.deleteRecording,
      ...(postProcessingEnabled && postProcessingPrepared
        ? {
            postProcess: async (transcript, options) => {
              const result = await runtime.runPromise(
                postProcessEnvironmentTranscript(postProcessingPrepared, transcript, {
                  text: options.draft.text,
                  selection: options.draft.selection,
                }),
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
          setControllerState({ prepared, postProcessingEnabled, postProcessingPrepared, value });
          if (value.phase !== "recording" && value.phase !== "transcribing") setPreview(null);
        }
      },
    });
    controllerRef.current = controller;
    return () => {
      disposed = true;
      startRequestRef.current += 1;
      setQueuedStart(null);
      controller.dispose();
      if (controllerRef.current === controller) controllerRef.current = null;
    };
  }, [postProcessingEnabled, postProcessingPrepared, prepared]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Read transcription availability when the external environment connection changes.
  useEffect(() => {
    if (!prepared) return;
    let disposed = false;
    void runtime
      .runPromise(getEnvironmentSpeechStatus(prepared))
      .then((next) => {
        if (!disposed) setStatus({ prepared, value: next });
      })
      .catch(() => {
        lastStatusByConnection.delete(prepared);
        if (!disposed) setStatus(null);
      });
    return () => {
      disposed = true;
    };
  }, [prepared]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Cache committed speech status so later-mounted editors can share the connection result.
  useEffect(() => {
    if (status) lastStatusByConnection.set(status.prepared, status.value);
  }, [status]);

  const currentStatus =
    status?.prepared === prepared
      ? status.value
      : prepared
        ? (lastStatusByConnection.get(prepared) ?? null)
        : null;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Poll external model download progress only while the setup dialog is downloading.
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
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Cancel the external recording and queued start when the editor owner changes.
  useEffect(() => {
    if (previousOwnerRef.current === input.ownerKey) return;
    previousOwnerRef.current = input.ownerKey;
    startRequestRef.current += 1;
    setQueuedStart(null);
    controllerRef.current?.ownerChanged();
    setSetupOpen(false);
  }, [input.ownerKey]);

  const start = async () => {
    const request = ++startRequestRef.current;
    const expectedController = controllerRef.current;
    const expectedOwner = latestInputRef.current.ownerKey;
    if (!expectedController || !prepared || !currentStatus?.supported) return;
    const stillCurrent = () =>
      request === startRequestRef.current &&
      controllerRef.current === expectedController &&
      latestInputRef.current.ownerKey === expectedOwner;
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
  };

  const downloadSetupModel = async () => {
    if (!prepared || !currentStatus?.supported || setupDownloading) return;
    setupCancelledRef.current = false;
    setSetupDownloading(true);
    setSetupError(null);
    try {
      await runtime.runPromise(downloadEnvironmentSpeechModel(prepared, currentStatus.modelId));
      if (!setupCancelledRef.current) {
        const next = await runtime.runPromise(getEnvironmentSpeechStatus(prepared));
        setStatus({ prepared, value: next });
        if (!next.supported || next.state === "missing-model") {
          setSetupError("The model is not ready. Try downloading it again.");
        } else {
          setSetupStep(1);
        }
      }
    } catch {
      if (!setupCancelledRef.current)
        setSetupError(
          "Could not download the model. Check this environment's connection and try again.",
        );
    }
    setSetupDownloading(false);
  };

  const cancelSetupDownload = async () => {
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
  };

  const startAfterSetup = async () => {
    setSetupOpen(false);
    await controllerRef.current?.start();
  };

  const browserCanRecord =
    typeof navigator !== "undefined" &&
    Boolean(navigator.mediaDevices?.getUserMedia) &&
    typeof AudioWorkletNode !== "undefined";
  return {
    available: currentStatus?.supported === true && browserCanRecord,
    // Why the mic is off, once the environment has answered; null while loading or available.
    unavailableReason: !currentStatus
      ? null
      : !currentStatus.supported
        ? currentStatus.reason
        : browserCanRecord
          ? null
          : "This browser only records audio on HTTPS or localhost pages.",
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
    blocksSubmission: voiceInputBlocksSubmission(state),
    freezesEditor: voiceInputFreezesEditor(state),
    start,
    stop: () => controllerRef.current?.stop() ?? Promise.resolve(),
    cancel: () => {
      startRequestRef.current += 1;
      setQueuedStart(null);
      controllerRef.current?.cancel();
    },
    skipPostProcessing: () => controllerRef.current?.skipPostProcessing(),
  };
}
