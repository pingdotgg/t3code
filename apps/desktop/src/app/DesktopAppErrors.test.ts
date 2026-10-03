import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { recoverShellEnvironment } from "../shell/DesktopShellEnvironmentRecovery.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as DesktopShellEnvironment from "../shell/DesktopShellEnvironment.ts";

import {
  DesktopBackendPortUnavailableError,
  DesktopDevelopmentBackendPortRequiredError,
} from "./DesktopApp.ts";

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
});

describe("shell environment recovery", () => {
  it.effect.each([
    { responses: [0], failures: 0, attempts: 1 },
    { responses: [0, 0], failures: 1, attempts: 2 },
    { responses: [1], failures: 0, attempts: 0 },
    { responses: [0, 1], failures: 1, attempts: 1 },
  ])("recovers or continues: %j", ({ responses, failures, attempts }) =>
    Effect.gen(function* () {
      let captures = 0;
      let dialogs = 0;
      yield* recoverShellEnvironment().pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(DesktopShellEnvironment.DesktopShellEnvironment, {
              installIntoProcess: Effect.suspend(() => {
                captures++;
                return captures <= failures
                  ? Effect.fail(new DesktopShellEnvironment.DesktopShellEnvironmentCaptureError())
                  : Effect.void;
              }),
            }),
            Layer.succeed(ElectronDialog.ElectronDialog, {
              pickFolder: () => Effect.die("unused"),
              pickFiles: () => Effect.die("unused"),
              showErrorBox: () => Effect.die("unused"),
              showMessageBox: () =>
                Effect.sync(() => {
                  const response = responses[dialogs++];
                  assert.isDefined(response);
                  return { response: response ?? 1, checkboxChecked: false };
                }),
            }),
          ),
        ),
      );
      assert.equal(captures, attempts);
      assert.equal(dialogs, responses.length);
    }),
  );
});
