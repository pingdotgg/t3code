import * as Notifications from "expo-notifications";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";

import { appAtomRegistry } from "../../state/atom-registry";
import { environmentPresentations } from "../../state/presentation";
import { environmentThreads } from "../../state/threads";
import { setAndroidThreadOnScreen } from "./androidNotifications";
import { foregroundNotificationBehavior } from "./foregroundNotificationBehavior";
import { routeAgentNotificationResponseOnce, threadDeepLinkOnScreen } from "./notificationPayload";
import { consumeLastAgentNotificationResponse } from "./notificationResponseConsumer";

let deepLinkOnScreen: string | null = null;

/** Whether the open thread's screen is connected and showing its live feed, not a cached copy. */
function threadHasLiveFeed(deepLink: string): boolean {
  const [, , environment, thread] = deepLink.split("/");
  if (!environment || !thread) return false;
  const environmentId = EnvironmentId.make(decodeURIComponent(environment));
  const presentation = appAtomRegistry.get(
    environmentPresentations.presentationAtom(environmentId),
  );
  if (presentation?.connection.phase !== "connected") return false;
  const threadAtom = environmentThreads.stateAtom(
    environmentId,
    ThreadId.make(decodeURIComponent(thread)),
  );
  // The thread screen holds its detail; reading one nobody holds would start loading it.
  if (!appAtomRegistry.getNodes().has(threadAtom)) return false;
  return Option.exists(
    AsyncResult.value(appAtomRegistry.get(threadAtom)),
    ({ status }) => status === "live",
  );
}

/** Called with the workspace pathname on every root navigation state change. */
export function setAgentNotificationPathname(pathname: string): void {
  deepLinkOnScreen = threadDeepLinkOnScreen(pathname);
  setAndroidThreadOnScreen(deepLinkOnScreen);
}

/**
 * App-lifetime notification routing: foreground presentation suppresses the
 * thread already on screen, and taps (including the cold-start tap) open the
 * notification's deep link through `navigate`.
 */
export function installAgentNotificationNavigation(navigate: (href: string) => void): () => void {
  const handledResponseIds = new Set<string>();
  Notifications.setNotificationHandler({
    handleNotification: (notification) =>
      Promise.resolve(
        foregroundNotificationBehavior(notification, deepLinkOnScreen, threadHasLiveFeed),
      ),
  });

  const handleResponse = (response: Notifications.NotificationResponse): void => {
    routeAgentNotificationResponseOnce({ handledResponseIds, response, navigate });
  };
  const subscription = Notifications.addNotificationResponseReceivedListener(handleResponse);
  void consumeLastAgentNotificationResponse({
    getLastResponse: () => Notifications.getLastNotificationResponseAsync(),
    clearLastResponse: () => Notifications.clearLastNotificationResponseAsync(),
    handleResponse,
  });

  return () => {
    subscription.remove();
    Notifications.setNotificationHandler(null);
  };
}
