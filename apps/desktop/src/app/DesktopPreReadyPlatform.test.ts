import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import {
  DesktopPreReadyElectronOptions,
  makeDesktopElectronPreReadyLayer,
  readCommandLineSwitchValue,
} from "./DesktopPreReadyPlatform.ts";

describe("DesktopPreReadyPlatform", () => {
  it("reads an explicit Electron command-line switch value", () => {
    const value = readCommandLineSwitchValue(
      {
        hasSwitch: (switchName) => switchName === "password-store",
        getSwitchValue: (switchName) => {
          assert.equal(switchName, "password-store");
          return "basic";
        },
      },
      "password-store",
    );

    assert.equal(value, "basic");
  });

  it("treats valueless Electron command-line switches as absent", () => {
    const value = readCommandLineSwitchValue(
      {
        hasSwitch: () => true,
        getSwitchValue: () => "",
      },
      "password-store",
    );

    assert.isNull(value);
  });

  it("returns null for missing Electron command-line switches", () => {
    const value = readCommandLineSwitchValue(
      {
        hasSwitch: () => false,
        getSwitchValue: () => {
          throw new Error("Unexpected switch value read.");
        },
      },
      "password-store",
    );

    assert.isNull(value);
  });

  it.effect("builds scheme privileges and command-line setup as sibling pre-ready effects", () =>
    Effect.gen(function* () {
      const schemeStarted = yield* Deferred.make<void>();
      const configureStarted = yield* Deferred.make<void>();

      const layer = makeDesktopElectronPreReadyLayer({
        schemePrivilegesLayer: Layer.effectDiscard(
          Deferred.succeed(schemeStarted, undefined).pipe(
            Effect.andThen(Deferred.await(configureStarted)),
          ),
        ),
        configureElectronBeforeReady: Deferred.succeed(configureStarted, undefined).pipe(
          Effect.andThen(Deferred.await(schemeStarted)),
          Effect.as({
            linux: null,
            linuxPasswordStoreCommandLine: null,
          }),
        ),
      });

      const options = yield* DesktopPreReadyElectronOptions.pipe(
        Effect.provide(layer),
        Effect.timeoutOption("50 millis"),
      );

      assert.deepEqual(Option.getOrNull(options), {
        linux: null,
        linuxPasswordStoreCommandLine: null,
      });
    }),
  );
});
