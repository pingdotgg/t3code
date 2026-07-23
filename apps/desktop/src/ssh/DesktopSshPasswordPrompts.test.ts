import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import type * as Electron from "electron";

import * as ElectronWindow from "../electron/ElectronWindow.ts";
import { SSH_PASSWORD_PROMPT_CHANNEL } from "../ipc/channels.ts";
import * as DesktopSshPasswordPrompts from "./DesktopSshPasswordPrompts.ts";

interface SentMessage {
  readonly channel: string;
  readonly args: readonly unknown[];
}

function makeTestWindow(
  options: {
    readonly isDestroyedError?: unknown;
    readonly isMinimizedError?: unknown;
    readonly sendError?: unknown;
  } = {},
) {
  const listeners = new Map<string, Set<() => void>>();
  const sentMessages: SentMessage[] = [];
  let destroyed = false;
  let minimized = true;
  let restored = false;
  let focused = false;

  const window = {
    isDestroyed: () => {
      if (options.isDestroyedError !== undefined) {
        throw options.isDestroyedError;
      }
      return destroyed;
    },
    isMinimized: () => {
      if (options.isMinimizedError !== undefined) {
        throw options.isMinimizedError;
      }
      return minimized;
    },
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
        const message = { channel, args };
        sentMessages.push(message);
        if (options.sendError !== undefined) {
          throw options.sendError;
        }
      },
    },
  };

  return {
    window,
    sentMessages,
    isRestored: () => restored,
    isFocused: () => focused,
    closedListenerCount: () => listeners.get("closed")?.size ?? 0,
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
    Layer.provide(NodeServices.layer),
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
      yield* Effect.yieldNow;
      assert.equal(testWindow.sentMessages.length, 1);
      const sent = testWindow.sentMessages[0];
      assert.ok(sent);
      assert.equal(sent.channel, SSH_PASSWORD_PROMPT_CHANNEL);
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

  it.effect("cleans up a prompt that fails during renderer delivery", () => {
    const cause = new Error("renderer unavailable");
    const testWindow = makeTestWindow({ sendError: cause });

    return Effect.gen(function* () {
      const prompts = yield* DesktopSshPasswordPrompts.DesktopSshPasswordPrompts;
      const error = yield* prompts
        .request({
          destination: "devbox",
          username: "julius",
          prompt: "Enter the SSH password.",
          attempt: 1,
        })
        .pipe(Effect.flip);

      assert.instanceOf(error, DesktopSshPasswordPrompts.DesktopSshPromptPresentationError);
      assert.equal(error.operation, "send-prompt-request");
      assert.equal(error.destination, "devbox");
      const requestId = error.requestId;
      if (requestId === null) {
        assert.fail("renderer delivery failures must retain their request id");
      }
      assert.equal(testWindow.closedListenerCount(), 0);

      const resolveError = yield* prompts
        .resolve({ requestId, password: "secret" })
        .pipe(Effect.flip);
      assert.instanceOf(resolveError, DesktopSshPasswordPrompts.DesktopSshPromptExpiredError);
    }).pipe(Effect.provide(makeLayer(testWindow.window)), Effect.scoped);
  });

  it.effect("keeps a submitted password when a later presentation step fails", () => {
    const testWindow = makeTestWindow({
      isMinimizedError: new Error("failed to read minimized state"),
    });

    return Effect.gen(function* () {
      const prompts = yield* DesktopSshPasswordPrompts.DesktopSshPasswordPrompts;
      const requestFiber = yield* prompts
        .request({
          destination: "devbox",
          username: "julius",
          prompt: "Enter the SSH password.",
          attempt: 1,
        })
        .pipe(Effect.forkScoped);

      yield* Effect.yieldNow;
      const sent = testWindow.sentMessages[0];
      assert.ok(sent);
      const request = sent.args[0] as { readonly requestId: string };
      yield* prompts.resolve({ requestId: request.requestId, password: "secret" });
      const password = yield* Fiber.join(requestFiber);

      assert.equal(password, "secret");
      assert.equal(testWindow.isFocused(), false);
      assert.equal(testWindow.closedListenerCount(), 0);
    }).pipe(Effect.provide(makeLayer(testWindow.window)), Effect.scoped);
  });

  it.effect("classifies a failed initial window availability check", () => {
    const testWindow = makeTestWindow({ isDestroyedError: new Error("window unavailable") });

    return Effect.gen(function* () {
      const prompts = yield* DesktopSshPasswordPrompts.DesktopSshPasswordPrompts;
      const error = yield* prompts
        .request({
          destination: "devbox",
          username: "julius",
          prompt: "Enter the SSH password.",
          attempt: 1,
        })
        .pipe(Effect.flip);

      assert.instanceOf(error, DesktopSshPasswordPrompts.DesktopSshPromptPresentationError);
      assert.equal(error.operation, "check-window-before-request");
      assert.equal(error.requestId, null);
      assert.deepEqual(testWindow.sentMessages, []);
    }).pipe(Effect.provide(makeLayer(testWindow.window)), Effect.scoped);
  });
});
