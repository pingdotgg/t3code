import type {
  DesktopThreadAttentionActivation,
  DesktopThreadAttentionNotification,
} from "@forma/contracts";

export interface ThreadAttentionNotificationInstance {
  on(event: "click", listener: () => void): void;
  show(): void;
}

export interface ThreadAttentionNotificationFactory {
  isSupported(): boolean;
  create(options: { title: string; body: string }): ThreadAttentionNotificationInstance;
}

export interface ThreadAttentionNotificationTarget {
  isDestroyed(): boolean;
  isFocused(): boolean;
}

export function buildThreadAttentionNotificationCopy(input: DesktopThreadAttentionNotification): {
  title: string;
  body: string;
} {
  return input.kind === "approval"
    ? {
        title: "Approval needed",
        body: `Thread "${input.threadTitle}" needs approval to continue.`,
      }
    : {
        title: "Input needed",
        body: `Thread "${input.threadTitle}" is waiting for your input.`,
      };
}

export function showThreadAttentionNotification<TWindow extends ThreadAttentionNotificationTarget>({
  notificationFactory,
  targetWindow,
  input,
  revealWindow,
  onActivated,
}: {
  notificationFactory: ThreadAttentionNotificationFactory;
  targetWindow: TWindow;
  input: DesktopThreadAttentionNotification;
  revealWindow: (window: TWindow) => void;
  onActivated: (activation: DesktopThreadAttentionActivation) => void;
}): boolean {
  if (
    targetWindow.isDestroyed() ||
    targetWindow.isFocused() ||
    !notificationFactory.isSupported()
  ) {
    return false;
  }

  const notification = notificationFactory.create(buildThreadAttentionNotificationCopy(input));
  notification.on("click", () => {
    if (targetWindow.isDestroyed()) {
      return;
    }

    revealWindow(targetWindow);
    onActivated({ ...input });
  });
  notification.show();
  return true;
}
