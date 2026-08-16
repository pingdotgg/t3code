import type {
  DesktopNotificationShowInput,
  DesktopNotificationShowResult,
  DesktopNotificationTarget,
} from "@t3tools/contracts";
import {
  formatAgentNotificationContent,
  formatAgentNotificationTestContent,
  type AgentNotificationContent,
} from "@t3tools/shared/agentAwareness";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as Electron from "electron";

import * as DesktopWindow from "../window/DesktopWindow.ts";
import { DESKTOP_NOTIFICATION_ACTIVATED_CHANNEL } from "../ipc/channels.ts";

class DesktopNotificationShowError extends Schema.TaggedErrorClass<DesktopNotificationShowError>()(
  "DesktopNotificationShowError",
  {
    notificationKey: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Could not show native desktop notification ${this.notificationKey}.`;
  }
}

export interface NativeNotification {
  readonly show: () => void;
  readonly close: () => void;
  readonly once: (event: "click" | "close", listener: () => void) => unknown;
  readonly on: (event: "failed", listener: (event: unknown, error: string) => void) => unknown;
}

export interface NativeNotificationOptions {
  readonly title: string;
  readonly body: string;
  readonly silent: boolean;
  readonly timeoutType: "default";
}

export class DesktopNotifications extends Context.Service<
  DesktopNotifications,
  {
    readonly show: (
      input: DesktopNotificationShowInput,
    ) => Effect.Effect<DesktopNotificationShowResult>;
    readonly dismiss: (target: DesktopNotificationTarget) => Effect.Effect<void>;
    readonly dismissAll: Effect.Effect<void>;
    readonly showTest: (input: {
      readonly silent: boolean;
    }) => Effect.Effect<DesktopNotificationShowResult>;
  }
>()("@t3tools/desktop/notifications/DesktopNotifications") {}

export class DesktopNotificationPlatformService extends Context.Service<
  DesktopNotificationPlatformService,
  {
    readonly isSupported: () => boolean;
    readonly isAppFocused: () => boolean;
    readonly create: (options: NativeNotificationOptions) => NativeNotification;
  }
>()("@t3tools/desktop/notifications/DesktopNotifications/DesktopNotificationPlatformService") {}

export function notificationTargetKey(target: DesktopNotificationTarget): string {
  return JSON.stringify([target.environmentId, target.threadId]);
}

const TEST_NOTIFICATION_KEY = "desktop-notification-test";

export const make = Effect.gen(function* () {
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  const platform = yield* DesktopNotificationPlatformService;
  const notifications = new Map<string, NativeNotification>();
  const context = yield* Effect.context<DesktopWindow.DesktopWindow>();
  const runFork = Effect.runForkWith(context);

  const closeNotification = (key: string): void => {
    const existing = notifications.get(key);
    notifications.delete(key);
    existing?.close();
  };

  const closeAllNotifications = (): void => {
    for (const notification of notifications.values()) {
      notification.close();
    }
    notifications.clear();
  };

  const reveal = (target: DesktopNotificationTarget | null) =>
    desktopWindow.revealOrCreateMain.pipe(
      Effect.tap((window) =>
        target === null
          ? Effect.void
          : Effect.sync(() => {
              const send = () => {
                if (!window.isDestroyed()) {
                  window.webContents.send(DESKTOP_NOTIFICATION_ACTIVATED_CHANNEL, target);
                }
              };
              if (window.webContents.isLoadingMainFrame()) {
                window.webContents.once("did-finish-load", send);
              } else {
                send();
              }
            }),
      ),
      Effect.asVoid,
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not reveal a desktop notification target.", cause),
      ),
    );

  const showContent = (input: {
    readonly key: string;
    readonly content: AgentNotificationContent;
    readonly silent: boolean;
    readonly target: DesktopNotificationTarget | null;
  }): Effect.Effect<DesktopNotificationShowResult> =>
    Effect.gen(function* () {
      const supported = yield* Effect.try({
        try: platform.isSupported,
        catch: () => false,
      }).pipe(Effect.orElseSucceed(() => false));
      if (supported !== true) {
        return "unsupported" as const;
      }

      return yield* Effect.try({
        try: () => {
          closeNotification(input.key);
          const notification = platform.create({
            title: input.content.title,
            body: input.content.body,
            silent: input.silent,
            timeoutType: "default",
          });
          notifications.set(input.key, notification);
          const clearIfCurrent = () => {
            if (notifications.get(input.key) === notification) {
              notifications.delete(input.key);
            }
          };
          notification.once("close", clearIfCurrent);
          notification.once("click", () => {
            clearIfCurrent();
            runFork(reveal(input.target));
          });
          notification.on("failed", (_event, error) => {
            clearIfCurrent();
            runFork(Effect.logWarning("Native desktop notification failed.", { error }));
          });
          notification.show();
          return "shown" as const;
        },
        catch: (cause) => new DesktopNotificationShowError({ notificationKey: input.key, cause }),
      }).pipe(
        Effect.tapError((error) => Effect.logWarning(error.message, error.cause)),
        Effect.orElseSucceed(() => "failed" as const),
      );
    }).pipe(Effect.withSpan("desktop.notifications.show"));

  yield* Effect.addFinalizer(() => Effect.sync(closeAllNotifications));

  return DesktopNotifications.of({
    show: Effect.fn("desktop.notifications.show")(function* (input) {
      const appFocused = yield* Effect.try({
        try: platform.isAppFocused,
        catch: () => false,
      }).pipe(Effect.orElseSucceed(() => false));
      if (appFocused) {
        return "suppressed" as const;
      }
      return yield* showContent({
        key: notificationTargetKey(input),
        content: formatAgentNotificationContent(input),
        silent: input.silent,
        target: {
          environmentId: input.environmentId,
          threadId: input.threadId,
        },
      });
    }),
    dismiss: (target) => Effect.sync(() => closeNotification(notificationTargetKey(target))),
    dismissAll: Effect.sync(closeAllNotifications),
    showTest: (input) =>
      showContent({
        key: TEST_NOTIFICATION_KEY,
        content: formatAgentNotificationTestContent(),
        silent: input.silent,
        target: null,
      }),
  });
});

const platformLayer = Layer.succeed(
  DesktopNotificationPlatformService,
  DesktopNotificationPlatformService.of({
    isSupported: () => Electron.Notification.isSupported(),
    isAppFocused: () => Electron.BrowserWindow.getFocusedWindow() !== null,
    create: (options) =>
      new Electron.Notification(
        options as Electron.NotificationConstructorOptions,
      ) as unknown as NativeNotification,
  }),
);

export const layer = Layer.effect(DesktopNotifications, make).pipe(Layer.provide(platformLayer));
