import { afterEach, describe, expect, it, vi } from "vitest";

import { COMMON_MACOS_PATHS, ensureCommonMacPaths, extractPathFromShellOutput, readPathFromLoginShell } from "./shell";

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

describe("ensureCommonMacPaths", () => {
  const originalPlatform = process.platform;
  const originalPath = process.env.PATH;

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
    process.env.PATH = originalPath;
  });

  it("appends missing Homebrew paths on darwin", () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    process.env.PATH = "/usr/bin:/bin";

    ensureCommonMacPaths();

    const dirs = process.env.PATH!.split(":");
    for (const p of COMMON_MACOS_PATHS) {
      expect(dirs).toContain(p);
    }
    // Original paths are still present at the start
    expect(dirs[0]).toBe("/usr/bin");
    expect(dirs[1]).toBe("/bin");
  });

  it("does not duplicate paths already present", () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    process.env.PATH = `/usr/bin:/bin:${COMMON_MACOS_PATHS.join(":")}`;

    ensureCommonMacPaths();

    const dirs = process.env.PATH!.split(":");
    for (const p of COMMON_MACOS_PATHS) {
      expect(dirs.filter((d) => d === p)).toHaveLength(1);
    }
  });

  it("handles empty PATH", () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    process.env.PATH = "";

    ensureCommonMacPaths();

    const dirs = process.env.PATH!.split(":");
    for (const p of COMMON_MACOS_PATHS) {
      expect(dirs).toContain(p);
    }
  });

  it("is a no-op on non-darwin platforms", () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    process.env.PATH = "/usr/bin:/bin";

    ensureCommonMacPaths();

    expect(process.env.PATH).toBe("/usr/bin:/bin");
  });
});
