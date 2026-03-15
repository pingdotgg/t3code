import { describe, expect, it, vi } from "vitest";

import {
  defaultShellCandidates,
  extractPathFromShellOutput,
  readPathFromLoginShell,
  resolvePathFromLoginShells,
  shouldRepairPath,
} from "./shell";

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
    >(() => "__T3CODE_PATH_START__\n/a:/b\n__T3CODE_PATH_END__\n");

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
    expect(args?.[1]).toContain("printenv PATH");
    expect(args?.[1]).toContain("__T3CODE_PATH_START__");
    expect(args?.[1]).toContain("__T3CODE_PATH_END__");
    expect(options).toEqual({ encoding: "utf8", timeout: 750 });
  });

  it("falls back to non-interactive login mode when interactive login fails", () => {
    const execFile = vi.fn<
      (
        file: string,
        args: ReadonlyArray<string>,
        options: { encoding: "utf8"; timeout: number },
      ) => string
    >((_, args) => {
      if (args[0] === "-ilc") {
        throw new Error("interactive login unsupported");
      }
      return "__T3CODE_PATH_START__\n/a:/b\n__T3CODE_PATH_END__\n";
    });

    expect(readPathFromLoginShell("/bin/sh", execFile)).toBe("/a:/b");
    expect(execFile).toHaveBeenCalledTimes(2);
    expect(execFile.mock.calls[0]?.[1]?.[0]).toBe("-ilc");
    expect(execFile.mock.calls[1]?.[1]?.[0]).toBe("-lc");
  });
});

describe("resolvePathFromLoginShells", () => {
  it("returns the first resolved PATH from the provided shells", () => {
    const execFile = vi.fn<
      (
        file: string,
        args: ReadonlyArray<string>,
        options: { encoding: "utf8"; timeout: number },
      ) => string
    >((file) => {
      if (file === "/bin/zsh") {
        throw new Error("zsh unavailable");
      }
      return "__T3CODE_PATH_START__\n/a:/b\n__T3CODE_PATH_END__\n";
    });

    const onError = vi.fn<(shell: string, error: unknown) => void>();
    const result = resolvePathFromLoginShells(["/bin/zsh", "/bin/bash"], execFile, onError);
    expect(result).toBe("/a:/b");
    expect(execFile).toHaveBeenCalledTimes(3);
    expect(onError).toHaveBeenCalledTimes(2);
    expect(onError.mock.calls.map(([shell]) => shell)).toEqual(["/bin/zsh", "/bin/zsh"]);
  });

  it("returns undefined when all shells fail to resolve PATH", () => {
    const execFile = vi.fn<
      (
        file: string,
        args: ReadonlyArray<string>,
        options: { encoding: "utf8"; timeout: number },
      ) => string
    >(() => {
      throw new Error("no shells available");
    });

    const result = resolvePathFromLoginShells(["/bin/zsh", "/bin/bash"], execFile);
    expect(result).toBeUndefined();
    expect(execFile).toHaveBeenCalledTimes(4);
  });
});

describe("defaultShellCandidates", () => {
  it("limits Linux candidates to the configured shell and POSIX fallback", () => {
    const originalShell = process.env.SHELL;
    process.env.SHELL = "/bin/bash";

    try {
      expect(defaultShellCandidates("linux")).toEqual(["/bin/bash", "/bin/sh"]);
    } finally {
      process.env.SHELL = originalShell;
    }
  });

  it("limits macOS candidates to a small bounded fallback set", () => {
    const originalShell = process.env.SHELL;
    process.env.SHELL = "/opt/homebrew/bin/fish";

    try {
      expect(defaultShellCandidates("darwin")).toEqual([
        "/opt/homebrew/bin/fish",
        "/bin/zsh",
        "/bin/bash",
      ]);
    } finally {
      process.env.SHELL = originalShell;
    }
  });
});

describe("shouldRepairPath", () => {
  it("skips repair when macOS already has a likely interactive PATH", () => {
    expect(shouldRepairPath("darwin", "/usr/bin:/bin:/opt/homebrew/bin")).toBe(false);
  });

  it("requires repair when Linux is missing common user PATH entries", () => {
    expect(shouldRepairPath("linux", "/usr/bin:/bin", "/home/tester")).toBe(true);
  });

  it("skips repair when Linux already exposes ~/.local/bin", () => {
    expect(shouldRepairPath("linux", "/home/tester/.local/bin:/usr/bin", "/home/tester")).toBe(
      false,
    );
  });
});
