import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  buildAppImageRelaunchShellCommand,
  posixShellSingleQuote,
  resolveDesktopRelaunchPlan,
} from "./resolveDesktopRelaunchOptions.ts";

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
      assert.equal(
        buildAppImageRelaunchShellCommand({
          appImagePath: "/home/user/T3 Code.AppImage",
          args: ["--no-sandbox"],
          delayMs: 1_000,
        }),
        `sleep 1.0 && exec ${posixShellSingleQuote("/home/user/T3 Code.AppImage")} ${posixShellSingleQuote("--no-sandbox")}`,
      );

      assert.equal(posixShellSingleQuote("it's"), `'it'\\''s'`);
    }),
  );
});
