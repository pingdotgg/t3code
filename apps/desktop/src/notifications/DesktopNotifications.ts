import {
  type AgentNotificationEvent,
  type DesktopNotificationAttempt,
  isAgentNotificationEnabled,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Electron from "electron";

import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";
import { AGENT_NOTIFICATION_NAVIGATE_CHANNEL } from "../ipc/channels.ts";

export class DesktopNotifications extends Context.Service<
  DesktopNotifications,
  {
    readonly show: (event: AgentNotificationEvent) => Effect.Effect<DesktopNotificationAttempt>;
  }
>()("@t3tools/desktop/notifications/DesktopNotifications") {}

function notificationCopy(event: AgentNotificationEvent, revealNames: boolean) {
  if (!revealNames) {
    switch (event.kind) {
      case "input_required":
        return { title: "T3 Code needs your input", body: "Open T3 Code to continue." };
      case "agent_failed":
        return { title: "T3 Code agent failed", body: "Open T3 Code to review the task." };
      case "plan_ready":
        return { title: "T3 Code plan ready", body: "Open T3 Code to review it." };
      case "agent_completed":
        return { title: "T3 Code agent finished", body: "Open T3 Code to review the task." };
    }
  }

  const thread = event.threadTitle ?? "task";
  switch (event.kind) {
    case "input_required":
      return { title: "Input needed", body: thread };
    case "agent_failed":
      return { title: "Agent failed", body: thread };
    case "plan_ready":
      return { title: "Plan ready", body: thread };
    case "agent_completed":
      return { title: "Agent finished", body: thread };
  }
}

export const make = Effect.gen(function* () {
  const settingsStore = yield* DesktopClientSettings.DesktopClientSettings;
  const windows = yield* ElectronWindow.ElectronWindow;

  const show: DesktopNotifications["Service"]["show"] = (event) =>
    Effect.gen(function* () {
      const settings = Option.getOrNull(yield* settingsStore.get);
      const preferences = settings?.agentNotifications;
      if (!preferences || !isAgentNotificationEnabled(preferences, event.kind)) {
        return "disabled" as const;
      }
      if (!Electron.Notification.isSupported()) {
        return "unsupported" as const;
      }

      const copy = notificationCopy(event, preferences.showProjectAndThreadNames);
      return yield* Effect.sync(() => {
        const notification = new Electron.Notification(copy);
        notification.on("click", () => {
          void Effect.runPromise(
            Effect.gen(function* () {
              const target = yield* windows.currentMainOrFirst;
              if (Option.isSome(target)) {
                yield* windows.reveal(target.value);
              }
              yield* windows.sendAll(AGENT_NOTIFICATION_NAVIGATE_CHANNEL, event.deepLink);
            }),
          );
        });
        notification.show();
        return "attempted" as const;
      });
    }).pipe(Effect.catch(() => Effect.succeed("error" as const)));

  return DesktopNotifications.of({ show });
});

export const layer = Layer.effect(DesktopNotifications, make);
