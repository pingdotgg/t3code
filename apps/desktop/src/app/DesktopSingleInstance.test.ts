import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopSingleInstance from "./DesktopSingleInstance.ts";

const makeSingleInstanceLayer = (input: {
  readonly isPrimaryInstance: boolean;
  readonly events?: string[];
}) => {
  const events = input.events ?? [];
  const environment = DesktopEnvironment.DesktopEnvironment.of({
    stateDir: "/tmp/t3-state",
    isDevelopment: true,
    appDataDirectory: "/tmp/app-data",
    userDataDirName: "t3code-dev",
    legacyUserDataDirName: "T3 Code (Dev)",
    path: { join: (...parts: ReadonlyArray<string>) => parts.join("/") },
  } as unknown as DesktopEnvironment.DesktopEnvironment["Service"]);

  const electronApp = {
    setPath: (name: string, value: string) =>
      Effect.sync(() => {
        events.push(`setPath:${name}:${value}`);
      }),
    requestSingleInstanceLock: Effect.sync(() => {
      events.push("requestSingleInstanceLock");
      return input.isPrimaryInstance;
    }),
  } as unknown as ElectronApp.ElectronApp["Service"];

  return DesktopSingleInstance.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(DesktopEnvironment.DesktopEnvironment, environment),
        Layer.succeed(ElectronApp.ElectronApp, electronApp),
        FileSystem.layerNoop({ exists: () => Effect.succeed(false) }),
      ),
    ),
  );
};

const makeConfigureElectronApp = (input: {
  readonly quit: () => void;
  readonly registeredEvents: string[];
}) =>
  ({
    quit: Effect.sync(input.quit),
    on: (eventName: string) =>
      Effect.sync(() => {
        input.registeredEvents.push(eventName);
      }),
  }) as unknown as ElectronApp.ElectronApp["Service"];

describe("DesktopSingleInstance", () => {
  it.effect("sets the real userData path before acquiring the single-instance lock", () => {
    const events: string[] = [];

    return Effect.gen(function* () {
      yield* Effect.scoped(
        Layer.build(makeSingleInstanceLayer({ isPrimaryInstance: true, events })),
      );

      // Electron scopes the lock to userData and creates that directory when
      // the lock is acquired, so the real path must be set first — under the
      // default productName-derived path, acquiring the lock would create the
      // legacy directory and trip legacy-install detection on fresh installs.
      assert.deepEqual(events, [
        "setPath:userData:/tmp/app-data/t3code-dev",
        "requestSingleInstanceLock",
      ]);
    });
  });

  it.effect("registers the second-instance handler in the primary instance", () => {
    const quit = vi.fn();
    const registeredEvents: string[] = [];
    const electronWindow = {} as ElectronWindow.ElectronWindow["Service"];

    return Effect.gen(function* () {
      const singleInstance = yield* DesktopSingleInstance.DesktopSingleInstance;
      const exit = yield* Effect.exit(Effect.scoped(singleInstance.configure));

      assert.isTrue(Exit.isSuccess(exit));
      assert.equal(quit.mock.calls.length, 0);
      assert.deepEqual(registeredEvents, ["second-instance"]);
    }).pipe(
      Effect.provide(makeSingleInstanceLayer({ isPrimaryInstance: true })),
      Effect.provideService(
        ElectronApp.ElectronApp,
        makeConfigureElectronApp({ quit, registeredEvents }),
      ),
      Effect.provideService(ElectronWindow.ElectronWindow, electronWindow),
    );
  });

  it.effect("quits and interrupts startup in a secondary instance", () => {
    const quit = vi.fn();
    const registeredEvents: string[] = [];
    const electronWindow = {} as ElectronWindow.ElectronWindow["Service"];

    return Effect.gen(function* () {
      const singleInstance = yield* DesktopSingleInstance.DesktopSingleInstance;
      const exit = yield* Effect.exit(Effect.scoped(singleInstance.configure));

      assert.isTrue(Exit.hasInterrupts(exit));
      assert.equal(quit.mock.calls.length, 1);
      assert.deepEqual(registeredEvents, []);
    }).pipe(
      Effect.provide(makeSingleInstanceLayer({ isPrimaryInstance: false })),
      Effect.provideService(
        ElectronApp.ElectronApp,
        makeConfigureElectronApp({ quit, registeredEvents }),
      ),
      Effect.provideService(ElectronWindow.ElectronWindow, electronWindow),
    );
  });
});
