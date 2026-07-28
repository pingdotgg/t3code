// @effect-diagnostics nodeBuiltinImport:off - Skip predicate runs at collection time, outside any Effect runtime.
import * as NodeFS from "node:fs";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  buildAppImageRelaunchShellCommand,
  posixShellSingleQuote,
  resolveDesktopRelaunchPlan,
} from "./resolveDesktopRelaunchOptions.ts";
import { scheduleAppImageRelaunch } from "./scheduleAppImageRelaunch.ts";

describe("resolveDesktopRelaunchPlan", () => {
  it.effect("schedules a delayed AppImage re-exec with flag argv only", () =>
    Effect.sync(() => {
      const plan = resolveDesktopRelaunchPlan({
        appImagePath: "/home/user/T3-Code-0.0.28-x86_64.AppImage",
        execPath: "/tmp/.mount_t3_codXXXX/t3code",
        argv: [
          "/tmp/.mount_t3_codXXXX/t3code",
          "--no-sandbox",
          "/tmp/.mount_t3_codXXXX/resources/app.asar",
        ],
      });

      assert.deepEqual(plan, {
        kind: "appimage-delayed",
        appImagePath: "/home/user/T3-Code-0.0.28-x86_64.AppImage",
        args: ["--no-sandbox"],
        delayMs: 1_000,
      });
    }),
  );

  it.effect("trims APPIMAGE and falls back to electron relaunch when empty", () =>
    Effect.sync(() => {
      assert.deepEqual(
        resolveDesktopRelaunchPlan({
          appImagePath: "  /opt/T3-Code.AppImage  ",
          execPath: "/tmp/.mount/app",
          argv: ["/tmp/.mount/app"],
        }),
        {
          kind: "appimage-delayed",
          appImagePath: "/opt/T3-Code.AppImage",
          args: [],
          delayMs: 1_000,
        },
      );

      assert.deepEqual(
        resolveDesktopRelaunchPlan({
          appImagePath: "   ",
          execPath: "/usr/bin/t3-code",
          argv: ["/usr/bin/t3-code", "--flag"],
        }),
        {
          kind: "electron",
          execPath: "/usr/bin/t3-code",
          args: ["--flag"],
        },
      );
    }),
  );

  it.effect("preserves packaged non-AppImage exec path and argv", () =>
    Effect.sync(() => {
      const plan = resolveDesktopRelaunchPlan({
        appImagePath: null,
        execPath: "/Applications/T3 Code.app/Contents/MacOS/T3 Code",
        argv: ["/Applications/T3 Code.app/Contents/MacOS/T3 Code", "--inspect"],
      });

      assert.deepEqual(plan, {
        kind: "electron",
        execPath: "/Applications/T3 Code.app/Contents/MacOS/T3 Code",
        args: ["--inspect"],
      });
    }),
  );
});

describe("buildAppImageRelaunchShellCommand", () => {
  it.effect("quotes the AppImage path and delays before exec", () =>
    Effect.sync(() => {
      const command = buildAppImageRelaunchShellCommand({
        appImagePath: "/home/user/T3 Code.AppImage",
        args: ["--no-sandbox"],
        delayMs: 1_000,
      });

      assert.equal(
        command,
        `sleep 1 && exec ${posixShellSingleQuote("/home/user/T3 Code.AppImage")} ${posixShellSingleQuote("--no-sandbox")}`,
      );

      assert.equal(posixShellSingleQuote("it's"), `'it'\\''s'`);
    }),
  );

  it.effect("omits the fd cleanup unless the shell is known to handle it", () =>
    Effect.sync(() => {
      const base = {
        appImagePath: "/opt/T3.AppImage",
        args: [],
        delayMs: 1_000,
      } as const;

      // dash reads `exec 10>&-` as a command named "10" and a failed exec kills
      // a non-interactive shell, so emitting this for /bin/sh would abort the
      // helper before the re-exec and lose the app entirely.
      assert.isFalse(buildAppImageRelaunchShellCommand(base).includes("/proc/$$/fd"));

      const withCleanup = buildAppImageRelaunchShellCommand({
        ...base,
        closeInheritedFds: true,
      });
      // Must run before the sleep, so the outgoing mount can be released during it.
      assert.isTrue(withCleanup.startsWith("for fd in /proc/$$/fd/*;"), withCleanup);
      assert.isTrue(
        withCleanup.indexOf("exec $n>&-") < withCleanup.indexOf("sleep 1"),
        withCleanup,
      );
    }),
  );

  it.effect("captures helper stderr when a log path is supplied", () =>
    Effect.sync(() => {
      const command = buildAppImageRelaunchShellCommand({
        appImagePath: "/opt/T3.AppImage",
        args: [],
        delayMs: 1_000,
        logPath: "/home/user/.t3/logs/relaunch.log",
      });

      // The exec runs after the app has exited, so a failure there can only be
      // reported by what it leaves behind.
      assert.isTrue(
        command.endsWith(`; } 2>>${posixShellSingleQuote("/home/user/.t3/logs/relaunch.log")}`),
        command,
      );
    }),
  );
});

describe("scheduleAppImageRelaunch", () => {
  // Really spawns the helper. The code path is POSIX-only by construction, so
  // gate on the shell it needs rather than on a platform name — on a Windows
  // dev machine (a supported setup) this would otherwise fail with ENOENT.
  it.effect.skipIf(!NodeFS.existsSync("/bin/sh"))(
    "resolves only once the detached helper has actually spawned",
    () =>
      // Resolves on the `spawn` event, well before the helper's sleep elapses.
      // The caller depends on this to know it is safe to release the
      // single-instance lock and exit rather than vanishing on a failed spawn.
      Effect.promise(() =>
        scheduleAppImageRelaunch({
          kind: "appimage-delayed",
          appImagePath: "/bin/true",
          args: [],
          delayMs: 200,
        }),
      ),
  );
});
