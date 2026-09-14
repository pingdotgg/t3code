import { useFocusEffect } from "@react-navigation/native";
import {
  createLiveVoiceController,
  type LiveVoiceControllerDependencies,
} from "@t3tools/client-runtime/live-voice";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import { type EnvironmentId, type ThreadId, WS_METHODS } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { AppState } from "react-native";

import { connectionAtomRuntime } from "../../connection/runtime";
import { useAtomCommand } from "../../state/use-atom-command";
import { createNativeLiveVoiceTransport } from "./nativeLiveVoiceTransport";
import {
  isLiveVoiceMicrophoneReserved,
  subscribeLiveVoiceMicrophone,
} from "./microphoneReservation";

const startVoice = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "mobile:voice:start",
  tag: WS_METHODS.voiceStart,
});
const stopVoice = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "mobile:voice:stop",
  tag: WS_METHODS.voiceStop,
});

function createVoiceStore(dependencies: Omit<LiveVoiceControllerDependencies, "onStateChange">) {
  const listeners = new Set<() => void>();
  const controller = createLiveVoiceController({
    ...dependencies,
    onStateChange(next) {
      snapshot = next;
      listeners.forEach((listener) => listener());
    },
  });
  let snapshot = controller.getState();
  return {
    controller,
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export function useLiveVoice(input: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  connected: boolean;
}) {
  const startSession = useAtomCommand(startVoice, { reportFailure: false });
  const stopSession = useAtomCommand(stopVoice, { reportFailure: false });
  const { environmentId, threadId } = input;
  const store = useMemo(() => {
    return createVoiceStore({
      createTransport: createNativeLiveVoiceTransport,
      async startSession({ sdp, signal }) {
        signal.throwIfAborted();
        // Keep observing a dispatched request even after cancellation, so a
        // late-created server session can be closed by the shared controller.
        const result = await startSession({ environmentId, input: { threadId, sdp } });
        if (AsyncResult.isFailure(result)) throw Cause.squash(result.cause);
        return result.value;
      },
      async stopSession(sessionId) {
        const result = await stopSession({ environmentId, input: { sessionId } });
        if (AsyncResult.isFailure(result)) throw Cause.squash(result.cause);
      },
    });
  }, [environmentId, threadId, startSession, stopSession]);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const microphoneOwned = useSyncExternalStore(
    subscribeLiveVoiceMicrophone,
    isLiveVoiceMicrophoneReserved,
    isLiveVoiceMicrophoneReserved,
  );

  useFocusEffect(useCallback(() => () => void store.controller.stop(), [store]));
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) => {
      // iOS becomes inactive while displaying its microphone permission prompt.
      if (next === "background") void store.controller.stop();
    });
    return () => {
      subscription.remove();
      void store.controller.stop();
    };
  }, [store]);
  useEffect(() => {
    if (!input.connected) void store.controller.stop();
  }, [input.connected, store]);

  return {
    state,
    isActive: state.status === "connecting" || state.status === "connected",
    ownsMicrophone:
      microphoneOwned || state.status === "connecting" || state.status === "connected",
    start: () => {
      if (input.connected && AppState.currentState === "active") void store.controller.start();
    },
    stop: () => void store.controller.stop(),
    setMuted: (muted: boolean) => store.controller.setMuted(muted),
  };
}
