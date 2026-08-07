import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  DesktopBackendPortUnavailableError,
  DesktopDevelopmentBackendPortRequiredError,
  restartBackendAfterCuaDriverExit,
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

  it.effect("restarts a running backend so stale Cua launch args are discarded", () => {
    const events: Array<string> = [];
    const backend = {
      snapshot: Effect.succeed({
        desiredRunning: true,
        ready: true,
        activePid: Option.some(42),
        restartAttempt: 0,
        restartScheduled: false,
      }),
      stop: () =>
        Effect.sync(() => {
          events.push("stop");
        }),
      start: Effect.sync(() => {
        events.push("start");
      }),
    };

    return restartBackendAfterCuaDriverExit(backend, Effect.succeed(false)).pipe(
      Effect.tap((restarted) =>
        Effect.sync(() => {
          assert.isTrue(restarted);
          assert.deepEqual(events, ["stop", "start"]);
        }),
      ),
    );
  });
});
