import * as Notifications from "expo-notifications";
import { Platform, useColorScheme } from "react-native";
import { useEffect, useMemo } from "react";

import { useProjects, useThreadShells } from "../../state/entities";
import { buildLocalAgentActivityAggregate } from "./localAgentActivityAggregate";
import { syncOngoingAgentNotification } from "./ongoingNotificationSync";

async function readAndroidNotificationsEnabled(): Promise<boolean> {
  if (Platform.OS !== "android") {
    return false;
  }
  const permissions = await Notifications.getPermissionsAsync();
  return permissions.status === "granted";
}

export function useOngoingAgentNotification(): void {
  const projects = useProjects();
  const threads = useThreadShells();
  const colorScheme = useColorScheme() === "light" ? "light" : "dark";

  const aggregate = useMemo(
    () => buildLocalAgentActivityAggregate({ projects, threads }),
    [projects, threads],
  );

  useEffect(() => {
    if (Platform.OS !== "android") {
      return;
    }

    let cancelled = false;
    void (async () => {
      const notificationsEnabled = await readAndroidNotificationsEnabled();
      if (cancelled) {
        return;
      }
      await syncOngoingAgentNotification({
        aggregate,
        notificationsEnabled,
        colorScheme,
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [aggregate, colorScheme]);
}
