import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import {
  DesktopBackendPortUnavailableError,
  DesktopDevelopmentBackendPortRequiredError,
  handleClientOnlyRendererReady,
  latchDesktopBackendModeForStartup,
} from "./DesktopApp.ts";
import * as DesktopBackendMode from "./DesktopBackendMode.ts";
import * as DesktopShutdown from "./DesktopShutdown.ts";
import * as DesktopState from "./DesktopState.ts";

describe("DesktopApp errors", () => {
  it("preserves unavailable backend port context", () => {
    const error = new DesktopBackendPortUnavailableError({
      startPort: 3_773,
      maxPort: 65_535,
      hosts: ["127.0.0.1", "0.0.0.0", "::"],
    });

    assert.equal(error.startPort, 3_773);
    assert.equal(error.maxPort, 65_535);
    assert.deepEqual(error.hosts, ["127.0.0.1", "0.0.0.0", "::"]);
    assert.equal(
      error.message,
      "No desktop backend port is available on hosts 127.0.0.1, 0.0.0.0, :: between 3773 and 65535.",
    );
  });

  it("reports the required development port", () => {
    const error = new DesktopDevelopmentBackendPortRequiredError();

    assert.equal(error.message, "T3CODE_PORT is required in desktop development.");
  });

  it.effect("propagates client-only window creation failures", () =>
    Effect.gen(function* () {
      const error = new Error("window creation failed");

      const exit = yield* Effect.exit(handleClientOnlyRendererReady(Effect.fail(error)));
      assert(Exit.isFailure(exit));
      const failure = Cause.findErrorOption(exit.cause);
      assert(Option.isSome(failure));
      assert.strictEqual(failure.value, error);
    }),
  );

  it.effect("reports invalid backend-mode launch arguments as fatal startup errors", () =>
    Effect.gen(function* () {
      const quitCount = yield* Ref.make(0);
      const shownErrors = yield* Ref.make<readonly { title: string; content: string }[]>([]);

      const layer = Layer.mergeAll(
        DesktopBackendMode.layerTest(["electron", "--backend-mode=invalid"]),
        DesktopShutdown.layer,
        DesktopState.layer,
        Layer.mock(ElectronApp.ElectronApp)({
          quit: Ref.update(quitCount, (count) => count + 1),
        }),
        Layer.mock(ElectronDialog.ElectronDialog)({
          showErrorBox: (title, content) =>
            Ref.update(shownErrors, (errors) => [...errors, { title, content }]),
        }),
      );

      yield* Effect.gen(function* () {
        const exit = yield* Effect.exit(latchDesktopBackendModeForStartup("managed"));
        assert(Exit.isFailure(exit));
        const failure = Cause.findErrorOption(exit.cause);
        assert(Option.isSome(failure));
        assert(
          DesktopBackendMode.isDesktopBackendModeArgumentError(failure.value),
          "expected the original backend mode argument error",
        );

        const errors = yield* Ref.get(shownErrors);
        assert.equal(errors.length, 1);
        assert.equal(errors[0]?.title, "T3 Code failed to start");
        assert.include(errors[0]?.content ?? "", "Stage: backendMode");
        assert.include(errors[0]?.content ?? "", 'Invalid --backend-mode value "invalid"');
        assert.equal(yield* Ref.get(quitCount), 1);

        const state = yield* DesktopState.DesktopState;
        assert.isTrue(yield* Ref.get(state.quitting));
        const shutdown = yield* DesktopShutdown.DesktopShutdown;
        yield* shutdown.awaitRequest;
      }).pipe(Effect.provide(layer));
    }),
  );
});
