import { it, assert } from "@effect/vitest";
import type { DesktopUpdateState, DesktopUpdateCommandRequest } from "@t3tools/contracts";
import type { BrowserWindow } from "electron";
import * as TestClock from "effect/testing/TestClock";
import * as Duration from "effect/Duration";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
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
const layer = (
  send: (request: DesktopUpdateCommandRequest) => void,
  isActionActive = Effect.succeed(false),
) =>
  DesktopUpdateCommand.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(DesktopUpdates.DesktopUpdates, {
          getState: Effect.succeed(state),
          isActionActive,
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
    yield* command.setReady(true, "replacement");
    assert.isNull(yield* command.reserve);
    assert.equal((yield* command.inspect).state, "busy");
    yield* command.finish(first!);
    const second = yield* command.reserve;
    assert.isNotNull(second);
    yield* command.finish(first!);
    assert.equal((yield* command.inspect).state, "busy");
    yield* command.finish(second!);
    const rendererReservation = yield* command.reserveForRenderer;
    assert.isNotNull(rendererReservation);
    yield* command.setReady(false, "replacement");
    yield* command.setReady(true, "replacement");
    assert.isNull(yield* command.reserveForRenderer);
    yield* command.setReady(true, "new-document");
    assert.isNull(yield* command.reserveForRenderer);
    yield* command.finish(rendererReservation!);
    const resumed = yield* command.reserveForRenderer;
    assert.isNotNull(resumed);
    yield* command.finish(rendererReservation!);
    assert.equal((yield* command.inspect).state, "busy");
    yield* command.finish(resumed!);
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

it.effect(
  "holds the run lease after local download completes while remote work survives renderer replacement",
  () =>
    Effect.gen(function* () {
      const firstSent = yield* Deferred.make<DesktopUpdateCommandRequest>();
      const secondSent = yield* Deferred.make<DesktopUpdateCommandRequest>();
      const nativeActive = yield* Ref.make(false);
      const remoteStarted = yield* Deferred.make<void>();
      const releaseRemote = yield* Deferred.make<void>();
      let sent = 0;
      yield* Effect.gen(function* () {
        const command = yield* DesktopUpdateCommand.DesktopUpdateCommand;
        yield* command.setReady(true, "renderer");
        const response = yield* command
          .request({ version: 1, requestId: "running", type: "update" })
          .pipe(Effect.forkScoped);
        const incoming = yield* Deferred.await(firstSent);
        yield* command.complete({
          version: 1,
          requestId: incoming.requestId,
          ok: true,
          status: "started",
        });
        yield* Fiber.join(response);
        // A component remount in the same document does not abandon its running promise.
        yield* command.setReady(false, "renderer");
        yield* command.setReady(true, "renderer");
        assert.isNull(yield* command.reserve);
        yield* Ref.set(nativeActive, true);
        const remoteRun = yield* Deferred.succeed(remoteStarted, undefined).pipe(
          Effect.andThen(Deferred.await(releaseRemote)),
          Effect.ensuring(command.finish(incoming.requestId)),
          Effect.forkScoped,
        );
        yield* Deferred.await(remoteStarted);
        yield* Ref.set(nativeActive, false);
        yield* command.setReady(false, "renderer");
        yield* command.setReady(true, "replacement");
        assert.isNull(yield* command.reserve);
        assert.isNull(yield* command.reserveForRenderer);
        const refused = yield* command.request({
          version: 1,
          requestId: "overlapping",
          type: "update",
        });
        assert.isFalse(refused.ok);
        if (!refused.ok) assert.include(refused.message, "outlived its interface");
        assert.equal((yield* command.inspect).state, "busy");
        yield* Deferred.succeed(releaseRemote, undefined);
        yield* Fiber.join(remoteRun);
        assert.equal((yield* command.inspect).state, "ready");
        const retry = yield* command
          .request({ version: 1, requestId: "retry", type: "update" })
          .pipe(Effect.forkScoped);
        const successor = yield* Deferred.await(secondSent);
        yield* command.finish(incoming.requestId);
        yield* command.setReady(false, "renderer");
        assert.equal((yield* command.inspect).state, "busy");
        yield* command.complete({
          version: 1,
          requestId: successor.requestId,
          ok: true,
          status: "cancelled",
        });
        assert.deepInclude(yield* Fiber.join(retry), { requestId: "retry", status: "cancelled" });
      }).pipe(
        Effect.provide(
          layer((request) => {
            Deferred.doneUnsafe(sent++ === 0 ? firstSent : secondSent, Effect.succeed(request));
          }, Ref.get(nativeActive)),
        ),
      );
    }),
);

it.effect("request interruption cannot release an accepted run", () =>
  Effect.gen(function* () {
    const sent = yield* Deferred.make<DesktopUpdateCommandRequest>();
    yield* Effect.gen(function* () {
      const command = yield* DesktopUpdateCommand.DesktopUpdateCommand;
      yield* command.setReady(true, "renderer");
      const request = yield* command
        .request({ version: 1, requestId: "interrupted", type: "update" })
        .pipe(Effect.forkScoped);
      const incoming = yield* Deferred.await(sent);
      assert.isTrue(
        yield* command.complete({
          version: 1,
          requestId: incoming.requestId,
          ok: true,
          status: "started",
        }),
      );
      yield* Fiber.interrupt(request);
      assert.equal((yield* command.inspect).state, "busy");
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
