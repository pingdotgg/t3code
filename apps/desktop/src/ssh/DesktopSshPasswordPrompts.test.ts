import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import type * as Electron from "electron";

import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as IpcChannels from "../ipc/channels.ts";
import * as DesktopSshPasswordPrompts from "./DesktopSshPasswordPrompts.ts";

interface SentMessage {
  readonly channel: string;
  readonly args: readonly unknown[];
}

function makeTestWindow() {
  const listeners = new Map<string, Set<() => void>>();
  const sentMessages: SentMessage[] = [];
  let destroyed = false;
  let minimized = true;
  let restored = false;
  let focused = false;

  const window = {
    isDestroyed: () => destroyed,
    isMinimized: () => minimized,
    restore: () => {
      restored = true;
      minimized = false;
    },
    focus: () => {
      focused = true;
    },
    once: (eventName: string, listener: () => void) => {
      const eventListeners = listeners.get(eventName) ?? new Set<() => void>();
      eventListeners.add(listener);
      listeners.set(eventName, eventListeners);
    },
    removeListener: (eventName: string, listener: () => void) => {
      listeners.get(eventName)?.delete(listener);
    },
    webContents: {
      send: (channel: string, ...args: readonly unknown[]) => {
        sentMessages.push({ channel, args });
      },
    },
  };

  return {
    window,
    sentMessages,
    isRestored: () => restored,
    isFocused: () => focused,
    close: () => {
      destroyed = true;
      const closedListeners = [...(listeners.get("closed") ?? [])];
      listeners.delete("closed");
      for (const listener of closedListeners) {
        listener();
      }
    },
  };
}

function makeElectronWindowLayer(window: ReturnType<typeof makeTestWindow>["window"]) {
  return Layer.succeed(
    ElectronWindow.ElectronWindow,
    ElectronWindow.ElectronWindow.of({
      create: () => Effect.die("unexpected BrowserWindow creation"),
      main: Effect.succeed(Option.some(window as Electron.BrowserWindow)),
      currentMainOrFirst: Effect.succeed(Option.some(window as Electron.BrowserWindow)),
      focusedMainOrFirst: Effect.succeed(Option.some(window as Electron.BrowserWindow)),
      setMain: () => Effect.void,
      clearMain: () => Effect.void,
      reveal: () => Effect.void,
      sendAll: () => Effect.void,
      destroyAll: Effect.void,
      syncAllAppearance: () => Effect.void,
    }),
  );
}

function makeLayer(window: ReturnType<typeof makeTestWindow>["window"]) {
  return DesktopSshPasswordPrompts.layer({ passwordPromptTimeoutMs: 1_000 }).pipe(
    Layer.provide(makeElectronWindowLayer(window)),
    Layer.provideMerge(TestClock.layer()),
  );
}

describe("DesktopSshPasswordPrompts", () => {
  it.effect("sends renderer prompts and resolves them by request id", () => {
    const testWindow = makeTestWindow();

    return Effect.gen(function* () {
      const prompts = yield* DesktopSshPasswordPrompts.DesktopSshPasswordPrompts;
      const fiber = yield* prompts
        .request({
          destination: "devbox",
          username: "julius",
          prompt: "Enter the SSH password.",
          attempt: 1,
        })
        .pipe(Effect.forkScoped);

      yield* Effect.yieldNow;
      assert.equal(testWindow.sentMessages.length, 1);
      const sent = testWindow.sentMessages[0];
      assert.ok(sent);
      assert.equal(sent.channel, IpcChannels.SSH_PASSWORD_PROMPT_CHANNEL);
      const request = sent.args[0] as { readonly requestId: string; readonly destination: string };
      assert.equal(request.destination, "devbox");
      assert.equal(testWindow.isRestored(), true);
      assert.equal(testWindow.isFocused(), true);

      yield* prompts.resolve({ requestId: request.requestId, password: "secret" });
      assert.equal(yield* Fiber.join(fiber), "secret");
    }).pipe(Effect.provide(makeLayer(testWindow.window)), Effect.scoped);
  });

  it.effect("times out pending renderer prompts with a typed error", () => {
    const testWindow = makeTestWindow();

    return Effect.gen(function* () {
      const prompts = yield* DesktopSshPasswordPrompts.DesktopSshPasswordPrompts;
      const fiber = yield* prompts
        .request({
          destination: "devbox",
          username: null,
          prompt: "Enter the SSH password.",
          attempt: 1,
        })
        .pipe(Effect.forkScoped);

      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.millis(1_000));
      const error = yield* Fiber.join(fiber).pipe(Effect.flip);
      assert.instanceOf(error, DesktopSshPasswordPrompts.DesktopSshPromptTimedOutError);
      assert.equal(error.destination, "devbox");
    }).pipe(Effect.provide(makeLayer(testWindow.window)), Effect.scoped);
  });
});
