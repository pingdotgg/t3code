import type { Notification, NotificationBehavior } from "expo-notifications";

import { extractAgentNotificationDeepLink } from "./notificationPayload";

const SHOW: NotificationBehavior = {
  shouldShowBanner: true,
  shouldShowList: true,
  shouldPlaySound: true,
  shouldSetBadge: false,
};

const SUPPRESS: NotificationBehavior = {
  shouldShowBanner: false,
  shouldShowList: false,
  shouldPlaySound: false,
  shouldSetBadge: false,
};

/**
 * Decides how a notification that arrives while the app is open is presented.
 * A notification for the thread already on screen is redundant with the live
 * feed, so it stays silent; everything else banners like it would in the
 * background. `deepLinkOnScreen` is the normalized `/threads/:env/:thread`
 * path of the current route, or null when no thread is open.
 */
export function foregroundNotificationBehavior(
  notification: Notification,
  deepLinkOnScreen: string | null,
): NotificationBehavior {
  const target = extractAgentNotificationDeepLink({ notification });
  if (target !== null && target === deepLinkOnScreen) {
    return SUPPRESS;
  }
  return SHOW;
}
