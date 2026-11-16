import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as DesktopThreadNotifications from "../../app/DesktopThreadNotifications.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as ThreadNotifications from "./threadNotifications.ts";

it.effect("only the main renderer can display, clear, or receive thread notifications", () => {
  const calls: Array<unknown> = [];
  const input = {
    id: "c815595b-7739-4ff0-aef9-ec101a341639",
    tag: "1234567890abcdef",
    environmentId: "machine",
    threadId: "thread",
    title: "Thread completed",
    body: "done",
  };
  const layer = Layer.mergeAll(
    Layer.succeed(ElectronWindow.ElectronWindow, {
      main: Effect.succeedSome({
        isDestroyed: () => false,
        webContents: { id: 1 },
      } as Electron.BrowserWindow),
    } as ElectronWindow.ElectronWindow["Service"]),
    Layer.succeed(DesktopThreadNotifications.DesktopThreadNotifications, {
      register: Effect.void,
      show: (value) =>
        Effect.sync(() => {
          calls.push(value);
          return true;
        }),
      close: (value) =>
        Effect.sync(() => {
          calls.push(value);
        }),
      setRendererReady: (value) =>
        Effect.sync(() => {
          calls.push(value);
        }),
    }),
  );
  return Effect.gen(function* () {
    for (const event of [undefined, { sender: { id: 2 } }]) {
      assert.strictEqual(yield* ThreadNotifications.show.handler(input, event), false);
      yield* ThreadNotifications.close.handler(input.id, event);
      yield* ThreadNotifications.setReady.handler(true, event);
    }
    assert.deepStrictEqual(calls, []);
    const event = { sender: { id: 1 } };
    assert.strictEqual(yield* ThreadNotifications.show.handler(input, event), true);
    yield* ThreadNotifications.close.handler(input.id, event);
    yield* ThreadNotifications.setReady.handler(true, event);
    assert.deepStrictEqual(calls, [input, input.id, true]);
  }).pipe(Effect.provide(layer));
});
