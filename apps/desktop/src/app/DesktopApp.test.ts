import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as NetService from "@t3tools/shared/Net";

import { resolveDesktopBackendPort } from "./DesktopApp.ts";

// Every host probe answers "free", which is what the Electron main process
// really sees on Windows while a WSL-side listener holds the port.
const makeNetLayer = (probedPorts: number[]) =>
  Layer.succeed(NetService.NetService, {
    canListenOnHost: (port) =>
      Effect.sync(() => {
        probedPorts.push(port);
        return true;
      }),
    isPortAvailableOnLoopback: () => Effect.succeed(true),
    hasListenerOnHost: () => Effect.succeed(false),
    reserveLoopbackPort: () => Effect.succeed(41_773),
    findAvailablePort: (preferred) => Effect.succeed(preferred),
  } satisfies NetService.NetService["Service"]);

describe("resolveDesktopBackendPort", () => {
  it.effect("takes the default port when nothing is known about a distro", () =>
    Effect.gen(function* () {
      const selection = yield* resolveDesktopBackendPort(Option.none(), new Set());

      assert.equal(selection.port, 3773);
      assert.isTrue(selection.selectedByScan);
    }).pipe(Effect.provide(makeNetLayer([]))),
  );

  it.effect("skips a port the WSL distro already listens on", () => {
    const probedPorts: number[] = [];

    return Effect.gen(function* () {
      const selection = yield* resolveDesktopBackendPort(Option.none(), new Set([3773]));

      assert.equal(selection.port, 3774);
      assert.isTrue(selection.selectedByScan);
      // 3773 is rejected on the distro's evidence alone; the Windows-side bind
      // check would have called it free and handed it to the WSL backend.
      assert.notInclude(probedPorts, 3773);
    }).pipe(Effect.provide(makeNetLayer(probedPorts)));
  });

  it.effect("leaves an explicitly configured port alone", () =>
    Effect.gen(function* () {
      const selection = yield* resolveDesktopBackendPort(Option.some(9999), new Set([9999]));

      assert.equal(selection.port, 9999);
      assert.isFalse(selection.selectedByScan);
    }).pipe(Effect.provide(makeNetLayer([]))),
  );
});
