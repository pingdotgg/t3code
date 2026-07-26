import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { resolveDesktopRelaunchOptions } from "./resolveDesktopRelaunchOptions.ts";

describe("resolveDesktopRelaunchOptions", () => {
  it.effect("relaunches the outer AppImage path instead of the temporary mount binary", () =>
    Effect.sync(() => {
      const options = resolveDesktopRelaunchOptions({
        appImagePath: "/home/user/T3-Code-0.0.28-x86_64.AppImage",
        execPath: "/tmp/.mount_t3_codXXXX/t3-code",
        argv: ["/tmp/.mount_t3_codXXXX/t3-code", "--some-internal-flag"],
      });

      assert.deepEqual(options, {
        execPath: "/home/user/T3-Code-0.0.28-x86_64.AppImage",
        args: [],
      });
    }),
  );

  it.effect("trims APPIMAGE and ignores empty values", () =>
    Effect.sync(() => {
      assert.deepEqual(
        resolveDesktopRelaunchOptions({
          appImagePath: "  /opt/T3-Code.AppImage  ",
          execPath: "/tmp/.mount/app",
          argv: ["/tmp/.mount/app"],
        }),
        {
          execPath: "/opt/T3-Code.AppImage",
          args: [],
        },
      );

      assert.deepEqual(
        resolveDesktopRelaunchOptions({
          appImagePath: "   ",
          execPath: "/usr/bin/t3-code",
          argv: ["/usr/bin/t3-code", "--flag"],
        }),
        {
          execPath: "/usr/bin/t3-code",
          args: ["--flag"],
        },
      );
    }),
  );

  it.effect("preserves packaged non-AppImage exec path and argv", () =>
    Effect.sync(() => {
      const options = resolveDesktopRelaunchOptions({
        appImagePath: null,
        execPath: "/Applications/T3 Code.app/Contents/MacOS/T3 Code",
        argv: ["/Applications/T3 Code.app/Contents/MacOS/T3 Code", "--inspect"],
      });

      assert.deepEqual(options, {
        execPath: "/Applications/T3 Code.app/Contents/MacOS/T3 Code",
        args: ["--inspect"],
      });
    }),
  );
});
