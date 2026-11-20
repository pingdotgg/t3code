import { useGT } from "gt-react-native";
import { useAtomValue } from "@effect/atom-react";
import { Atom, AsyncResult } from "effect/reactivity";
import { useEffect, useEffectEvent, useState } from "react";
import { AppState } from "react-native";
import * as Notifications from "expo-notifications";
import type { DirectPushDelivery, EnvironmentId } from "@t3tools/contracts";
import { useEnvironments } from "../../state/environments";
import { useThreadShells } from "../../state/entities";
import { mobilePreferencesAtom } from "../../state/preferences";
import { appAtomRegistry } from "../../state/atom-registry";
import { supportsDirectPush } from "./capabilities";
import { disableDirectPush, rememberDirectPushToken, syncDirectPush } from "./directRegistration";
import {
  endLocalLiveActivities,
  updateAgentAwarenessRegistrationPreferences,
} from "./remoteRegistration";
import { runtime } from "../../lib/runtime";

export const directPushStatusAtom = Atom.make<ReadonlyMap<EnvironmentId, string>>(new Map());
function setStatus(id: EnvironmentId, status: string) {
  appAtomRegistry.set(
    directPushStatusAtom,
    new Map(appAtomRegistry.get(directPushStatusAtom)).set(id, status),
  );
}
export const directPushDeliveryAtom = Atom.make<ReadonlyMap<EnvironmentId, DirectPushDelivery>>(
  new Map(),
);
function setDelivery(id: EnvironmentId, delivery: DirectPushDelivery | undefined) {
  const next = new Map(appAtomRegistry.get(directPushDeliveryAtom));
  if (delivery) next.set(id, delivery);
  else next.delete(id);
  appAtomRegistry.set(directPushDeliveryAtom, next);
}

function Coordinator() {
  const gt = useGT();
  const { environments } = useEnvironments();
  const threads = useThreadShells();
  const preferences = useAtomValue(mobilePreferencesAtom);
  const [refresh, setRefresh] = useState(0);
  const enabled =
    AsyncResult.isSuccess(preferences) && preferences.value.directPushEnabled === true;
  const liveEnabled =
    AsyncResult.isSuccess(preferences) && preferences.value.directLiveActivitiesEnabled !== false;
  const loaded = AsyncResult.isSuccess(preferences);
  const chosen = loaded && preferences.value.directPushEnabled !== undefined;
  // Work on all environments, without transcript subscriptions or timestamp-only refreshes.
  const connectionKey = JSON.stringify(
    environments.map((entry) => [entry.environmentId, entry.connection.phase]),
  );
  const activityKey = JSON.stringify(
    threads.map((thread) => [
      thread.environmentId,
      thread.id,
      thread.archivedAt,
      thread.hasPendingApprovals,
      thread.hasPendingUserInput,
      thread.runtime?.status,
      thread.runtime?.activeRunId,
      thread.latestRun?.status,
      thread.title,
    ]),
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- listens for app foregrounding and push token rotation
  useEffect(() => {
    const app = AppState.addEventListener("change", (state) => {
      if (state === "active") setRefresh((n) => n + 1);
    });
    const tokens = Notifications.addPushTokenListener((token) => {
      if (rememberDirectPushToken(token)) setRefresh((n) => n + 1);
    });
    return () => {
      app.remove();
      tokens.remove();
    };
  }, []);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- installs the native notification handler while direct push is on
  useEffect(() => {
    if (!enabled) return;
    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldPlaySound: true,
        shouldSetBadge: false,
        shouldShowBanner: true,
        shouldShowList: true,
      }),
    });
    return () => Notifications.setNotificationHandler(null);
  }, [enabled]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps native Live Activities and the server's preference in step with the direct push setting
  useEffect(() => {
    if (!chosen) return;
    if (enabled) endLocalLiveActivities("Could not close the Cloud Connect Live Activity.");
    void runtime
      .runPromise(updateAgentAwarenessRegistrationPreferences({ directPushEnabled: enabled }))
      .catch(() => {
        console.warn("Could not update Cloud Connect notification preferences.");
      });
  }, [enabled, chosen]);

  const disableConnected = useEffectEvent(() => {
    for (const environment of environments) {
      if (environment.connection.phase === "connected") {
        void disableDirectPush(environment.environmentId)
          .then(() => setStatus(environment.environmentId, gt("Disabled")))
          .catch(() =>
            setStatus(
              environment.environmentId,
              gt("Could not disable delivery. Reconnect to retry."),
            ),
          );
      }
    }
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- turns direct push off on each server as it connects, backgrounded or not
  useEffect(() => {
    if (!chosen || enabled) return;
    disableConnected();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- connection changes and app foregrounding repeat the disable
  }, [connectionKey, chosen, enabled, refresh]);

  const registerConnected = useEffectEvent((isCancelled: () => boolean) => {
    for (const environment of environments) {
      if (environment.connection.phase !== "connected") continue;
      const id = environment.environmentId;
      setStatus(id, gt("Registering…"));
      void syncDirectPush(id, liveEnabled)
        .then((status) => {
          if (isCancelled()) return;
          setDelivery(id, status?.lastDelivery);
          setStatus(
            id,
            status?.registered
              ? gt("Registered with Apple notification delivery")
              : gt("APNs setup needed on this server"),
          );
        })
        .catch((error: unknown) => {
          if (!isCancelled())
            setStatus(
              id,
              error instanceof Error
                ? error.message
                : gt("Registration failed. Reconnect to retry."),
            );
        });
    }
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers each connected server for direct push, coalescing bursts of shell updates
  useEffect(() => {
    if (!loaded || !enabled) return;
    let cancelled = false;
    const timer = setTimeout(() => registerConnected(() => cancelled), 500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- connection, thread activity, setting and foreground changes repeat the registration
  }, [connectionKey, activityKey, enabled, liveEnabled, loaded, refresh]);
  return null;
}
export function DirectPushCoordinator() {
  return supportsDirectPush() ? <Coordinator /> : null;
}
