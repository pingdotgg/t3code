import {
  VoiceInputController,
  type VoiceDraftSnapshot,
  type VoiceInputState,
} from "@t3tools/client-runtime/voice-input";
import type { DesktopSpeechStatus } from "@t3tools/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import { ensureLocalApi } from "../localApi";
import { createDesktopVoiceInputPlatform } from "./desktopVoiceInput";

const INITIAL_STATE: VoiceInputState = { phase: "idle", error: null, errorAction: null };

type DraftInput = {
  readonly text: string;
  readonly selection: { readonly start: number; readonly end: number };
};

export function useDesktopSpeechInput(input: {
  readonly ownerKey: string;
  readonly draftText: string;
  readonly readDraft: () => DraftInput;
  readonly commitDraft: (
    text: string,
    selection: { readonly start: number; readonly end: number },
  ) => void;
}) {
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge?.speech;
  const [available, setAvailable] = useState(false);
  const [modelStatus, setModelStatus] = useState<DesktopSpeechStatus | null>(null);
  const [state, setState] = useState<VoiceInputState>(INITIAL_STATE);
  const [progress, setProgress] = useState<{ downloaded: number; total: number } | null>(null);
  const [level, setLevel] = useState(0);
  const controllerRef = useRef<VoiceInputController | null>(null);
  const latestInputRef = useRef(input);
  latestInputRef.current = input;
  const draftRevisionRef = useRef({ ownerKey: input.ownerKey, text: input.draftText, revision: 0 });
  if (
    draftRevisionRef.current.ownerKey !== input.ownerKey ||
    draftRevisionRef.current.text !== input.draftText
  ) {
    draftRevisionRef.current = {
      ownerKey: input.ownerKey,
      text: input.draftText,
      revision: draftRevisionRef.current.revision + 1,
    };
  }

  if (!controllerRef.current && bridge) {
    const platform = createDesktopVoiceInputPlatform(bridge);

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

    const controller = new VoiceInputController({
      recorder: platform.recorder,
      getTranscriber: () => platform.transcriber,
      requestPermission: async () => ({ granted: true, canAskAgain: true }),
      configureRecording: async () => undefined,
      releaseRecording: () => bridge.cancelRecording(),
      deleteRecording: (uri) => void bridge.deleteRecording(uri),
      readDraft,
      commitDraft: (text, selection) => latestInputRef.current.commitDraft(text, selection),
      onStateChange: setState,
    });
    platform.setDurationLimitHandler(() => void controller.stop());
    controllerRef.current = controller;
  }

  const controller = controllerRef.current;

  useEffect(() => {
    if (!bridge) return;
    let disposed = false;
    void bridge.getStatus().then((status) => {
      if (disposed) return;
      setModelStatus(status);
      setAvailable(status.supported);
    });
    const unsubscribe = bridge.onEvent((event) => {
      if (event.type === "status") {
        setModelStatus(event.status);
        setAvailable(event.status.supported);
      } else if (event.type === "download-progress") {
        setProgress({ downloaded: event.downloaded, total: event.total });
      } else if (event.type === "level") {
        setLevel(event.level);
      }
    });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [bridge]);

  const previousOwnerRef = useRef(input.ownerKey);
  useEffect(() => {
    if (!controller || previousOwnerRef.current === input.ownerKey) return;
    previousOwnerRef.current = input.ownerKey;
    controller.ownerChanged();
  }, [controller, input.ownerKey]);

  useEffect(() => () => controller?.dispose(), [controller]);

  useEffect(() => {
    if (!controller || state.phase !== "recording") return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      controller.cancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [controller, state.phase]);

  const start = useCallback(async () => {
    if (!controller) return;
    if (!modelStatus || (modelStatus.supported && modelStatus.state === "missing-model")) {
      const confirmed = await ensureLocalApi().dialogs.confirm(
        "Download a 48 MiB English speech model? Voice input is processed locally and microphone audio is not saved.",
      );
      if (!confirmed) return;
    }
    setProgress(null);
    setLevel(0);
    await controller.start();
  }, [controller, modelStatus]);

  return {
    available,
    state,
    progress,
    level,
    start,
    stop: useCallback(() => controller?.stop() ?? Promise.resolve(), [controller]),
    cancel: useCallback(() => controller?.cancel(), [controller]),
  };
}
