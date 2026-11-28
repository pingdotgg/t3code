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
 * A notification for the thread on screen stays silent once its feed is live. While that thread
 * is cached, reconnecting or still catching up, the screen may not have the event yet.
 */
export function foregroundNotificationBehavior(
  notification: Notification,
  deepLinkOnScreen: string | null,
  hasLiveFeed: (deepLink: string) => boolean,
): NotificationBehavior {
  const target = extractAgentNotificationDeepLink({ notification });
  if (target !== null && target === deepLinkOnScreen && hasLiveFeed(target)) {
    return SUPPRESS;
  }
  return SHOW;
}
