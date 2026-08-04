import * as Option from "effect/Option";
import { AsyncResult, type AtomRegistry } from "effect/unstable/reactivity";

import { savePreferencesPatch } from "../../persistence/imperative";
import type { Preferences } from "../../persistence/mobile-preferences";
import { mobilePreferencesAtom } from "../../state/preferences";
import { environmentThreadShells } from "../../state/threads";
import { presentAndroidThreadNotification } from "./android-thread-notifications";
import {
  createThreadNotificationState,
  reduceThreadNotifications,
  type ThreadNotificationEvent,
} from "./thread-notification-reducer";

interface ThreadNotificationService {
  readonly start: () => void;
  readonly stop: () => void;
}

interface ThreadNotificationServiceDependencies {
  readonly present: (event: ThreadNotificationEvent) => Promise<void>;
  readonly persistEventIds: (eventIds: readonly string[]) => Promise<unknown>;
}

const defaultDependencies: ThreadNotificationServiceDependencies = {
  present: presentAndroidThreadNotification,
  persistEventIds: (eventIds) =>
    savePreferencesPatch({ androidAgentNotificationEventIds: eventIds }),
};

export function createThreadNotificationService(
  registry: AtomRegistry.AtomRegistry,
  dependencies: ThreadNotificationServiceDependencies = defaultDependencies,
): ThreadNotificationService {
  let started = false;
  let preferences: Preferences | null = null;
  let threads = registry.get(environmentThreadShells.threadShellsAtom);
  let state = createThreadNotificationState();
  let work = Promise.resolve();
  let preferencesRelease: (() => void) | null = null;
  let threadsRelease: (() => void) | null = null;

  const reduce = () => {
    if (!started || preferences === null) return;
    const reduction = reduceThreadNotifications(state, threads);
    state = reduction.state;
    if (!preferences.androidAgentNotificationsEnabled || reduction.events.length === 0) return;

    const eventIds = [...state.emittedEventIds];
    work = work
      .then(async () => {
        for (const event of reduction.events) {
          await dependencies.present(event);
        }
        await dependencies.persistEventIds(eventIds);
      })
      .catch((error) => {
        console.error("[agent-notifications] failed to deliver Android notification", error);
      });
  };

  return {
    start() {
      if (started) return;
      started = true;
      preferencesRelease = registry.subscribe(
        mobilePreferencesAtom,
        (result) => {
          const nextPreferences = Option.getOrNull(AsyncResult.value(result));
          if (nextPreferences === null) return;
          const wasLoaded = preferences !== null;
          preferences = nextPreferences;
          if (!wasLoaded) {
            state = createThreadNotificationState(
              nextPreferences.androidAgentNotificationEventIds ?? [],
            );
          }
          reduce();
        },
        { immediate: true },
      );
      threadsRelease = registry.subscribe(
        environmentThreadShells.threadShellsAtom,
        (nextThreads) => {
          threads = nextThreads;
          reduce();
        },
        { immediate: true },
      );
    },
    stop() {
      if (!started) return;
      started = false;
      preferencesRelease?.();
      preferencesRelease = null;
      threadsRelease?.();
      threadsRelease = null;
    },
  };
}

export function acquireThreadNotificationService(registry: AtomRegistry.AtomRegistry): () => void {
  const service = createThreadNotificationService(registry);
  service.start();
  return () => service.stop();
}
