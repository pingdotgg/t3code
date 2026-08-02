import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as BootService from "../cloud/bootService.ts";
import { formatServiceStatus, restartHealthyCurrentService } from "./service.ts";

const paths = BootService.servicePaths({
  homeDir: "/Users/me",
  canonicalBaseDir: "/data",
  userId: 501,
});

it("distinguishes installed definitions from a running service", () => {
  const text = formatServiceStatus({
    ...paths,
    supported: true,
    platform: "darwin",
    installed: true,
    enabled: true,
    loaded: true,
    processAlive: false,
    responsive: false,
    current: true,
  });
  assert.include(text, "Installed: yes");
  assert.include(text, "Process: not running");
  assert.include(text, "Current: yes");
});

it("reports unsupported platforms explicitly", () => {
  assert.include(
    formatServiceStatus({
      ...BootService.servicePaths({ homeDir: "/Users/me", canonicalBaseDir: "/data", userId: 0 }),
      supported: false,
      platform: "win32",
      installed: false,
      enabled: false,
      loaded: false,
      processAlive: false,
      responsive: false,
      current: false,
    }),
    "unsupported on win32",
  );
});

it.effect("restarts an already healthy service so Connect reconciles immediately", () =>
  Effect.gen(function* () {
    let restarts = 0;
    const service = BootService.BootService.of({
      install: () => Effect.die("unexpected install"),
      status: Effect.succeed({
        ...paths,
        supported: true,
        platform: "darwin",
        installed: true,
        enabled: true,
        loaded: true,
        processAlive: true,
        responsive: true,
        pid: 4321,
        current: true,
      }),
      start: Effect.die("unexpected start"),
      restart: Effect.sync(() => {
        restarts += 1;
      }),
      stop: Effect.die("unexpected stop"),
      enable: Effect.die("unexpected enable"),
      disable: Effect.die("unexpected disable"),
      uninstall: Effect.die("unexpected uninstall"),
    });

    assert.isTrue(
      yield* restartHealthyCurrentService(service, {
        ...paths,
        supported: true,
        platform: "darwin",
        installed: true,
        enabled: true,
        loaded: true,
        processAlive: true,
        responsive: true,
        pid: 4321,
        current: true,
      }),
    );
    assert.equal(restarts, 1);
  }),
);
