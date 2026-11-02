import {
  DesktopThreadNotificationTarget,
  type DesktopThreadNotification,
} from "@t3tools/contracts";
import * as Electron from "electron";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import { THREAD_NOTIFICATION_ACTIVATED_CHANNEL } from "../ipc/channels.ts";

const PREFIX = "t3-thread-v1:";
const MAX_NOTIFICATIONS = 128;
const isTarget = Schema.is(DesktopThreadNotificationTarget);

const xmlText = (value: string) =>
  value
    .toWellFormed()
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

function readActivation(arguments_: string): DesktopThreadNotificationTarget | null {
  if (!arguments_.startsWith(PREFIX) || arguments_.length > 16_384) return null;
  const params = new URLSearchParams(arguments_.slice(PREFIX.length));
  const target = {
    id: params.get("id"),
    environmentId: params.get("environment"),
    threadId: params.get("thread"),
  };
  return isTarget(target) ? target : null;
}

interface PendingNotification {
  readonly target: DesktopThreadNotificationTarget;
  readonly notification: Electron.Notification;
  readonly settle: (shown: boolean) => void;
}

export class DesktopThreadNotifications extends Context.Service<
  DesktopThreadNotifications,
  {
    readonly register: Effect.Effect<void, never, Scope.Scope>;
    readonly show: (input: DesktopThreadNotification) => Effect.Effect<boolean>;
    readonly close: (id: string | null) => Effect.Effect<void>;
    readonly setRendererReady: (ready: boolean) => Effect.Effect<void>;
  }
>()("@t3tools/desktop/app/DesktopThreadNotifications") {}

const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const windows = yield* ElectronWindow.ElectronWindow;
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  const app = yield* ElectronApp.ElectronApp;
  const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
  const pending = new Map<string, PendingNotification>();
  const activated = new Set<string>();
  let queued: DesktopThreadNotificationTarget | null = null;
  let listening: Electron.WebContents | null = null;
  let detach: (() => void) | null = null;
  let quitting = false;

  const stopListening = () => {
    detach?.();
    detach = null;
    listening = null;
  };
  const remember = (id: string) => {
    activated.add(id);
    if (activated.size > MAX_NOTIFICATIONS) activated.delete(activated.values().next().value!);
  };
  const close = (id: string) => {
    for (const [tag, entry] of pending) {
      if (entry.target.id !== id) continue;
      pending.delete(tag);
      entry.settle(false);
      entry.notification.close();
    }
  };
  const flush = Effect.gen(function* () {
    if (!queued || !listening) return;
    const window = yield* windows.currentMainOrFirst;
    if (Option.isNone(window) || window.value.webContents !== listening || listening.isDestroyed())
      return;
    const target = queued;
    queued = null;
    listening.send(THREAD_NOTIFICATION_ACTIVATED_CHANNEL, target);
  });
  const activate = (target: DesktopThreadNotificationTarget) => {
    if (activated.has(target.id)) return;
    remember(target.id);
    close(target.id);
    queued = target;
    void runPromise(desktopWindow.activate.pipe(Effect.ignore, Effect.andThen(flush))).catch(
      () => undefined,
    );
  };

  return DesktopThreadNotifications.of({
    register: Effect.gen(function* () {
      if (environment.platform !== "win32" || !Electron.Notification.isSupported()) return;
      Electron.Notification.handleActivation((details) => {
        if (details.type !== "click") return;
        const target = readActivation(details.arguments);
        if (target) activate(target);
      });
      yield* app.on("before-quit", () => {
        quitting = true;
      });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          stopListening();
          Electron.Notification.handleActivation(() => undefined);
          // Timed-out notices stay in Action Center and carry their own restart destination.
          for (const entry of pending.values()) entry.settle(false);
          pending.clear();
        }),
      );
    }),
    show: Effect.fn("DesktopThreadNotifications.show")(function (input) {
      if (quitting || environment.platform !== "win32" || !Electron.Notification.isSupported()) {
        return Effect.succeed(false);
      }
      return Effect.promise(
        () =>
          new Promise<boolean>((resolve) => {
            const previous = pending.get(input.tag);
            if (previous) {
              remember(previous.target.id);
              close(previous.target.id);
            }
            if (pending.size >= MAX_NOTIFICATIONS) {
              const evicted = pending.values().next().value!;
              remember(evicted.target.id);
              close(evicted.target.id);
            }
            const target = {
              id: input.id,
              environmentId: input.environmentId,
              threadId: input.threadId,
            };
            const args =
              PREFIX +
              new URLSearchParams({
                id: target.id,
                environment: target.environmentId,
                thread: target.threadId,
              }).toString();
            try {
              const notification = new Electron.Notification({
                id: input.tag,
                groupId: "t3-threads",
                timeoutType: "default",
                silent: true,
                toastXml: `<toast launch="${xmlText(args)}"><visual><binding template="ToastGeneric"><text>${xmlText(input.title)}</text><text>${xmlText(input.body)}</text></binding></visual><audio silent="true"/></toast>`,
              });
              const forget = () => {
                if (pending.get(input.tag)?.target.id === input.id) pending.delete(input.tag);
              };
              pending.set(input.tag, { target, notification, settle: resolve });
              notification.once("show", () => resolve(true));
              notification.once("failed", () => {
                forget();
                resolve(false);
              });
              // Live WinRT body clicks can bypass handleActivation; both paths share the nonce.
              notification.on("click", () => activate(target));
              notification.on("close", (event) => {
                if (event.reason === "timedOut") return;
                if (event.reason === "userCanceled") remember(target.id);
                forget();
                resolve(false);
              });
              notification.show();
            } catch {
              if (pending.get(input.tag)?.target.id === input.id) pending.delete(input.tag);
              resolve(false);
            }
          }),
      );
    }),
    close: Effect.fn("DesktopThreadNotifications.close")((id: string | null) =>
      Effect.sync(() => {
        if (quitting) return;
        if (id !== null) close(id);
        else for (const entry of pending.values()) close(entry.target.id);
      }),
    ),
    setRendererReady: Effect.fn("DesktopThreadNotifications.setRendererReady")(function* (ready) {
      if (!ready) {
        stopListening();
        return;
      }
      const window = yield* windows.currentMainOrFirst;
      if (Option.isNone(window) || window.value.webContents.isDestroyed()) return;
      const contents = window.value.webContents;
      if (contents !== listening) {
        stopListening();
        listening = contents;
        const onNavigation = (
          event: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>,
        ) => {
          if (event.isMainFrame && !event.isSameDocument) stopListening();
        };
        contents.on("did-start-navigation", onNavigation);
        contents.on("render-process-gone", stopListening);
        contents.once("destroyed", stopListening);
        detach = () => {
          contents.removeListener("did-start-navigation", onNavigation);
          contents.removeListener("render-process-gone", stopListening);
          contents.removeListener("destroyed", stopListening);
        };
      }
      yield* flush;
    }),
  });
});

export const layer = Layer.effect(DesktopThreadNotifications, make);
