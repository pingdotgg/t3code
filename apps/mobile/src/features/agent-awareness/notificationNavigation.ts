import { useEffect, useRef } from "react";
import * as Notifications from "expo-notifications";
import { useLinkTo } from "@react-navigation/native";

import { routeAgentNotificationResponseOnce } from "./notificationPayload";
import { consumeLastAgentNotificationResponse } from "./notificationResponseConsumer";

export function useAgentNotificationNavigation(): void {
  const linkTo = useLinkTo();
  const handledResponseIds = useRef(new Set<string>());

  useEffect(() => {
    const handleResponse = (response: Notifications.NotificationResponse): void => {
      routeAgentNotificationResponseOnce({
        handledResponseIds: handledResponseIds.current,
        response,
        navigate: linkTo,
      });
    };

    const subscription = Notifications.addNotificationResponseReceivedListener(handleResponse);
    void consumeLastAgentNotificationResponse({
      getLastResponse: () => Notifications.getLastNotificationResponseAsync(),
      clearLastResponse: () => Notifications.clearLastNotificationResponseAsync(),
      handleResponse,
    });

    return () => {
      subscription.remove();
    };
  }, [linkTo]);
}
