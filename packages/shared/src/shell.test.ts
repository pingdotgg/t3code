import { describe, expect, it, vi } from "vitest";

import {
  extractPathFromShellOutput,
  isCommandAvailable,
  listLoginShellCandidates,
  mergePathEntries,
  mergePathValues,
  readEnvironmentFromLoginShell,
  readEnvironmentFromWindowsShell,
  readPathFromLaunchctl,
  readPathFromLoginShell,
  resolveCommandPath,
  resolveKnownWindowsCliDirs,
  resolveWindowsEnvironment,
} from "./shell.ts";

describe("extractPathFromShellOutput", () => {
  it("extracts the path between capture markers", () => {
    expect(
      extractPathFromShellOutput(
        "__T3CODE_PATH_START__\n/opt/homebrew/bin:/usr/bin\n__T3CODE_PATH_END__\n",
      ),
    ).toBe("/opt/homebrew/bin:/usr/bin");
  });

  it("ignores shell startup noise around the capture markers", () => {
    expect(
      extractPathFromShellOutput(
        "Welcome to fish\n__T3CODE_PATH_START__\n/opt/homebrew/bin:/usr/bin\n__T3CODE_PATH_END__\nBye\n",
      ),
    ).toBe("/opt/homebrew/bin:/usr/bin");
  });

  it("returns null when the markers are missing", () => {
    expect(extractPathFromShellOutput("/opt/homebrew/bin /usr/bin")).toBeNull();
  });
});

describe("readPathFromLoginShell", () => {
  it("uses a shell-agnostic printenv PATH probe", () => {
    const execFile = vi.fn<
      (
        file: string,
        args: ReadonlyArray<string>,
        options: { encoding: "utf8"; timeout: number },
      ) => string
    >(() => "__T3CODE_ENV_PATH_START__\n/a:/b\n__T3CODE_ENV_PATH_END__\n");

    expect(readPathFromLoginShell("/opt/homebrew/bin/fish", execFile)).toBe("/a:/b");
    expect(execFile).toHaveBeenCalledTimes(1);

    const firstCall = execFile.mock.calls[0] as
      | [string, ReadonlyArray<string>, { encoding: "utf8"; timeout: number }]
      | undefined;
    expect(firstCall).toBeDefined();
    if (!firstCall) {
      throw new Error("Expected execFile to be called");
    }

    const [shell, args, options] = firstCall;
    expect(shell).toBe("/opt/homebrew/bin/fish");
    expect(args).toHaveLength(2);
    expect(args?.[0]).toBe("-ilc");
    expect(args?.[1]).toContain("printenv PATH || true");
    expect(args?.[1]).toContain("__T3CODE_ENV_PATH_START__");
    expect(args?.[1]).toContain("__T3CODE_ENV_PATH_END__");
    expect(options).toEqual({ encoding: "utf8", timeout: 5000 });
  });
});

describe("readPathFromLaunchctl", () => {
  it("returns a trimmed PATH value from launchctl", () => {
    const execFile = vi.fn<
      (
        file: string,
        args: ReadonlyArray<string>,
        options: { encoding: "utf8"; timeout: number },
      ) => string
    >(() => "  /opt/homebrew/bin:/usr/bin  \n");

    expect(readPathFromLaunchctl(execFile)).toBe("/opt/homebrew/bin:/usr/bin");
    expect(execFile).toHaveBeenCalledWith("/bin/launchctl", ["getenv", "PATH"], {
      encoding: "utf8",
      timeout: 2000,
    });
  });

  it("returns undefined when launchctl is unavailable", () => {
    const execFile = vi.fn<
      (
        file: string,
        args: ReadonlyArray<string>,
        options: { encoding: "utf8"; timeout: number },
      ) => string
    >(() => {
      throw new Error("spawn /bin/launchctl ENOENT");
    });

    expect(readPathFromLaunchctl(execFile)).toBeUndefined();
  });
});

