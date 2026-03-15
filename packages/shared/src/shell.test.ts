import { describe, expect, it, vi } from "vitest";

import {
  extractPathFromShellOutput,
  readPathForDesktopRuntime,
  readPathFromLoginShell,
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
    expect(options).toEqual({ encoding: "utf8", timeout: 5000 });
  });
});

describe("readPathForDesktopRuntime", () => {
  it("hydrates PATH using the Linux fallback shell when SHELL is missing", () => {
    const execFile = vi.fn<
      (
        file: string,
        args: ReadonlyArray<string>,
        options: { encoding: "utf8"; timeout: number },
      ) => string
    >(() => "__T3CODE_PATH_START__\n/a:/b\n__T3CODE_PATH_END__\n");

    expect(readPathForDesktopRuntime("linux", undefined, execFile)).toBe("/a:/b");
    expect(execFile).toHaveBeenCalledWith("/bin/bash", expect.any(Array), {
      encoding: "utf8",
      timeout: 5000,
    });
  });

  it("skips PATH hydration on unsupported platforms", () => {
    const execFile = vi.fn();

    expect(readPathForDesktopRuntime("win32", undefined, execFile)).toBeUndefined();
    expect(execFile).not.toHaveBeenCalled();
  });

  it("prefers the configured shell when present", () => {
    const execFile = vi.fn<
      (
        file: string,
        args: ReadonlyArray<string>,
        options: { encoding: "utf8"; timeout: number },
      ) => string
    >(() => "__T3CODE_PATH_START__\n/a:/b\n__T3CODE_PATH_END__\n");

    expect(readPathForDesktopRuntime("linux", "/usr/bin/fish", execFile)).toBe("/a:/b");
    expect(execFile).toHaveBeenCalledWith("/usr/bin/fish", expect.any(Array), {
      encoding: "utf8",
      timeout: 5000,
    });
  });
});
