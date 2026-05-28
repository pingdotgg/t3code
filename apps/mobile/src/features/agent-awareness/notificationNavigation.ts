import { useEffect } from "react";
import * as Notifications from "expo-notifications";
import { useRouter } from "expo-router";

import { extractAgentNotificationDeepLink } from "./notificationPayload";

export function useAgentNotificationNavigation(): void {
  const router = useRouter();

  useEffect(() => {
    const handleResponse = (response: unknown): void => {
      const deepLink = extractAgentNotificationDeepLink(response);
      if (deepLink) {
        router.push(deepLink as never);
      }
    };

    const subscription = Notifications.addNotificationResponseReceivedListener(handleResponse);
    void Notifications.getLastNotificationResponseAsync()
      .then((response) => {
        if (response) {
          handleResponse(response);
        }
      })
      .catch(() => undefined);

    return () => {
      subscription.remove();
    };
  }, [router]);
}
