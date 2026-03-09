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
        "/v:on",
        "/s",
        "/c",
        'pushd "\\\\wsl.localhost\\Ubuntu\\home\\user\\repo" && ("codex" "app-server" & set "T3CODE_EXIT_CODE=!ERRORLEVEL!" & popd & exit /b !T3CODE_EXIT_CODE!)',
      ],
      cwd: undefined,
      shell: false,
    });
  });
});
