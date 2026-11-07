import { it, assert } from "@effect/vitest";
import type { DesktopUpdateState, DesktopUpdateCommandRequest } from "@t3tools/contracts";
import type { BrowserWindow } from "electron";
import * as TestClock from "effect/testing/TestClock";
import * as Duration from "effect/Duration";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopUpdateCommand from "./DesktopUpdateCommand.ts";
import * as DesktopUpdates from "./DesktopUpdates.ts";

const state: DesktopUpdateState = {
  enabled: true,
  status: "available",
  channel: "latest",
  currentVersion: "0.1.7",
  availableVersion: "0.1.8",
  downloadedVersion: null,
  hostArch: "x64",
  appArch: "x64",
  runningUnderArm64Translation: false,
  releaseNotes: [],
  omittedReleaseCount: 0,
  downloadPercent: null,
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: false,
};
const layer = (send: (request: DesktopUpdateCommandRequest) => void) =>
  DesktopUpdateCommand.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(DesktopUpdates.DesktopUpdates, {
          getState: Effect.succeed(state),
          isActionActive: Effect.succeed(false),
        }),
        Layer.mock(ElectronWindow.ElectronWindow, {
          main: Effect.succeedSome({
            webContents: {
              isDestroyed: () => false,
              send: (_channel: string, request: DesktopUpdateCommandRequest) => send(request),
            },
          } as unknown as BrowserWindow),
        }),
      ),
    ),
  );

it.effect("checks cached coordinator availability without activating, checking or updating", () =>
  Effect.gen(function* () {
    const command = yield* DesktopUpdateCommand.DesktopUpdateCommand;
    assert.equal((yield* command.inspect).state, "unavailable");
    yield* command.setReady(true, "renderer");
    yield* command.setReady(false, "old-renderer");
    assert.deepInclude(yield* command.inspect, {
      coordinated: true,
      state: "ready",
      currentVersion: "0.1.7",
      targetVersion: "0.1.8",
    });
    const first = yield* command.reserve;
    assert.isNotNull(first);
    assert.equal((yield* command.inspect).state, "busy");
    yield* command.finish(first!);
    const second = yield* command.reserve;
    assert.isNotNull(second);
    yield* command.finish(first!);
    assert.equal((yield* command.inspect).state, "busy");
    yield* command.finish(second!);
  }).pipe(
    Effect.provide(
      layer(() => {
        throw new Error("Read-only check dispatched UI");
      }),
    ),
  ),
);
it.effect("holds one reservation across confirmation and ignores a cancelled confirmation", () =>
  Effect.gen(function* () {
    const sent = yield* Deferred.make<DesktopUpdateCommandRequest>();
    yield* Effect.gen(function* () {
      const command = yield* DesktopUpdateCommand.DesktopUpdateCommand;
      yield* command.setReady(true, "renderer");
      const first = yield* command
        .request({ version: 1, requestId: "first", type: "update" })
        .pipe(Effect.forkScoped);
      const incoming = yield* Deferred.await(sent);
      assert.isFalse(
        (yield* command.request({ version: 1, requestId: "second", type: "update" })).ok,
      );
      assert.isTrue(
        yield* command.complete({
          version: 1,
          requestId: incoming.requestId,
          ok: true,
          status: "cancelled",
        }),
      );
      assert.isFalse(
        yield* command.complete({
          version: 1,
          requestId: incoming.requestId,
          ok: true,
          status: "started",
        }),
      );
      assert.equal((yield* command.inspect).state, "ready");
      yield* Fiber.join(first);
    }).pipe(
      Effect.provide(
        layer((request) => {
          Deferred.doneUnsafe(sent, Effect.succeed(request));
        }),
      ),
    );
  }),
);
it.effect("releases a reservation if the renderer disappears during delivery", () =>
  Effect.gen(function* () {
    const command = yield* DesktopUpdateCommand.DesktopUpdateCommand;
    yield* command.setReady(true, "renderer");
    assert.isFalse((yield* command.request({ version: 1, requestId: "gone", type: "update" })).ok);
    assert.equal((yield* command.inspect).state, "ready");
  }).pipe(
    Effect.provide(
      layer(() => {
        throw new Error("Renderer closed");
      }),
    ),
  ),
);

