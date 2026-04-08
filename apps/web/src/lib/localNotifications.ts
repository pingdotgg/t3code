export interface LocalNotificationInput {
  title: string;
  body: string;
  tag?: string;
}

export type LocalNotificationPermissionState = NotificationPermission | "unsupported";

export function isLocalNotificationSupported(): boolean {
  return typeof Notification !== "undefined";
}

export async function requestLocalNotificationPermission(): Promise<LocalNotificationPermissionState> {
  if (!isLocalNotificationSupported()) {
    return "unsupported";
  }
  if (Notification.permission === "granted" || Notification.permission === "denied") {
    return Notification.permission;
  }
  try {
    return await Notification.requestPermission();
  } catch {
    return "denied";
  }
}

export function sendLocalNotification(input: LocalNotificationInput): boolean {
  if (!isLocalNotificationSupported() || Notification.permission !== "granted") {
    return false;
  }

  try {
    const notification = new Notification(input.title, {
      body: input.body,
      ...(input.tag ? { tag: input.tag } : {}),
    });
    globalThis.setTimeout(() => {
      notification.close();
    }, 10_000);
    return true;
  } catch {
    return false;
  }
}
