import {
  getEnvironmentSpeechStatus,
  VoiceInputController,
  voiceInputBlocksSubmission,
  voiceInputFreezesEditor,
  type VoiceDraftSnapshot,
  type VoiceInputState,
} from "@t3tools/client-runtime/voice-input";
import type { EnvironmentId, EnvironmentSpeechStatus } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { useCallback, useEffect, useRef, useState } from "react";

import { useClientSettings } from "../hooks/useSettings";
import { ensureLocalApi } from "../localApi";
import { usePreparedConnection } from "../state/session";
import { runtime } from "../lib/runtime";
import { createBrowserVoiceInputPlatform } from "./browserVoiceInput";

const INITIAL_STATE: VoiceInputState = { phase: "idle", error: null, errorAction: null };

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
  const prepared = Option.getOrNull(usePreparedConnection(input.environmentId));
  const microphoneId = useClientSettings((settings) => settings.voiceMicrophone);
  const [status, setStatus] = useState<EnvironmentSpeechStatus | null>(null);
  const [state, setState] = useState<VoiceInputState>(INITIAL_STATE);
  const [level, setLevel] = useState(0);
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

    let controller: VoiceInputController;
    const platform = createBrowserVoiceInputPlatform({
      prepared,
      getMicrophoneId: () => microphoneIdRef.current,
      onLevel: setLevel,
      onDurationLimit: () => void controller.stop(),
    });
    controller = new VoiceInputController({
      recorder: platform.recorder,
      getTranscriber: () => platform.transcriber,
      requestPermission: async () => ({ granted: true, canAskAgain: true }),
      configureRecording: async () => undefined,
      releaseRecording: platform.cancelRecording,
      deleteRecording: platform.deleteRecording,
      readDraft,
      commitDraft: (text, selection) => latestInputRef.current.commitDraft(text, selection),
      onStateChange: setState,
    });
    controllerRef.current = controller;
    return () => {
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
        if (!disposed) setStatus(next);
      })
      .catch(() => {
        if (!disposed) setStatus(null);
      });
    return () => {
      disposed = true;
    };
  }, [prepared]);

  const previousOwnerRef = useRef(input.ownerKey);
  useEffect(() => {
    if (previousOwnerRef.current === input.ownerKey) return;
    previousOwnerRef.current = input.ownerKey;
    controllerRef.current?.ownerChanged();
  }, [input.ownerKey]);

  const start = useCallback(async () => {
    const controller = controllerRef.current;
    if (!controller || !status?.supported) return;
    if (status.state === "missing-model") {
      const confirmed = await ensureLocalApi().dialogs.confirm(
        "Download a 48 MiB English speech model to this T3 environment? Recordings will be sent to this environment for transcription and deleted after use.",
      );
      if (!confirmed) return;
    }
    setLevel(0);
    await controller.start();
  }, [status]);

  return {
    available:
      status?.supported === true &&
      typeof navigator !== "undefined" &&
      Boolean(navigator.mediaDevices?.getUserMedia),
    status,
    state,
    progress: null,
    level,
    blocksSubmission: voiceInputBlocksSubmission(state),
    freezesEditor: voiceInputFreezesEditor(state),
    start,
    stop: useCallback(() => controllerRef.current?.stop() ?? Promise.resolve(), []),
    cancel: useCallback(() => controllerRef.current?.cancel(), []),
  };
}
