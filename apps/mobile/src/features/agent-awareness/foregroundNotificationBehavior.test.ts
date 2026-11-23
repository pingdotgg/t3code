import type { Notification } from "expo-notifications";
import { describe, expect, it } from "vite-plus/test";

import { foregroundNotificationBehavior } from "./foregroundNotificationBehavior";

function notificationFor(deepLink: string): Notification {
  return {
    date: 0,
    request: { identifier: "notification-1", content: { data: { deepLink } }, trigger: null },
  } as unknown as Notification;
}

describe("foregroundNotificationBehavior", () => {
  const onScreen = "/threads/env-1/thread-1";

  it("stays silent for the thread on screen once its feed is live", () => {
    const behavior = foregroundNotificationBehavior(
      notificationFor(onScreen),
      onScreen,
      () => true,
    );
    expect(behavior.shouldShowBanner).toBe(false);
    expect(behavior.shouldPlaySound).toBe(false);
  });

  it("shows the alert while the thread on screen is cached or reconnecting", () => {
    const checked: Array<string> = [];
    const behavior = foregroundNotificationBehavior(notificationFor(onScreen), onScreen, (link) => {
      checked.push(link);
      return false;
    });
    expect(behavior.shouldShowBanner).toBe(true);
    expect(behavior.shouldShowList).toBe(true);
    expect(behavior.shouldPlaySound).toBe(true);
    expect(checked).toEqual([onScreen]);
  });
});
