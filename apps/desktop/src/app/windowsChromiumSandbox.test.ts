import { assert, describe, it } from "@effect/vitest";

import * as WindowsChromiumSandbox from "./windowsChromiumSandbox.ts";

describe("windowsChromiumSandbox", () => {
  it("keeps the Chromium sandbox enabled on Windows by default", () => {
    assert.deepEqual(
      WindowsChromiumSandbox.resolveWindowsChromiumSandboxSwitches({
        platform: "win32",
        env: {},
        argv: ["electron"],
        markerExists: () => false,
      }),
      [],
    );
  });

  it("disables the Chromium sandbox when explicitly opted in via env", () => {
    assert.deepEqual(
      WindowsChromiumSandbox.resolveWindowsChromiumSandboxSwitches({
        platform: "win32",
        env: { [WindowsChromiumSandbox.WINDOWS_CHROMIUM_SANDBOX_DISABLE_ENV]: "1" },
        argv: ["electron"],
        markerExists: () => false,
      }),
      ["no-sandbox"],
    );
  });

  it("disables the Chromium sandbox when argv already requests it", () => {
    assert.deepEqual(
      WindowsChromiumSandbox.resolveWindowsChromiumSandboxSwitches({
        platform: "win32",
        env: {},
        argv: ["electron", "--no-sandbox"],
        markerExists: () => false,
      }),
      ["no-sandbox"],
    );
  });

  it("ignores a bare positional no-sandbox argv entry", () => {
    assert.isFalse(
      WindowsChromiumSandbox.argvRequestsWindowsChromiumSandboxDisable([
        "electron",
        "C:\\projects\\no-sandbox",
        "no-sandbox",
      ]),
    );
    assert.deepEqual(
      WindowsChromiumSandbox.resolveWindowsChromiumSandboxSwitches({
        platform: "win32",
        env: {},
        argv: ["electron", "no-sandbox"],
        markerExists: () => false,
      }),
      [],
    );
  });

  it("disables the Chromium sandbox when a recovery marker is present", () => {
    assert.deepEqual(
      WindowsChromiumSandbox.resolveWindowsChromiumSandboxSwitches({
        platform: "win32",
        env: {},
        argv: ["electron"],
        markerPath: "C:\\marker",
        markerExists: (path) => path === "C:\\marker",
      }),
      ["no-sandbox"],
    );
  });

  it("leaves Chromium sandbox switches alone on macOS and Linux", () => {
    assert.deepEqual(
      WindowsChromiumSandbox.resolveWindowsChromiumSandboxSwitches({
        platform: "darwin",
        env: { [WindowsChromiumSandbox.WINDOWS_CHROMIUM_SANDBOX_DISABLE_ENV]: "1" },
        argv: ["electron", "--no-sandbox"],
        markerExists: () => true,
      }),
      [],
    );
    assert.deepEqual(
      WindowsChromiumSandbox.resolveWindowsChromiumSandboxSwitches({
        platform: "linux",
        env: { [WindowsChromiumSandbox.WINDOWS_CHROMIUM_SANDBOX_DISABLE_ENV]: "1" },
        argv: ["electron", "--no-sandbox"],
        markerExists: () => true,
      }),
      [],
    );
  });

  it("applies resolved switches through the provided append callback", () => {
    const applied: string[] = [];

    const switches = WindowsChromiumSandbox.applyWindowsChromiumSandboxSwitches({
      platform: "win32",
      env: { [WindowsChromiumSandbox.WINDOWS_CHROMIUM_SANDBOX_DISABLE_ENV]: "1" },
      argv: ["electron"],
      markerExists: () => false,
      appendSwitch: (switchName) => {
        applied.push(switchName);
      },
    });

    assert.deepEqual(switches, ["no-sandbox"]);
    assert.deepEqual(applied, ["no-sandbox"]);
  });

  it("does not append switches on non-Windows platforms", () => {
    const applied: string[] = [];

    const switches = WindowsChromiumSandbox.applyWindowsChromiumSandboxSwitches({
      platform: "darwin",
      env: { [WindowsChromiumSandbox.WINDOWS_CHROMIUM_SANDBOX_DISABLE_ENV]: "1" },
      appendSwitch: (switchName) => {
        applied.push(switchName);
      },
    });

    assert.deepEqual(switches, []);
    assert.deepEqual(applied, []);
  });

  it("resolves the recovery marker under T3CODE_HOME userdata", () => {
    assert.equal(
      WindowsChromiumSandbox.resolveWindowsChromiumSandboxMarkerPath("C:\\Users\\test", {
        T3CODE_HOME: "D:\\t3-home",
      }),
      "D:\\t3-home\\userdata\\windows-chromium-sandbox-workaround",
    );
  });

  it("identifies the Windows GPU STATUS_BREAKPOINT crash", () => {
    assert.isTrue(
      WindowsChromiumSandbox.isWindowsGpuSandboxBreakpointCrash({
        type: "GPU",
        exitCode: WindowsChromiumSandbox.WINDOWS_GPU_SANDBOX_BREAKPOINT_EXIT_CODE,
      }),
    );
    assert.isFalse(
      WindowsChromiumSandbox.isWindowsGpuSandboxBreakpointCrash({
        type: "Utility",
        exitCode: WindowsChromiumSandbox.WINDOWS_GPU_SANDBOX_BREAKPOINT_EXIT_CODE,
      }),
    );
  });

  it("adds --no-sandbox to relaunch args when missing", () => {
    assert.deepEqual(
      WindowsChromiumSandbox.buildWindowsChromiumSandboxRelaunchArgs([
        "C:\\T3 Code (Alpha).exe",
        "--some-flag",
      ]),
      ["--some-flag", "--no-sandbox"],
    );
  });

  it("installs GPU crash recovery that writes a marker and relaunches once", () => {
    const written: string[] = [];
    const relaunchArgs: Array<ReadonlyArray<string>> = [];
    const exits: number[] = [];
    let listener:
      | ((
          event: unknown,
          details: {
            readonly type?: string;
            readonly exitCode?: number;
          },
        ) => void)
      | undefined;

    const installed = WindowsChromiumSandbox.installWindowsChromiumSandboxRecovery({
      platform: "win32",
      env: {},
      argv: ["C:\\T3 Code (Alpha).exe"],
      markerPath: "C:\\marker",
      writeMarker: (path) => {
        written.push(path);
      },
      app: {
        on: (event, nextListener) => {
          assert.equal(event, "child-process-gone");
          listener = nextListener;
        },
        relaunch: ({ args }) => {
          relaunchArgs.push(args);
        },
        exit: (code = 0) => {
          exits.push(code);
        },
      },
    });

    assert.isTrue(installed);
    assert.isFunction(listener);

    listener?.(
      {},
      {
        type: "GPU",
        exitCode: WindowsChromiumSandbox.WINDOWS_GPU_SANDBOX_BREAKPOINT_EXIT_CODE,
      },
    );
    listener?.(
      {},
      {
        type: "GPU",
        exitCode: WindowsChromiumSandbox.WINDOWS_GPU_SANDBOX_BREAKPOINT_EXIT_CODE,
      },
    );

    assert.deepEqual(written, ["C:\\marker"]);
    assert.deepEqual(relaunchArgs, [["--no-sandbox"]]);
    assert.deepEqual(exits, [0]);
  });

  it("skips recovery installation when the workaround is already active", () => {
    const installed = WindowsChromiumSandbox.installWindowsChromiumSandboxRecovery({
      platform: "win32",
      env: { [WindowsChromiumSandbox.WINDOWS_CHROMIUM_SANDBOX_DISABLE_ENV]: "1" },
      argv: ["electron"],
      app: {
        on: () => {
          assert.fail("should not register recovery when already opted in");
        },
        relaunch: () => {
          assert.fail("should not relaunch when already opted in");
        },
        exit: () => {
          assert.fail("should not exit when already opted in");
        },
      },
    });

    assert.isFalse(installed);
  });

  it("does not install GPU recovery on macOS or Linux", () => {
    for (const platform of ["darwin", "linux"] as const) {
      const installed = WindowsChromiumSandbox.installWindowsChromiumSandboxRecovery({
        platform,
        env: {},
        argv: ["electron"],
        app: {
          on: () => {
            assert.fail(`should not register recovery on ${platform}`);
          },
          relaunch: () => {
            assert.fail(`should not relaunch on ${platform}`);
          },
          exit: () => {
            assert.fail(`should not exit on ${platform}`);
          },
        },
      });

      assert.isFalse(installed);
    }
  });
});
