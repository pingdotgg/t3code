import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { beforeEach, vi } from "vite-plus/test";

const { getSystemLocaleMock, getUserDefaultMock, isPackagedMock, relaunchMock } = vi.hoisted(
  () => ({
    getSystemLocaleMock: vi.fn(() => "en-GB"),
    getUserDefaultMock: vi.fn((_key: string) => false),
    isPackagedMock: vi.fn(() => true),
    relaunchMock: vi.fn(),
  }),
);

vi.mock("electron", () => ({
  app: {
    getSystemLocale: getSystemLocaleMock,
    get isPackaged() {
      return isPackagedMock();
    },
    relaunch: relaunchMock,
  },
  systemPreferences: {
    getUserDefault: getUserDefaultMock,
  },
}));

import * as ElectronApp from "./ElectronApp.ts";

const electronAppLayer = ElectronApp.layer.pipe(Layer.provide(NodeServices.layer));

describe("ElectronApp", () => {
  beforeEach(() => {
    getSystemLocaleMock.mockReset();
    getUserDefaultMock.mockReset();
    isPackagedMock.mockReturnValue(true);
    relaunchMock.mockClear();
  });

  it.effect.each([
    { platform: "linux", APPIMAGE: undefined, packaged: true },
    { platform: "linux", APPIMAGE: "/tmp/app.AppImage", packaged: false },
    { platform: "darwin", APPIMAGE: "/tmp/app.AppImage", packaged: true },
    {
      platform: "linux",
      APPIMAGE: "/tmp/other.AppImage",
      packaged: true,
      executablePath: "/tmp/mount-other/t3code",
    },
  ] as const)("keeps native relaunch outside packaged AppImages: %j", (input) => {
    isPackagedMock.mockReturnValue(input.packaged);
    return Effect.gen(function* () {
      const app = yield* ElectronApp.ElectronApp;
      yield* app.relaunch({ args: ["two words"] });
      assert.deepEqual(relaunchMock.mock.calls, [[{ args: ["two words"] }]]);
    }).pipe(
      Effect.provide(electronAppLayer),
      Effect.provideService(HostProcess.Platform, input.platform),
      Effect.provideService(HostProcess.Environment, {
        APPIMAGE: input.APPIMAGE,
        APPDIR: "/tmp/mount",
      }),
      Effect.provideService(
        HostProcess.ExecutablePath,
        "executablePath" in input ? input.executablePath : "/tmp/mount/t3code",
      ),
    );
  });

  it.effect("relaunches the AppImage after the parent exits, without inherited descriptors", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3 appimage relaunch " });
      const launcher = path.join(directory, " launcher (AppImage) ");
      const output = path.join(directory, "result");
      const startup = path.join(directory, "startup");
      const startupMarker = path.join(directory, "startup-ran");
      yield* fs.writeFileString(startup, `printf ran >> "${startupMarker}"\nexec </dev/null\n`);
      yield* fs.writeFileString(
        launcher,
        '#!/usr/bin/env bash\nif [ -e /proc/self/fd/3 ] || [ -e /proc/self/fd/65 ]; then exit 65; fi\nprintf "%s\\n" "$BASH_ENV" "$ENV" "$@" > "$1"\n',
      );
      yield* fs.chmod(launcher, 0o700);
      let command: ChildProcess.StandardCommand | undefined;
      let unreferenced = false;
      const recordingSpawner = ChildProcessSpawner.make((value) =>
        Effect.sync(() => {
          assert.equal(value._tag, "StandardCommand");
          command = value as ChildProcess.StandardCommand;
          return ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(0),
            exitCode: Effect.never,
            isRunning: Effect.succeed(true),
            kill: () => Effect.void,
            stdin: Sink.drain,
            stdout: Stream.empty,
            stderr: Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
            unref: Effect.sync(() => {
              unreferenced = true;
              return Effect.void;
            }),
          });
        }),
      );
      yield* Effect.gen(function* () {
        const app = yield* ElectronApp.ElectronApp;
        yield* app.relaunch({ args: [output, "two words", "$HOME", "(Nightly)", " trailing "] });
      }).pipe(
        Effect.provide(ElectronApp.layer),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, recordingSpawner),
        Effect.provideService(HostProcess.Platform, "linux"),
        Effect.provideService(HostProcess.ExecutablePath, path.join(directory, "mount", "t3code")),
        Effect.provideService(HostProcess.Environment, {
          ...process.env,
          APPIMAGE: launcher,
          APPDIR: path.join(directory, "mount"),
          BASH_ENV: startup,
          ENV: startup,
          SHELLOPTS: "braceexpand:hashall:interactive-comments",
          // Node uses a socket for stdin; skip Bash's remote-shell startup heuristic.
          SHLVL: "1",
        }),
      );
      assert.equal(relaunchMock.mock.calls.length, 0);
      assert.isTrue(unreferenced);
      assert.isDefined(command);
      const waiting = yield* spawner.spawn(
        ChildProcess.make(command!.command, command!.args, {
          ...command!.options,
          detached: false,
          additionalFds: { fd3: { type: "output" }, fd65: { type: "output" } },
        }),
      );
      assert.isTrue(yield* waiting.isRunning);
      assert.isFalse(yield* fs.exists(output));
      // Closing the parent-owned pipe stands in for parent exit.
      yield* Stream.run(Stream.empty, waiting.stdin);
      assert.equal(yield* waiting.exitCode, 0);
      // Only the replacement may source startup files, after the parent-exit wait.
      assert.equal(yield* fs.readFileString(startupMarker), "ran");
      assert.equal(
        yield* fs.readFileString(output),
        `${startup}\n${startup}\n${output}\ntwo words\n$HOME\n(Nightly)\n trailing \n`,
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

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
    }).pipe(Effect.provide(electronAppLayer)),
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
    }).pipe(Effect.provide(electronAppLayer)),
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
      const electronApp = yield* ElectronApp.ElectronApp;
      const locale = yield* electronApp.systemLocale.pipe(
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
  }).pipe(Effect.provide(electronAppLayer)),
);
