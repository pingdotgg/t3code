import { createLiveVoiceController } from "@t3tools/client-runtime/live-voice";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS, type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { useCallback, useEffect, useRef, useState } from "react";

import { connectionAtomRuntime } from "~/connection/runtime";
import { useAtomCommand } from "~/state/use-atom-command";
import { createBrowserVoiceTransport } from "./browserVoiceTransport";

const startVoice = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "voice:start",
  tag: WS_METHODS.voiceStart,
});
const stopVoice = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "voice:stop",
  tag: WS_METHODS.voiceStop,
});

type Controller = ReturnType<typeof createLiveVoiceController>;
export type VoiceChatState = ReturnType<Controller["getState"]>;

const initialState: VoiceChatState = { status: "idle", muted: false, error: null, transcript: [] };

export function useVoiceChat(
  environmentId: EnvironmentId,
  threadId: ThreadId | null,
  unavailable: boolean,
) {
  const startSession = useAtomCommand(startVoice, { reportFailure: false });
  const stopSession = useAtomCommand(stopVoice, { reportFailure: false });
  const controllerRef = useRef<Controller | null>(null);
  const retiringRef = useRef<Promise<void> | null>(null);
  const [state, setState] = useState<VoiceChatState>(initialState);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let active = true;
    const previousRetirement = retiringRef.current;
    const controller: Controller = createLiveVoiceController({
      createTransport: async (callbacks) => {
        // A permission prompt from the previous thread may still own the microphone request.
        await previousRetirement;
        if (!active || controller.getState().status !== "connecting") {
          throw new Error("Voice chat was cancelled.");
        }
        return createBrowserVoiceTransport(callbacks);
      },
      startSession: async ({ sdp, signal }) => {
        if (!threadId || signal.aborted)
          throw new Error("Open an existing thread to start voice chat.");
        // Keep the receipt even after cancellation so the controller can end a late session.
        const result = await startSession({ environmentId, input: { threadId, sdp } });
        if (result._tag !== "Success") throw Cause.squash(result.cause);
        return result.value;
      },
      stopSession: async (sessionId) => {
        const result = await stopSession({ environmentId, input: { sessionId } });
        if (result._tag !== "Success") throw Cause.squash(result.cause);
      },
      onStateChange: (next) => {
        if (active) setState(next);
      },
    });
    controllerRef.current = controller;
    setState(controller.getState());
    setOpen(false);
    const stopForBackground = () => {
      void controller.stop();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") stopForBackground();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pagehide", stopForBackground);
    return () => {
      active = false;
      controllerRef.current = null;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pagehide", stopForBackground);
      retiringRef.current = controller.dispose();
    };
  }, [environmentId, threadId, startSession, stopSession]);

  useEffect(() => {
    if (unavailable) void controllerRef.current?.stop();
  }, [unavailable]);

  const start = useCallback(() => {
    if (!threadId || unavailable) return;
    setOpen(true);
    void controllerRef.current?.start();
  }, [threadId, unavailable]);
  const close = useCallback(() => {
    setOpen(false);
    void controllerRef.current?.stop();
  }, []);
  const setMuted = useCallback((muted: boolean) => controllerRef.current?.setMuted(muted), []);

  return { state, open, start, close, setMuted };
}
