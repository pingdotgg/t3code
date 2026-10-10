import { useAtomValue } from "@effect/atom-react";
import { useEffect, useMemo } from "react";
import { AppState } from "react-native";

import { environmentPresentations } from "../state/presentation";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import { createWidgetRefresher, WIDGET_REFRESH_INTERVAL } from "./subscriptionUsageSnapshot";

export function useSubscriptionUsage(enabled = true) {
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const refresh = useMemo(
    () =>
      createWidgetRefresher(
        (environmentId: Parameters<typeof refreshProviders>[0]["environmentId"]) =>
          refreshProviders({ environmentId, input: {} }),
      ),
    [refreshProviders],
  );

  useEffect(() => {
    const update = () => {
      if (!enabled || AppState.currentState !== "active") return;
      const connected = [...presentations]
        .filter(([, presentation]) => presentation.connection.phase === "connected")
        .map(([id]) => id);
      void refresh(connected, Date.now());
    };
    update();
    const subscription = AppState.addEventListener("change", update);
    const timer = setInterval(update, WIDGET_REFRESH_INTERVAL);
    return () => {
      subscription.remove();
      clearInterval(timer);
    };
  }, [enabled, presentations, refresh]);
}
