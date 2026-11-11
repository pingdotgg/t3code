import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import { beforeEach, vi } from "vite-plus/test";

const { getSystemLocaleMock, getUserDefaultMock } = vi.hoisted(() => ({
  getSystemLocaleMock: vi.fn(() => "en-GB"),
  getUserDefaultMock: vi.fn((_key: string) => false),
}));

const { appEvents } = await vi.hoisted(async () => {
  const { EventEmitter } = await import("node:events");
  return { appEvents: new EventEmitter() };
});
const { autoUpdaterMock } = vi.hoisted(() => ({
  autoUpdaterMock: { autoInstallOnAppQuit: false },
}));
vi.mock("electron-updater", () => ({ autoUpdater: autoUpdaterMock }));

vi.mock("electron", () => ({
  app: {
    getSystemLocale: getSystemLocaleMock,
    once: appEvents.once.bind(appEvents),
  },
  systemPreferences: {
    getUserDefault: getUserDefaultMock,
  },
}));

import * as ElectronApp from "./ElectronApp.ts";
import * as ElectronUpdater from "./ElectronUpdater.ts";

describe("ElectronApp", () => {
  beforeEach(() => {
    getSystemLocaleMock.mockReset();
    getUserDefaultMock.mockReset();
  });

  it("keeps the macOS region override and hour cycle in the locale tag", () => {
    assert.strictEqual(ElectronApp.toSystemLocaleTag("en_GB"), "en-GB");
    assert.strictEqual(ElectronApp.toSystemLocaleTag("en-US@rg=nlzzzz", "h12"), "en-NL-u-hc-h12");
    assert.strictEqual(ElectronApp.toSystemLocaleTag("en_US@rg=nlzzzz"), "en-NL");
    assert.strictEqual(ElectronApp.toSystemLocaleTag("en-GB", "h23"), "en-GB-u-hc-h23");
  });

  it("drops ICU keywords Intl cannot read instead of losing the whole locale", () => {
    assert.strictEqual(ElectronApp.toSystemLocaleTag("de_DE@calendar=buddhist"), "de-DE");
  });

  it.effect("follows LC_TIME on Linux when it differs from the language", () =>
    Effect.gen(function* () {
      const electronApp = yield* ElectronApp.ElectronApp;
      const systemLocale = yield* electronApp.systemLocale.pipe(
        Effect.provideService(HostProcess.Platform, "linux"),
        Effect.provideService(HostProcess.Environment, {
          LANG: "en_US.UTF-8",
          LC_TIME: "de_DE.UTF-8",
        }),
      );

      assert.strictEqual(systemLocale, "de-DE");
    }).pipe(Effect.provide(ElectronApp.layer)),
  );

  it.effect("falls back to Chromium's locale on Linux when the time locale is C", () =>
    Effect.gen(function* () {
      getSystemLocaleMock.mockImplementationOnce(() => "fr-FR");
      const electronApp = yield* ElectronApp.ElectronApp;
      const systemLocale = yield* electronApp.systemLocale.pipe(
        Effect.provideService(HostProcess.Platform, "linux"),
        Effect.provideService(HostProcess.Environment, { LANG: "C.UTF-8" }),
      );

      assert.strictEqual(systemLocale, "fr-FR");
    }).pipe(Effect.provide(ElectronApp.layer)),
  );
});

it.effect("reads both macOS hour preferences without overriding explicit formats", () =>
  Effect.gen(function* () {
    for (const [preference, expected] of [
      ["AppleICUForce12HourTime", "en-NL-u-hc-h12"],
      ["AppleICUForce24HourTime", "en-NL-u-hc-h23"],
      ["", "en-NL"],
    ]) {
      getSystemLocaleMock.mockReturnValue("en_US@rg=nlzzzz");
      getUserDefaultMock.mockImplementation((key) => key === preference);
      const locale = yield* ElectronApp.make.systemLocale.pipe(
        Effect.provideService(HostProcess.Platform, "darwin"),
      );
      assert.strictEqual(locale, expected);
      for (const hour12 of [true, false]) {
        assert.strictEqual(
          new Intl.DateTimeFormat(locale, { hour: "numeric", hour12 }).resolvedOptions().hour12,
          hour12,
        );
      }
    }
  }),
);

it.effect("records only an armed normal quit after the updater scope closes", () =>
  Effect.gen(function* () {
    const updater = yield* ElectronUpdater.ElectronUpdater;
    const recordInstall = vi.fn();
    for (const [exitCode, armed, expectedRecords] of [
      [1, true, 0],
      [0, false, 0],
      [0, true, 1],
    ] as const) {
      yield* updater.setAutoInstallOnAppQuit(true);
      yield* Effect.scoped(updater.onInstallOnAppQuit(recordInstall));
      yield* updater.setAutoInstallOnAppQuit(armed);
      appEvents.emit("quit", {}, exitCode);
      assert.equal(recordInstall.mock.calls.length, expectedRecords);
    }
  }).pipe(Effect.provide(ElectronUpdater.layer)),
);
