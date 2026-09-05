import * as NetService from "@t3tools/shared/Net";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import {
  DesktopBackendPortInUseError,
  DesktopDevelopmentBackendPortRequiredError,
  resolveDesktopBackendPort,
} from "./DesktopApp.ts";

const netLayer = (canListenOnHost: (port: number, host: string) => boolean) =>
  Layer.succeed(NetService.NetService, {
    canListenOnHost: (port, host) => Effect.succeed(canListenOnHost(port, host)),
    isPortAvailableOnLoopback: () => Effect.die("unexpected isPortAvailableOnLoopback"),
    hasListenerOnHost: () => Effect.die("unexpected hasListenerOnHost"),
    reserveLoopbackPort: () => Effect.die("unexpected reserveLoopbackPort"),
    findAvailablePort: () => Effect.die("unexpected findAvailablePort"),
  } satisfies NetService.NetService["Service"]);

describe("DesktopApp errors", () => {
  it("preserves occupied default-port context", () => {
    const error = new DesktopBackendPortInUseError({
      port: 3_773,
      hosts: ["127.0.0.1"],
    });

    assert.equal(error.port, 3_773);
    assert.deepEqual(error.hosts, ["127.0.0.1"]);
    assert.equal(
      error.message,
      [
        "Desktop backend port 3773 is already in use on 127.0.0.1.",
        "T3 Code will not start another backend on a fallback port while using the same data directory.",
        "Connect to the running T3 Code server, stop it cleanly, or use a different T3CODE_HOME.",
      ].join("\n"),
    );
  });

  it.effect("uses the default port when every bind host is available", () =>
    Effect.gen(function* () {
      const selection = yield* resolveDesktopBackendPort(Option.none());
      assert.deepEqual(selection, { port: 3_773 });
    }).pipe(Effect.provide(netLayer(() => true))),
  );

  it.effect("refuses instead of scanning to another same-home port", () => {
    const probes: Array<{ readonly port: number; readonly host: string }> = [];
    return Effect.gen(function* () {
      const failure = yield* resolveDesktopBackendPort(Option.none()).pipe(Effect.flip);
      assert.strictEqual(failure._tag, "DesktopBackendPortInUseError");
      if (failure._tag === "DesktopBackendPortInUseError") {
        assert.strictEqual(failure.port, 3_773);
        assert.deepEqual(failure.hosts, ["127.0.0.1"]);
      }
      assert.deepEqual(probes, [
        { port: 3_773, host: "127.0.0.1" },
        { port: 3_773, host: "0.0.0.0" },
        { port: 3_773, host: "::" },
      ]);
    }).pipe(
      Effect.provide(
        netLayer((port, host) => {
          probes.push({ port, host });
          return host !== "127.0.0.1";
        }),
      ),
    );
  });

  it.effect("preserves an explicitly configured backend port", () =>
    Effect.gen(function* () {
      const selection = yield* resolveDesktopBackendPort(Option.some(9_999));
      assert.deepEqual(selection, { port: 9_999 });
    }).pipe(Effect.provide(netLayer(() => false))),
  );

  it("reports the required development port", () => {
    const error = new DesktopDevelopmentBackendPortRequiredError();

    assert.equal(error.message, "T3CODE_PORT is required in desktop development.");
  });
});
