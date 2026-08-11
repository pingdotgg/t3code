import { assert, describe, it } from "@effect/vitest";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type Electron from "electron";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ElectronNotifications from "../../electron/ElectronNotifications.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import { NOTIFICATION_ACTIVATED_CHANNEL } from "../channels.ts";
import { showNotification } from "./notifications.ts";

const THREAD_REF = {
  environmentId: "env-1" as EnvironmentId,
  threadId: "thread-1" as ThreadId,
};

const PAYLOAD = {
  kind: "task-completed",
  title: "Fix flaky auth test",
  body: "Agent finished · t3code",
  silent: false,
  threadRef: THREAD_REF,
} as const;

describe("showNotification", () => {
  it.effect("passes the renderer's copy straight through to the OS", () => {
    const shown: Array<{ title: string; body: string; silent: boolean }> = [];

    return Effect.gen(function* () {
      yield* showNotification.handler(PAYLOAD);

      assert.deepEqual(shown, [
        { title: "Fix flaky auth test", body: "Agent finished · t3code", silent: false },
      ]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(ElectronNotifications.ElectronNotifications)({
            show: (input) =>
              Effect.sync(() => {
                shown.push({ title: input.title, body: input.body, silent: input.silent });
              }),
          }),
          Layer.mock(ElectronWindow.ElectronWindow)({
            currentMainOrFirst: Effect.succeed(Option.none()),
            reveal: () => Effect.void,
            sendAll: () => Effect.void,
          }),
        ),
      ),
    );
  });

  it.effect("reveals the window and reports the thread when clicked", () => {
    const window = {} as Electron.BrowserWindow;
    const revealed: Array<Electron.BrowserWindow> = [];
    const sent: Array<readonly [string, ReadonlyArray<unknown>]> = [];
    let activate: (() => void) | null = null;

    return Effect.gen(function* () {
      yield* showNotification.handler(PAYLOAD);

      assert.isNotNull(activate);
      activate?.();
      // The activation runs as its own promise, so let the microtask queue drain.
      yield* Effect.promise(() => Promise.resolve());

      assert.deepEqual(revealed, [window]);
      assert.deepEqual(sent, [[NOTIFICATION_ACTIVATED_CHANNEL, [{ threadRef: THREAD_REF }]]]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(ElectronNotifications.ElectronNotifications)({
            show: (input) =>
              Effect.sync(() => {
                activate = input.onActivate;
              }),
          }),
          Layer.mock(ElectronWindow.ElectronWindow)({
            currentMainOrFirst: Effect.succeed(Option.some(window)),
            reveal: (target) =>
              Effect.sync(() => {
                revealed.push(target);
              }),
            sendAll: (channel, ...args) =>
              Effect.sync(() => {
                sent.push([channel, args]);
              }),
          }),
        ),
      ),
    );
  });
});
