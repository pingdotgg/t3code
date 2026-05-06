import { useCallback, useEffect, useState } from "react";

import {
  getNotificationPermission,
  requestNotificationPermission,
} from "../lib/nativeNotifications";

export function useNotification() {
  const [permission, setPermission] = useState(getNotificationPermission());

  const refresh = useCallback(() => {
    setPermission(getNotificationPermission());
  }, []);

  const requestPermission = useCallback(async () => {
    const next = await requestNotificationPermission();
    setPermission(next);
  }, []);

  useEffect(() => {
    refresh();
    window.addEventListener("focus", refresh);

    return () => {
      window.removeEventListener("focus", refresh);
    };
  }, [refresh]);

  return { permission, requestPermission, refresh };
}
