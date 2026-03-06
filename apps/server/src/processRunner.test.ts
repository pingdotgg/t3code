import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  makeRuntimeCommand,
  resolveProcessLaunchPlan,
  runProcess,
  spawnDetachedProcess,
  spawnProcessSync,
} from "./processRunner";

function withTempDir(run: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-process-runner-"));
  try {
    run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe("runProcess", () => {
  it("fails when output exceeds max buffer in default mode", async () => {
    await expect(
      runProcess("node", ["-e", "process.stdout.write('x'.repeat(2048))"], { maxBufferBytes: 128 }),
    ).rejects.toThrow("exceeded stdout buffer limit");
  });

  it("truncates output when outputMode is truncate", async () => {
    const result = await runProcess("node", ["-e", "process.stdout.write('x'.repeat(2048))"], {
      maxBufferBytes: 128,
      outputMode: "truncate",
    });

    expect(result.code).toBe(0);
    expect(result.stdout.length).toBeLessThanOrEqual(128);
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stderrTruncated).toBe(false);
  });

  it("runs sync commands through the shared spawn strategy", () => {
    const result = spawnProcessSync("node", ["-e", "process.stdout.write('ok')"], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("ok");
  });

  it("spawns detached commands through the shared spawn strategy", async () => {
    await expect(
      spawnDetachedProcess(process.execPath, ["-e", "process.exit(0)"]),
    ).resolves.toBeUndefined();
  });
});

describe("resolveProcessLaunchPlan", () => {
  it("resolves native windows executables without using a shell", () => {
    withTempDir((dir) => {
      fs.writeFileSync(path.join(dir, "git.EXE"), "MZ");
      const plan = resolveProcessLaunchPlan("git", ["status"], {
        env: {
          PATH: dir,
          PATHEXT: ".COM;.EXE;.BAT;.CMD",
        },
        inheritParentEnv: false,
        runtimeEnvironment: {
          platform: "windows",
          pathStyle: "windows",
          isWsl: false,
          windowsInteropMode: "windows-native",
          wslDistroName: null,
        },
      });

      expect(plan.command).toBe(path.join(dir, "git.EXE"));
      expect(plan.args).toEqual(["status"]);
      expect(plan.shell).toBe(false);
    });
  });

  it("wraps windows batch launchers through cmd.exe without default shell mode", () => {
    withTempDir((dir) => {
      const wrapperPath = path.join(dir, "code.CMD");
      fs.writeFileSync(wrapperPath, "@echo off\r\n");
      const plan = resolveProcessLaunchPlan("code", ["C:\\repo\\a&b.ts"], {
        env: {
          PATH: dir,
          PATHEXT: ".COM;.EXE;.BAT;.CMD",
          COMSPEC: "C:\\Windows\\System32\\cmd.exe",
        },
        inheritParentEnv: false,
        runtimeEnvironment: {
          platform: "windows",
          pathStyle: "windows",
          isWsl: false,
          windowsInteropMode: "windows-native",
          wslDistroName: null,
        },
      });

      expect(plan.command).toBe(wrapperPath);
      expect(plan.args).toEqual(["C:\\repo\\a&b.ts"]);
      expect(plan.shell).toBe("C:\\Windows\\System32\\cmd.exe");
    });
  });

  it("resolves relative batch launchers against the configured cwd", () => {
    withTempDir((dir) => {
      const wrapperPath = path.join(dir, "code.CMD");
      fs.writeFileSync(wrapperPath, "@echo off\r\n");

      const plan = resolveProcessLaunchPlan("./code", ["pkg@^1.0"], {
        cwd: dir,
        env: {
          PATHEXT: ".COM;.EXE;.BAT;.CMD",
          COMSPEC: "C:\\Windows\\System32\\cmd.exe",
        },
        inheritParentEnv: false,
        runtimeEnvironment: {
          platform: "windows",
          pathStyle: "windows",
          isWsl: false,
          windowsInteropMode: "windows-native",
          wslDistroName: null,
        },
      });

      expect(plan.command).toBe(wrapperPath);
      expect(plan.args).toEqual(["pkg@^1.0"]);
      expect(plan.shell).toBe("C:\\Windows\\System32\\cmd.exe");
    });
  });

  it("preserves spaced batch launcher paths on windows", () => {
    withTempDir((rootDir) => {
      const dir = path.join(rootDir, "runner admin");
      fs.mkdirSync(dir);
      const wrapperPath = path.join(dir, "code.CMD");
      fs.writeFileSync(wrapperPath, "@echo off\r\n");

      const plan = resolveProcessLaunchPlan("code", ["--status"], {
        env: {
          PATH: dir,
          PATHEXT: ".COM;.EXE;.BAT;.CMD",
          COMSPEC: "C:\\Windows\\System32\\cmd.exe",
        },
        inheritParentEnv: false,
        runtimeEnvironment: {
          platform: "windows",
          pathStyle: "windows",
          isWsl: false,
          windowsInteropMode: "windows-native",
          wslDistroName: null,
        },
      });

      expect(plan.command).toBe(wrapperPath);
      expect(plan.args).toEqual(["--status"]);
      expect(plan.shell).toBe("C:\\Windows\\System32\\cmd.exe");
    });
  });

  it("keeps wsl-hosted commands on the linux direct exec path", () => {
    const plan = resolveProcessLaunchPlan("code", ["/home/julius/repo"], {
      runtimeEnvironment: {
        platform: "linux",
        pathStyle: "posix",
        isWsl: true,
        windowsInteropMode: "wsl-hosted",
        wslDistroName: "Ubuntu",
      },
    });

    expect(plan.command).toBe("code");
    expect(plan.args).toEqual(["/home/julius/repo"]);
    expect(plan.shell).toBe(false);
  });

  it("preserves explicit shell configuration", () => {
    const plan = resolveProcessLaunchPlan("git", ["status"], {
      shell: true,
      runtimeEnvironment: {
        platform: "windows",
        pathStyle: "windows",
        isWsl: false,
        windowsInteropMode: "windows-native",
        wslDistroName: null,
      },
    });

    expect(plan.command).toBe("git");
    expect(plan.args).toEqual(["status"]);
    expect(plan.shell).toBe(true);
  });
});

describe("makeRuntimeCommand", () => {
  it("uses the shared launch plan for batch commands on windows", () => {
    withTempDir((dir) => {
      const wrapperPath = path.join(dir, "code.CMD");
      fs.writeFileSync(wrapperPath, "@echo off\r\n");

      const command = makeRuntimeCommand("code", ["C:\\repo\\a&b.ts"], {
        env: {
          PATH: dir,
          PATHEXT: ".COM;.EXE;.BAT;.CMD",
          COMSPEC: "C:\\Windows\\System32\\cmd.exe",
        },
        extendEnv: false,
        runtimeEnvironment: {
          platform: "windows",
          pathStyle: "windows",
          isWsl: false,
          windowsInteropMode: "windows-native",
          wslDistroName: null,
        },
      });

      expect(command.command).toBe(wrapperPath);
      expect(command.args).toEqual(["C:\\repo\\a&b.ts"]);
      expect(command.options.shell).toBe("C:\\Windows\\System32\\cmd.exe");
    });
  });
});
