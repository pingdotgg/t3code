import { useEffect, useRef } from "react";
import * as Notifications from "expo-notifications";
import { useRouter } from "expo-router";

import { routeAgentNotificationResponseOnce } from "./notificationPayload";

export function useAgentNotificationNavigation(): void {
  const router = useRouter();
  const handledResponseIds = useRef(new Set<string>());

  useEffect(() => {
    const handleResponse = (response: Notifications.NotificationResponse): void => {
      routeAgentNotificationResponseOnce({
        handledResponseIds: handledResponseIds.current,
        response,
        navigate: (deepLink) => router.push(deepLink as never),
      });
    };

    const subscription = Notifications.addNotificationResponseReceivedListener(handleResponse);
    void Notifications.getLastNotificationResponseAsync()
      .then((response) => {
        if (response) {
          handleResponse(response);
          return Notifications.clearLastNotificationResponseAsync();
        }
        return undefined;
      })
      .catch(() => undefined);

    return () => {
      subscription.remove();
    };
  }, [router]);
}
