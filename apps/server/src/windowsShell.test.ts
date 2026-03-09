import { describe, expect, it } from "vitest";

import { isWindowsUncPath, resolveShellCommand } from "./windowsShell";

describe("isWindowsUncPath", () => {
  it("detects UNC paths on Windows", () => {
    expect(isWindowsUncPath("\\\\wsl.localhost\\Ubuntu\\home\\user\\repo", "win32")).toBe(true);
  });

  it("ignores drive-letter paths on Windows", () => {
    expect(isWindowsUncPath("C:\\Users\\user\\repo", "win32")).toBe(false);
  });

  it("ignores UNC-looking paths on non-Windows platforms", () => {
    expect(isWindowsUncPath("\\\\wsl.localhost\\Ubuntu\\home\\user\\repo", "linux")).toBe(false);
  });

  it("ignores Windows verbatim paths on Windows", () => {
    expect(isWindowsUncPath("\\\\?\\C:\\Users\\user\\repo", "win32")).toBe(false);
  });
});

describe("resolveShellCommand", () => {
  it("keeps the normal Windows shell path for drive-letter cwd values", () => {
    expect(
      resolveShellCommand("codex", ["app-server"], {
        cwd: "C:\\Users\\user\\repo",
        platform: "win32",
      }),
    ).toEqual({
      command: "codex",
      args: ["app-server"],
      cwd: "C:\\Users\\user\\repo",
      shell: true,
    });
  });

  it("wraps UNC cwd values through cmd pushd on Windows", () => {
    expect(
      resolveShellCommand("codex", ["app-server"], {
        cwd: "\\\\wsl.localhost\\Ubuntu\\home\\user\\repo",
        platform: "win32",
      }),
    ).toEqual({
      command: "cmd.exe",
      args: [
        "/d",
        "/c",
        'pushd %__T3CODE_WINDOWS_UNC_CWD% && %__T3CODE_WINDOWS_UNC_COMMAND% %__T3CODE_WINDOWS_UNC_ARG_0%',
      ],
      cwd: undefined,
      env: {
        __T3CODE_WINDOWS_UNC_COMMAND: '"codex"',
        __T3CODE_WINDOWS_UNC_CWD: '"\\\\wsl.localhost\\Ubuntu\\home\\user\\repo"',
        __T3CODE_WINDOWS_UNC_ARG_0: '"app-server"',
      },
      shell: false,
    });
  });

  it("quotes command paths with spaces for UNC cwd values", () => {
    expect(
      resolveShellCommand("C:\\Users\\user\\AppData\\Roaming\\npm\\codex.cmd", ["--version"], {
        cwd: "\\\\wsl.localhost\\Ubuntu\\home\\user\\repo",
        platform: "win32",
      }),
    ).toEqual({
      command: "cmd.exe",
      args: [
        "/d",
        "/c",
        "pushd %__T3CODE_WINDOWS_UNC_CWD% && call %__T3CODE_WINDOWS_UNC_COMMAND% %__T3CODE_WINDOWS_UNC_ARG_0%",
      ],
      cwd: undefined,
      env: {
        __T3CODE_WINDOWS_UNC_COMMAND: '"C:\\Users\\user\\AppData\\Roaming\\npm\\codex.cmd"',
        __T3CODE_WINDOWS_UNC_CWD: '"\\\\wsl.localhost\\Ubuntu\\home\\user\\repo"',
        __T3CODE_WINDOWS_UNC_ARG_0: '"--version"',
      },
      shell: false,
    });
  });
});
