import {
  getEnvironmentSpeechStatus,
  VoiceInputController,
  voiceInputBlocksSubmission,
  voiceInputFreezesEditor,
  type VoiceDraftSnapshot,
  type VoiceInputState,
} from "@t3tools/client-runtime/voice-input";
import type { EnvironmentSpeechStatus, SpeechStreamText } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { useCallback, useEffect, useRef, useState } from "react";

import { useClientSettings, useClientSettingsHydrated } from "../hooks/useSettings";
import { ensureLocalApi } from "../localApi";
import { usePreparedConnection } from "../state/session";
import { runtime } from "../lib/runtime";
import { usePrimaryEnvironmentId } from "../state/environments";
import { createBrowserVoiceInputPlatform } from "./browserVoiceInput";

const INITIAL_STATE: VoiceInputState = { phase: "idle", error: null, errorAction: null };

type DraftInput = {
  readonly text: string;
  readonly selection: { readonly start: number; readonly end: number };
};

type HookInput = {
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
  const microphoneId = useClientSettings((settings) => settings.voiceMicrophone);
  const [status, setStatus] = useState<{
    readonly prepared: NonNullable<typeof prepared>;
    readonly value: EnvironmentSpeechStatus;
  } | null>(null);
  const [controllerState, setControllerState] = useState({ prepared, value: INITIAL_STATE });
  if (controllerState.prepared !== prepared) {
    setControllerState({ prepared, value: INITIAL_STATE });
  }
  const state: VoiceInputState =
    controllerState.prepared === prepared ? controllerState.value : INITIAL_STATE;
  const [level, setLevel] = useState(0);
  const [preview, setPreview] = useState<SpeechStreamText | null>(null);
  const controllerRef = useRef<VoiceInputController | null>(null);
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
    let controller: VoiceInputController;
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
    controller = new VoiceInputController({
      recorder: platform.recorder,
      getTranscriber: () => platform.transcriber,
      requestPermission: async () => ({ granted: true, canAskAgain: true }),
      configureRecording: async () => undefined,
      releaseRecording: async () => platform.cancelRecording(),
      deleteRecording: platform.deleteRecording,
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
    return () => {
      disposed = true;
      controller.dispose();
      if (controllerRef.current === controller) controllerRef.current = null;
    };
  }, [prepared]);

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

  const previousOwnerRef = useRef(input.ownerKey);
  useEffect(() => {
    if (previousOwnerRef.current === input.ownerKey) return;
    previousOwnerRef.current = input.ownerKey;
    controllerRef.current?.ownerChanged();
  }, [input.ownerKey]);

  const start = useCallback(async () => {
    const expectedController = controllerRef.current;
    const expectedOwner = latestInputRef.current.ownerKey;
    if (!expectedController || !prepared) return;
    const freshStatus = await runtime
      .runPromise(getEnvironmentSpeechStatus(prepared))
      .catch(() => null);
    if (controllerRef.current !== expectedController) return;
    if (!freshStatus) {
      setStatus(null);
      return;
    }
    setStatus({ prepared, value: freshStatus });
    if (!freshStatus.supported || freshStatus.state === "transcribing") return;
    if (freshStatus.state === "missing-model") {
      const confirmed = await ensureLocalApi().dialogs.confirm(
        `Download ${freshStatus.model} (${Math.round(freshStatus.size / 1024 / 1024)} MB) to this T3 environment? Recordings will be sent to this environment for transcription and deleted after use.`,
      );
      if (!confirmed) return;
    }
    const controller = controllerRef.current;
    if (controller !== expectedController || latestInputRef.current.ownerKey !== expectedOwner)
      return;
    setLevel(0);
    await controller.start();
  }, [prepared]);

  return {
    available:
      currentStatus?.supported === true &&
      typeof navigator !== "undefined" &&
      Boolean(navigator.mediaDevices?.getUserMedia) &&
      typeof AudioWorkletNode !== "undefined",
    status: currentStatus,
    state,
    progress: null,
    preview: state.phase === "recording" || state.phase === "transcribing" ? preview : null,
    level,
    blocksSubmission: voiceInputBlocksSubmission(state),
    freezesEditor: voiceInputFreezesEditor(state),
    start,
    stop: useCallback(() => controllerRef.current?.stop() ?? Promise.resolve(), []),
    cancel: useCallback(() => controllerRef.current?.cancel(), []),
  };
}
