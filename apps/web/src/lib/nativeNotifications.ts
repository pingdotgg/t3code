export function isAppBackgrounded(): boolean {
  if (typeof document === "undefined") return false;
  if (document.visibilityState !== "visible") return true;
  if (typeof document.hasFocus === "function") {
    return !document.hasFocus();
  }
  return false;
}

export function canShowNativeNotification(): boolean {
  if (typeof Notification === "undefined") return false;
  if (
    typeof window !== "undefined" &&
    (window.desktopBridge !== undefined || window.nativeApi !== undefined)
  ) {
    return true;
  }
  return Notification.permission === "granted";
}

export function getNotificationPermission(): NotificationPermission | "unsupported" {
  if (typeof Notification === "undefined") return "unsupported";
  return Notification.permission;
}

export async function requestNotificationPermission(): Promise<
  NotificationPermission | "unsupported"
> {
  if (typeof Notification === "undefined") return "unsupported";
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

export function showNativeNotification(input: {
  title: string;
  body?: string;
  tag?: string;
}): boolean {
  if (!canShowNativeNotification()) return false;
  try {
    const options: NotificationOptions = {};
    if (input.body !== undefined) {
      options.body = input.body;
    }
    if (input.tag !== undefined) {
      options.tag = input.tag;
    }
    const notification = new Notification(input.title, options);
    void notification;
    return true;
  } catch {
    return false;
  }
}
