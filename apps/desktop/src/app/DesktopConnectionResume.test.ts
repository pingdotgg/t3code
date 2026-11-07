import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

import * as ElectronPowerMonitor from "../electron/ElectronPowerMonitor.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import { SYSTEM_RESUME_CHANNEL } from "../ipc/channels.ts";
import { listen } from "./DesktopConnectionResume.ts";

describe("desktop connection resume", () => {
  it.effect("notifies renderers on repeated OS wakes without revealing a window", () =>
    Effect.gen(function* () {
      const registered = yield* Deferred.make<void>();
      const firstWake = yield* Deferred.make<void>();
      const secondWake = yield* Deferred.make<void>();
      let resume: (() => void) | undefined;
      const channels: string[] = [];
      const powerMonitor = ElectronPowerMonitor.ElectronPowerMonitor.of({
        isOnBatteryPower: Effect.succeed(false),
        getSystemIdleTime: Effect.succeed(0),
        getSystemIdleState: () => Effect.succeed("active"),
        getCurrentThermalState: Effect.succeed("nominal"),
        onSimpleEvent: (event, listener) =>
          Effect.acquireRelease(
            Effect.sync(() => {
              assert.equal(event, "resume");
              resume = listener;
            }).pipe(Effect.andThen(Deferred.succeed(registered, undefined))),
            () =>
              Effect.sync(() => {
                resume = undefined;
              }),
          ).pipe(Effect.asVoid),
        onThermalStateChange: () => Effect.void,
        onSpeedLimitChange: () => Effect.void,
      });
      const unexpectedWindowAccess = Effect.die("wake must not reveal or create windows");
      const windows = ElectronWindow.ElectronWindow.of({
        create: () => unexpectedWindowAccess,
        main: Effect.succeedNone,
        currentMainOrFirst: unexpectedWindowAccess,
        focusedMainOrFirst: unexpectedWindowAccess,
        setMain: () => unexpectedWindowAccess,
        clearMain: () => unexpectedWindowAccess,
        prepareReveal: () => unexpectedWindowAccess,
        reveal: () => unexpectedWindowAccess,
        sendAll: (channel) =>
          Effect.sync(() => {
            channels.push(channel);
          }).pipe(
            Effect.andThen(
              Effect.suspend(() =>
                Deferred.succeed(channels.length === 1 ? firstWake : secondWake, undefined),
              ),
            ),
            Effect.asVoid,
          ),
        destroyAll: unexpectedWindowAccess,
        syncAllAppearance: () => unexpectedWindowAccess,
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* listen;
          yield* Deferred.await(registered);
          resume?.();
          yield* Deferred.await(firstWake);
          resume?.();
          yield* Deferred.await(secondWake);
          assert.deepEqual(channels, [SYSTEM_RESUME_CHANNEL, SYSTEM_RESUME_CHANNEL]);
        }),
      ).pipe(
        Effect.provideService(ElectronPowerMonitor.ElectronPowerMonitor, powerMonitor),
        Effect.provideService(ElectronWindow.ElectronWindow, windows),
      );
      assert.isUndefined(resume, "the OS listener is removed when its scope ends");
    }),
  );
});