it.effect("clears an expired confirmation so a later request can proceed", () =>
  Effect.gen(function* () {
    const sent = yield* Deferred.make<void>();
    yield* Effect.gen(function* () {
      const command = yield* DesktopUpdateCommand.DesktopUpdateCommand;
      yield* command.setReady(true, "renderer");
      const request = yield* command
        .request({ version: 1, requestId: "expired", type: "update" })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(sent);
      yield* TestClock.adjust(Duration.minutes(5));
      assert.isFalse((yield* Fiber.join(request)).ok);
      assert.isFalse(
        yield* command.complete({ version: 1, requestId: "expired", ok: true, status: "started" }),
      );
      const reservation = yield* command.reserve;
      assert.isNotNull(reservation);
      yield* command.finish(reservation!);
    }).pipe(
      Effect.provide(
        layer(() => {
          Deferred.doneUnsafe(sent, Effect.void);
        }),
      ),
    );
  }),
);

it.effect("an older request's cleanup cannot clear or release its successor", () =>
  Effect.gen(function* () {
    const firstSent = yield* Deferred.make<DesktopUpdateCommandRequest>();
    const secondSent = yield* Deferred.make<DesktopUpdateCommandRequest>();
    let sent = 0;
    yield* Effect.gen(function* () {
      const command = yield* DesktopUpdateCommand.DesktopUpdateCommand;
      yield* command.setReady(true, "renderer");
      const first = yield* command
        .request({ version: 1, requestId: "first", type: "update" })
        .pipe(Effect.forkScoped);
      const a = yield* Deferred.await(firstSent);
      yield* command.cancel("first");
      const second = yield* command
        .request({ version: 1, requestId: "second", type: "update" })
        .pipe(Effect.forkScoped);
      const b = yield* Deferred.await(secondSent);
      yield* Fiber.join(first);
      yield* command.finish(a.requestId);
      assert.equal((yield* command.inspect).state, "busy");
      assert.isTrue(
        yield* command.complete({
          version: 1,
          requestId: b.requestId,
          ok: true,
          status: "cancelled",
        }),
      );
      assert.deepInclude(yield* Fiber.join(second), { requestId: "second", status: "cancelled" });
    }).pipe(
      Effect.provide(
        layer((request) => {
          Deferred.doneUnsafe(sent++ === 0 ? firstSent : secondSent, Effect.succeed(request));
        }),
      ),
    );
  }),
);

it.effect("keeps a started run reserved when its renderer unregisters", () =>
  Effect.gen(function* () {
    const sent = yield* Deferred.make<DesktopUpdateCommandRequest>();
    yield* Effect.gen(function* () {
      const command = yield* DesktopUpdateCommand.DesktopUpdateCommand;
      yield* command.setReady(true, "renderer");
      const response = yield* command
        .request({ version: 1, requestId: "running", type: "update" })
        .pipe(Effect.forkScoped);
      const incoming = yield* Deferred.await(sent);
      yield* command.complete({
        version: 1,
        requestId: incoming.requestId,
        ok: true,
        status: "started",
      });
      assert.deepInclude(yield* Fiber.join(response), { requestId: "running", status: "started" });
      yield* command.setReady(false, "renderer");
      yield* command.setReady(true, "replacement");
      assert.isNull(yield* command.reserve);
      yield* command.finish(incoming.requestId);
      assert.equal((yield* command.inspect).state, "ready");
    }).pipe(
      Effect.provide(
        layer((request) => {
          Deferred.doneUnsafe(sent, Effect.succeed(request));
        }),
      ),
    );
  }),
);
