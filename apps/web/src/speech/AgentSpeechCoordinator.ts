import { threadKey } from "@t3tools/client-runtime/state/entities";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { AnyRouter } from "@tanstack/react-router";
import * as DateTime from "effect/DateTime";
import type { AtomRegistry } from "effect/reactivity";

import { getClientSettings, subscribeClientSettings } from "../hooks/useSettings";
import { environmentThreadDetails } from "../state/threads";
import {
  createSpeechTracker,
  nextSpeechActions,
  type ObservedMessage,
  type SpeechTracker,
} from "./agentSpeech.logic";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";

import { primaryEnvironmentIdAtom } from "../state/primaryEnvironment";
import { readAloudEnvironment } from "../state/readAloud";
import { appendSpeech, registerHostSpeech, speak, stopSpeaking } from "./speechPlayer";
import { speakableText } from "./speechText";

/**
 * Reads new agent messages in the open thread aloud when Read aloud is on. It only watches the
 * thread on screen, and history present when the thread opened is never read automatically.
 */
export function startAgentSpeech(registry: AtomRegistry.AtomRegistry, router: AnyRouter) {
  registerHostSpeech({
    speak: async (input) => {
      const environmentId = registry.get(primaryEnvironmentIdAtom);
      if (environmentId === null) return "failed";
      const result = await runAtomCommand(
        registry,
        readAloudEnvironment.speak,
        { environmentId, input },
        { reportFailure: false },
      );
      if (result._tag !== "Success") return "failed";
      return result.value.completed ? "completed" : "interrupted";
    },
    stop: () => {
      const environmentId = registry.get(primaryEnvironmentIdAtom);
      if (environmentId === null) return;
      void runAtomCommand(
        registry,
        readAloudEnvironment.stop,
        { environmentId, input: {} },
        { reportFailure: false },
      );
    },
  });
  let watchedKey: string | null = null;
  let unsubscribeThread = () => {};
  let tracker: SpeechTracker | null = null;

  const activeThread = () => {
    const params = (router.state.matches.at(-1)?.params ?? {}) as {
      environmentId?: EnvironmentId;
      threadId?: ThreadId;
    };
    return params.environmentId && params.threadId
      ? { environmentId: params.environmentId, threadId: params.threadId }
      : null;
  };

  const observe = (messages: ReadonlyArray<ObservedMessage>) => {
    const settings = getClientSettings().speech;
    if (tracker === null) {
      tracker = createSpeechTracker(messages, Date.now());
      return;
    }
    if (!settings.autoRead) {
      // Keep up with the thread so turning it on later does not read a backlog.
      for (const message of messages) tracker.done.add(message.id);
      return;
    }
    for (const action of nextSpeechActions(tracker, messages, settings)) {
      const text = speakableText(action.markdown, settings);
      const source = { id: action.messageId, label: "Agent message" };
      if (action.type === "speak") speak(text, settings, source);
      else appendSpeech(text, settings, source);
    }
  };

  const watch = () => {
    const ref = activeThread();
    const key = ref === null ? null : threadKey(ref);
    if (key === watchedKey) return;
    if (watchedKey !== null && getClientSettings().speech.stopOnThreadSwitch) stopSpeaking();
    unsubscribeThread();
    watchedKey = key;
    tracker = null;
    if (ref === null) {
      unsubscribeThread = () => {};
      return;
    }
    unsubscribeThread = registry.subscribe(
      environmentThreadDetails.threadAtom(ref),
      (thread) => {
        if (thread === null) return;
        observe(
          thread.projection.messages.map((message) => ({
            id: message.id,
            role: message.role,
            text: message.text,
            streaming: message.streaming,
            createdAt: DateTime.toEpochMillis(message.createdAt),
          })),
        );
      },
      { immediate: true },
    );
  };

  const unsubscribeRoute = router.subscribe("onResolved", watch);
  let wasAutoRead = getClientSettings().speech.autoRead;
  const unsubscribeSettings = subscribeClientSettings(() => {
    const autoRead = getClientSettings().speech.autoRead;
    if (wasAutoRead && !autoRead) stopSpeaking();
    wasAutoRead = autoRead;
  });
  watch();
  return () => {
    registerHostSpeech(null);
    unsubscribeRoute();
    unsubscribeSettings();
    unsubscribeThread();
    stopSpeaking();
  };
}
