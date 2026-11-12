// @effect-diagnostics nodeBuiltinImport:off -- The fake native notification and webContents expose Electron's event lifecycle.
import * as NodeEvents from "node:events";
import { assert, it } from "@effect/vitest";
import { EnvironmentId, ThreadId, type DesktopThreadNotification } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";

import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";

const native = vi.hoisted(() => ({
  create: null as unknown as (options: Electron.NotificationConstructorOptions) => object,
  activate: null as null | ((details: Electron.ActivationArguments) => void),
  initial: null as null | Electron.ActivationArguments,
}));
vi.mock("electron", () => ({
  Notification: class {
    constructor(options: Electron.NotificationConstructorOptions) {
      return native.create(options);
    }
    static isSupported() {
      return true;
    }
    static handleActivation(callback: (details: Electron.ActivationArguments) => void) {
      native.activate = callback;
      if (native.initial) {
        const first = native.initial;
        native.initial = null;
        callback(first);
      }
    }
  },
}));

import * as DesktopThreadNotifications from "./DesktopThreadNotifications.ts";

const input: DesktopThreadNotification = {
  id: "c815595b-7739-4ff0-aef9-ec101a341639",
  tag: "1234567890abcdef",
  environmentId: EnvironmentId.make("remote-environment"),
  threadId: ThreadId.make("thread-1"),
  title: "Thread completed",
  body: 'a & <b> "quoted"',
};

class NativeNotification extends NodeEvents.EventEmitter {
  closeCount = 0;
  readonly options: Electron.NotificationConstructorOptions;
  constructor(options: Electron.NotificationConstructorOptions) {
    super();
    this.options = options;
  }
  show() {
    this.emit("show", {});
  }
  close() {
    this.closeCount++;
    this.emit("close", { reason: "applicationHidden" });
  }
}

function setup() {
  native.activate = null;
  native.initial = null;
  const notifications: NativeNotification[] = [];
  native.create = (options) => {
    const notification = new NativeNotification(options);
    notifications.push(notification);
    return notification;
  };
  const sent: Array<unknown> = [];
  const app = new NodeEvents.EventEmitter();
  const webContents = Object.assign(new NodeEvents.EventEmitter(), {
    id: 1,
    isDestroyed: () => false,
    send: (_channel: string, payload: unknown) => {
      sent.push(payload);
    },
  });
  const window = { webContents } as unknown as Electron.BrowserWindow;
  const layer = DesktopThreadNotifications.layer.pipe(
    Layer.provide([
      Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
        platform: "win32",
      } as DesktopEnvironment.DesktopEnvironment["Service"]),
      Layer.succeed(ElectronWindow.ElectronWindow, {
        currentMainOrFirst: Effect.succeedSome(window),
      } as ElectronWindow.ElectronWindow["Service"]),
      Layer.succeed(DesktopWindow.DesktopWindow, {
        activate: Effect.void,
      } as unknown as DesktopWindow.DesktopWindow["Service"]),
      Layer.succeed(ElectronApp.ElectronApp, {
        on: (event: string, listener: () => void) =>
          Effect.acquireRelease(
            Effect.sync(() => {
              app.on(event, listener);
            }),
            () =>
              Effect.sync(() => {
                app.removeListener(event, listener);
              }),
          ).pipe(Effect.asVoid),
      } as ElectronApp.ElectronApp["Service"]),
    ]),
  );
  return { notifications, sent, app, webContents, layer };
}

const activationFor = (notification: NativeNotification) => {
  const xml = notification.options.toastXml!;
  const arguments_ = xml.match(/launch="([^"]+)"/)![1]!.replaceAll("&amp;", "&");
  return { type: "click", arguments: arguments_ };
};

it.effect(
  "times out normally, retains clickability, and delivers one navigation across both native callbacks",
  () => {
    const { notifications, sent, webContents, layer } = setup();
    return Effect.scoped(
      Effect.gen(function* () {
        const service = yield* DesktopThreadNotifications.DesktopThreadNotifications;
        yield* service.register;
        assert.strictEqual(yield* service.show(input), true);
        const notification = notifications[0]!;
        assert.strictEqual(notification.options.timeoutType, "default");
        assert.notInclude(notification.options.toastXml!, 'scenario="reminder"');
        assert.include(notification.options.toastXml!, "a &amp; &lt;b&gt; &quot;quoted&quot;");
        notification.emit("close", { reason: "timedOut" });
        assert.strictEqual(notification.closeCount, 0);
        notification.emit("click", {});
        native.activate!(activationFor(notification));
        assert.deepStrictEqual(sent, []);
        yield* service.setRendererReady(true);
        assert.deepStrictEqual(sent, [
          { id: input.id, environmentId: input.environmentId, threadId: input.threadId },
        ]);
        assert.strictEqual(notification.closeCount, 1);
        webContents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
        const next = { ...input, id: "22f0be88-ea34-4cf3-b0da-b900710cd00a" };
        yield* service.show(next);
        native.activate!(activationFor(notifications[1]!));
        assert.strictEqual(sent.length, 1);
        yield* service.setRendererReady(true);
        assert.strictEqual(sent.length, 2);
      }),
    ).pipe(Effect.provide(layer));
  },
);

it.effect(
  "replays a cold activation after renderer readiness and rejects malformed destinations",
  () => {
    const { sent, layer } = setup();
    native.initial = {
      type: "click",
      arguments:
        "t3-thread-v1:" +
        new URLSearchParams({
          id: input.id,
          environment: input.environmentId,
          thread: input.threadId,
        }),
    };
    return Effect.scoped(
      Effect.gen(function* () {
        const service = yield* DesktopThreadNotifications.DesktopThreadNotifications;
        yield* service.register;
        assert.deepStrictEqual(sent, []);
        yield* service.setRendererReady(true);
        assert.strictEqual(sent.length, 1);
        for (const arguments_ of [
          "https://example.com",
          "t3-thread-v1:id=bad&environment=e&thread=t",
          "x".repeat(17_000),
        ]) {
          native.activate!({ type: "click", arguments: arguments_ });
        }
        native.activate!({ type: "reply", arguments: native.initial?.arguments ?? "" });
        yield* service.setRendererReady(true);
        assert.strictEqual(sent.length, 1);
      }),
    ).pipe(Effect.provide(layer));
  },
);

it.effect(
  "replaces by thread without letting an old close erase its successor, and keeps restart notices",
  () => {
    const { notifications, app, layer } = setup();
    return Effect.scoped(
      Effect.gen(function* () {
        const service = yield* DesktopThreadNotifications.DesktopThreadNotifications;
        yield* service.register;
        yield* service.show(input);
        const next = { ...input, id: "22f0be88-ea34-4cf3-b0da-b900710cd00a" };
        yield* service.show(next);
        assert.strictEqual(notifications[0]!.closeCount, 1);
        yield* service.close(input.id);
        assert.strictEqual(notifications[1]!.closeCount, 0);
        notifications[1]!.emit("close", { reason: "timedOut" });
        yield* service.close(next.id);
        assert.strictEqual(notifications[1]!.closeCount, 1);
        yield* service.show(input);
        app.emit("before-quit");
        yield* service.close(input.id);
        assert.strictEqual(notifications[2]!.closeCount, 0);
      }),
    ).pipe(Effect.provide(layer));
  },
);