describe("readEnvironmentFromLoginShell", () => {
  it("extracts multiple environment variables from a login shell command", () => {
    const execFile = vi.fn<
      (
        file: string,
        args: ReadonlyArray<string>,
        options: { encoding: "utf8"; timeout: number },
      ) => string
    >(() =>
      [
        "__T3CODE_ENV_PATH_START__",
        "/a:/b",
        "__T3CODE_ENV_PATH_END__",
        "__T3CODE_ENV_SSH_AUTH_SOCK_START__",
        "/tmp/secretive.sock",
        "__T3CODE_ENV_SSH_AUTH_SOCK_END__",
      ].join("\n"),
    );

    expect(readEnvironmentFromLoginShell("/bin/zsh", ["PATH", "SSH_AUTH_SOCK"], execFile)).toEqual({
      PATH: "/a:/b",
      SSH_AUTH_SOCK: "/tmp/secretive.sock",
    });
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it("omits environment variables that are missing or empty", () => {
    const execFile = vi.fn<
      (
        file: string,
        args: ReadonlyArray<string>,
        options: { encoding: "utf8"; timeout: number },
      ) => string
    >(() =>
      [
        "__T3CODE_ENV_PATH_START__",
        "/a:/b",
        "__T3CODE_ENV_PATH_END__",
        "__T3CODE_ENV_SSH_AUTH_SOCK_START__",
        "__T3CODE_ENV_SSH_AUTH_SOCK_END__",
      ].join("\n"),
    );

    expect(readEnvironmentFromLoginShell("/bin/zsh", ["PATH", "SSH_AUTH_SOCK"], execFile)).toEqual({
      PATH: "/a:/b",
    });
  });

  it("preserves surrounding whitespace in captured values", () => {
    const execFile = vi.fn<
      (
        file: string,
        args: ReadonlyArray<string>,
        options: { encoding: "utf8"; timeout: number },
      ) => string
    >(() =>
      ["__T3CODE_ENV_CUSTOM_VAR_START__", "  padded value  ", "__T3CODE_ENV_CUSTOM_VAR_END__"].join(
        "\n",
      ),
    );

    expect(readEnvironmentFromLoginShell("/bin/zsh", ["CUSTOM_VAR"], execFile)).toEqual({
      CUSTOM_VAR: "  padded value  ",
    });
  });
});

describe("listLoginShellCandidates", () => {
  it("returns env shell, user shell, then the platform fallback without duplicates", () => {
    expect(listLoginShellCandidates("darwin", " /opt/homebrew/bin/nu ", "/bin/zsh")).toEqual([
      "/opt/homebrew/bin/nu",
      "/bin/zsh",
    ]);
  });

  it("falls back to the platform default when no shells are available", () => {
    expect(listLoginShellCandidates("linux", undefined, "")).toEqual(["/bin/bash"]);
  });
});

describe("mergePathEntries", () => {
  it("prefers login-shell PATH entries and keeps inherited extras", () => {
    expect(
      mergePathEntries("/opt/homebrew/bin:/usr/bin", "/Users/test/.local/bin:/usr/bin", "darwin"),
    ).toBe("/opt/homebrew/bin:/usr/bin:/Users/test/.local/bin");
  });

  it("uses the platform-specific delimiter", () => {
    expect(mergePathEntries("C:\\Tools;C:\\Windows", "C:\\Windows;C:\\Git", "win32")).toBe(
      "C:\\Tools;C:\\Windows;C:\\Git",
    );
  });
});

describe("readEnvironmentFromWindowsShell", () => {
  it("extracts environment variables from a PowerShell command", () => {
    const execFile = vi.fn<
      (
        file: string,
        args: ReadonlyArray<string>,
        options: { encoding: "utf8"; timeout: number },
      ) => string
    >(
      () =>
        "__T3CODE_ENV_PATH_START__\nC:\\Users\\testuser\\AppData\\Roaming\\npm\n__T3CODE_ENV_PATH_END__\n",
    );

    expect(readEnvironmentFromWindowsShell(["PATH"], execFile)).toEqual({
      PATH: "C:\\Users\\testuser\\AppData\\Roaming\\npm",
    });
    expect(execFile).toHaveBeenCalledWith(
      "pwsh.exe",
      expect.arrayContaining(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]),
      { encoding: "utf8", timeout: 5000 },
    );
  });

  it("strips CRLF delimiters from captured PowerShell values", () => {
    const execFile = vi.fn<
      (
        file: string,
        args: ReadonlyArray<string>,
        options: { encoding: "utf8"; timeout: number },
      ) => string
    >(
      () =>
        "__T3CODE_ENV_FNM_DIR_START__\r\nC:\\Users\\testuser\\AppData\\Roaming\\fnm\r\n__T3CODE_ENV_FNM_DIR_END__\r\n",
    );

    expect(readEnvironmentFromWindowsShell(["FNM_DIR"], execFile)).toEqual({
      FNM_DIR: "C:\\Users\\testuser\\AppData\\Roaming\\fnm",
    });
  });

  it("omits -NoProfile when loadProfile is enabled", () => {
    const execFile = vi.fn<
      (
        file: string,
        args: ReadonlyArray<string>,
        options: { encoding: "utf8"; timeout: number },
      ) => string
    >(() => "__T3CODE_ENV_PATH_START__\nC:\\Tools\n__T3CODE_ENV_PATH_END__\n");

    expect(readEnvironmentFromWindowsShell(["PATH"], { loadProfile: true }, execFile)).toEqual({
      PATH: "C:\\Tools",
    });
    expect(execFile).toHaveBeenCalledWith(
      "pwsh.exe",
      expect.arrayContaining(["-NoLogo", "-NonInteractive", "-Command"]),
      { encoding: "utf8", timeout: 5000 },
    );
    expect(execFile.mock.calls[0]?.[1]).not.toContain("-NoProfile");
  });

  it("falls back to Windows PowerShell when pwsh.exe is unavailable", () => {
    const execFile = vi.fn<
      (
        file: string,
        args: ReadonlyArray<string>,
        options: { encoding: "utf8"; timeout: number },
      ) => string
    >((file) => {
      if (file === "pwsh.exe") {
        throw new Error("spawn pwsh.exe ENOENT");
      }
      return "__T3CODE_ENV_PATH_START__\nC:\\Tools\n__T3CODE_ENV_PATH_END__\n";
    });

    expect(readEnvironmentFromWindowsShell(["PATH"], execFile)).toEqual({
      PATH: "C:\\Tools",
    });
    expect(execFile).toHaveBeenNthCalledWith(1, "pwsh.exe", expect.any(Array), {
      encoding: "utf8",
      timeout: 5000,
    });
    expect(execFile).toHaveBeenNthCalledWith(2, "powershell.exe", expect.any(Array), {
      encoding: "utf8",
      timeout: 5000,
    });
  });
});

describe("mergePathValues", () => {
  it("dedupes case-insensitively on Windows while preserving preferred order", () => {
    expect(
      mergePathValues(
        'C:\\Users\\testuser\\AppData\\Roaming\\npm;"C:\\Program Files\\nodejs"',
        "c:\\users\\testuser\\appdata\\roaming\\npm;C:\\Windows\\System32",
        "win32",
      ),
    ).toBe(
      'C:\\Users\\testuser\\AppData\\Roaming\\npm;"C:\\Program Files\\nodejs";C:\\Windows\\System32',
    );
  });

  it("dedupes case-sensitively on POSIX", () => {
    expect(mergePathValues("/usr/local/bin:/usr/bin", "/usr/bin:/USR/BIN", "linux")).toBe(
      "/usr/local/bin:/usr/bin:/USR/BIN",
    );
  });
});

describe("resolveKnownWindowsCliDirs", () => {
  it("returns known Windows CLI install directories in priority order", () => {
    expect(
      resolveKnownWindowsCliDirs({
        APPDATA: "C:\\Users\\testuser\\AppData\\Roaming",
        LOCALAPPDATA: "C:\\Users\\testuser\\AppData\\Local",
        USERPROFILE: "C:\\Users\\testuser",
      }),
    ).toEqual([
      "C:\\Users\\testuser\\AppData\\Roaming\\npm",
      "C:\\Users\\testuser\\AppData\\Local\\Programs\\nodejs",
      "C:\\Users\\testuser\\AppData\\Local\\Volta\\bin",
      "C:\\Users\\testuser\\AppData\\Local\\pnpm",
      "C:\\Users\\testuser\\.bun\\bin",
      "C:\\Users\\testuser\\scoop\\shims",
    ]);
  });
});

describe("isCommandAvailable", () => {
  it("returns false when PATH is empty", () => {
    expect(
      isCommandAvailable("definitely-not-installed", {
        platform: "win32",
        env: { PATH: "", PATHEXT: ".COM;.EXE;.BAT;.CMD" },
      }),
    ).toBe(false);
  });
});

describe("resolveCommandPath", () => {
  it("returns the first executable resolved from PATH", () => {
    expect(
      resolveCommandPath("definitely-not-installed", {
        platform: "win32",
        env: { PATH: "", PATHEXT: ".COM;.EXE;.BAT;.CMD" },
      }),
    ).toBeNull();
  });
});

describe("resolveWindowsEnvironment", () => {
  it("returns the baseline no-profile PATH patch when node is already available", () => {
    const readEnvironment = vi.fn(
      (_names: ReadonlyArray<string>, options?: { loadProfile?: boolean }) =>
        options?.loadProfile
          ? { PATH: "C:\\Profile\\Bin" }
          : { PATH: "C:\\Shell\\Bin;C:\\Windows\\System32" },
    );
    const commandAvailable = vi.fn(() => true);

    expect(
      resolveWindowsEnvironment(
        {
          PATH: "C:\\Windows\\System32",
          APPDATA: "C:\\Users\\testuser\\AppData\\Roaming",
          LOCALAPPDATA: "C:\\Users\\testuser\\AppData\\Local",
          USERPROFILE: "C:\\Users\\testuser",
        },
        {
          readEnvironment,
          commandAvailable,
        },
      ),
    ).toEqual({
      PATH: [
        "C:\\Users\\testuser\\AppData\\Roaming\\npm",
        "C:\\Users\\testuser\\AppData\\Local\\Programs\\nodejs",
        "C:\\Users\\testuser\\AppData\\Local\\Volta\\bin",
        "C:\\Users\\testuser\\AppData\\Local\\pnpm",
        "C:\\Users\\testuser\\.bun\\bin",
        "C:\\Users\\testuser\\scoop\\shims",
        "C:\\Shell\\Bin",
        "C:\\Windows\\System32",
      ].join(";"),
    });
    expect(readEnvironment).toHaveBeenCalledTimes(1);
    expect(readEnvironment).toHaveBeenCalledWith(["PATH"], { loadProfile: false });
    expect(commandAvailable).toHaveBeenCalledWith(
      "node",
      expect.objectContaining({
        platform: "win32",
      }),
    );
  });

  it("loads the PowerShell profile when baseline env cannot resolve node", () => {
    const readEnvironment = vi.fn(
      (_names: ReadonlyArray<string>, options?: { loadProfile?: boolean }) =>
        options?.loadProfile
          ? {
              PATH: "C:\\Profile\\Node;C:\\Windows\\System32",
              FNM_DIR: "C:\\Users\\testuser\\AppData\\Roaming\\fnm",
              FNM_MULTISHELL_PATH: "C:\\Users\\testuser\\AppData\\Local\\fnm_multishells\\123",
            }
          : { PATH: "C:\\Shell\\Bin;C:\\Windows\\System32" },
    );
    const commandAvailable = vi.fn(() => false);

    expect(
      resolveWindowsEnvironment(
        {
          PATH: "C:\\Windows\\System32",
          APPDATA: "C:\\Users\\testuser\\AppData\\Roaming",
          LOCALAPPDATA: "C:\\Users\\testuser\\AppData\\Local",
          USERPROFILE: "C:\\Users\\testuser",
        },
        {
          readEnvironment,
          commandAvailable,
        },
      ),
    ).toEqual({
      PATH: [
        "C:\\Profile\\Node",
        "C:\\Windows\\System32",
        "C:\\Users\\testuser\\AppData\\Roaming\\npm",
        "C:\\Users\\testuser\\AppData\\Local\\Programs\\nodejs",
        "C:\\Users\\testuser\\AppData\\Local\\Volta\\bin",
        "C:\\Users\\testuser\\AppData\\Local\\pnpm",
        "C:\\Users\\testuser\\.bun\\bin",
        "C:\\Users\\testuser\\scoop\\shims",
        "C:\\Shell\\Bin",
      ].join(";"),
      FNM_DIR: "C:\\Users\\testuser\\AppData\\Roaming\\fnm",
      FNM_MULTISHELL_PATH: "C:\\Users\\testuser\\AppData\\Local\\fnm_multishells\\123",
    });
    expect(readEnvironment).toHaveBeenNthCalledWith(1, ["PATH"], { loadProfile: false });
    expect(readEnvironment).toHaveBeenNthCalledWith(2, ["PATH", "FNM_DIR", "FNM_MULTISHELL_PATH"], {
      loadProfile: true,
    });
    expect(commandAvailable).toHaveBeenCalledTimes(1);
  });

  it("keeps the baseline env when profiled probe still does not resolve node", () => {
    const readEnvironment = vi.fn(
      (_names: ReadonlyArray<string>, options?: { loadProfile?: boolean }) =>
        options?.loadProfile ? { FNM_DIR: "C:\\Users\\testuser\\AppData\\Roaming\\fnm" } : {},
    );
    const commandAvailable = vi.fn(() => false);

    expect(
      resolveWindowsEnvironment(
        {
          PATH: "C:\\Windows\\System32",
          APPDATA: "C:\\Users\\testuser\\AppData\\Roaming",
          USERPROFILE: "C:\\Users\\testuser",
        },
        {
          readEnvironment,
          commandAvailable,
        },
      ),
    ).toEqual({
      PATH: [
        "C:\\Users\\testuser\\AppData\\Roaming\\npm",
        "C:\\Users\\testuser\\.bun\\bin",
        "C:\\Users\\testuser\\scoop\\shims",
        "C:\\Windows\\System32",
      ].join(";"),
      FNM_DIR: "C:\\Users\\testuser\\AppData\\Roaming\\fnm",
    });
    expect(commandAvailable).toHaveBeenCalledTimes(1);
  });
});
