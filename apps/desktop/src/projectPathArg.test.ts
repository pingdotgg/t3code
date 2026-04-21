import { describe, expect, it } from "vitest";

import { parseFolderFromArgv } from "./projectPathArg.ts";

function resolvingProjectParentRealpath(input: string): string {
  return input === "/tmp/project-parent/child/.." ? "/tmp/project-parent" : input;
}

function failingMissingPathRealpath(input: string): string {
  if (input === "/does/not/exist") throw new Error("ENOENT");
  return input;
}

describe("parseFolderFromArgv", () => {
  const electronBinary = "/Applications/T3 Code.app";
  const electronRuntimeBinary = "/Applications/Electron.app/Contents/MacOS/Electron";
  const appEntry = "/repo/apps/desktop/dist-electron/main.cjs";
  const knownDirectories = new Set([
    "/tmp/project-sample",
    "/tmp/project-other",
    "/tmp/project-parent/child",
    "/tmp/project-parent",
  ]);
  const options = {
    realpath: (input: string) => input,
    isDirectory: (candidate: string) => knownDirectories.has(candidate),
  };

  it("returns null for empty argv", () => {
    expect(parseFolderFromArgv([], options)).toBeNull();
  });

  it("picks up a bare positional directory after the electron binary", () => {
    const knownWithElectronBinary = new Set([...knownDirectories, electronBinary]);
    expect(
      parseFolderFromArgv([electronBinary, "/tmp/project-sample"], {
        realpath: (input: string) => input,
        isDirectory: (candidate: string) => knownWithElectronBinary.has(candidate),
        skipLeadingPositionalArgs: 1,
      }),
    ).toBe("/tmp/project-sample");
  });

  it("skips the Electron binary and app entry for unpackaged launches", () => {
    const knownWithElectronEntries = new Set([
      ...knownDirectories,
      electronRuntimeBinary,
      appEntry,
    ]);
    expect(
      parseFolderFromArgv([electronRuntimeBinary, appEntry, "/tmp/project-sample"], {
        realpath: (input: string) => input,
        isDirectory: (candidate: string) => knownWithElectronEntries.has(candidate),
        skipLeadingPositionalArgs: 2,
      }),
    ).toBe("/tmp/project-sample");
  });

  it("does not count switches as leading positional args to skip", () => {
    const knownWithElectronEntries = new Set([
      ...knownDirectories,
      electronRuntimeBinary,
      appEntry,
    ]);
    expect(
      parseFolderFromArgv(
        [electronRuntimeBinary, "--allow-file-access-from-files", appEntry, "/tmp/project-sample"],
        {
          realpath: (input: string) => input,
          isDirectory: (candidate: string) => knownWithElectronEntries.has(candidate),
          skipLeadingPositionalArgs: 2,
        },
      ),
    ).toBe("/tmp/project-sample");
  });

  it("skips Chromium switches that would otherwise land before the path", () => {
    expect(
      parseFolderFromArgv(
        [electronBinary, "--allow-file-access-from-files", "/tmp/project-sample"],
        { ...options, skipLeadingPositionalArgs: 1 },
      ),
    ).toBe("/tmp/project-sample");
  });

  it("prefers the --t3-project-path= atomic form over any positional", () => {
    expect(
      parseFolderFromArgv(
        [electronBinary, "/tmp/project-other", "--t3-project-path=/tmp/project-sample"],
        options,
      ),
    ).toBe("/tmp/project-sample");
  });

  it("ignores --t3-project-path= with an empty value and falls back to positional", () => {
    expect(
      parseFolderFromArgv([electronBinary, "--t3-project-path=", "/tmp/project-sample"], options),
    ).toBe("/tmp/project-sample");
  });

  it("resolves `..` via realpath before checking isDirectory", () => {
    expect(
      parseFolderFromArgv([electronBinary, "/tmp/project-parent/child/.."], {
        ...options,
        realpath: resolvingProjectParentRealpath,
      }),
    ).toBe("/tmp/project-parent");
  });

  it("skips tokens whose realpath throws (non-existent paths)", () => {
    expect(
      parseFolderFromArgv([electronBinary, "/does/not/exist", "/tmp/project-sample"], {
        ...options,
        realpath: failingMissingPathRealpath,
      }),
    ).toBe("/tmp/project-sample");
  });

  it("skips tokens that resolve to a file, not a directory", () => {
    expect(
      parseFolderFromArgv(
        [electronBinary, "/tmp/project-sample.txt", "/tmp/project-sample"],
        options,
      ),
    ).toBe("/tmp/project-sample");
  });

  it("returns null when no argv token resolves to a directory", () => {
    expect(
      parseFolderFromArgv(
        [electronBinary, "--allow-file-access-from-files", "--some-switch=value"],
        options,
      ),
    ).toBeNull();
  });

  it("resolves a relative positional `.` against the provided cwd", () => {
    expect(
      parseFolderFromArgv([electronBinary, "."], {
        ...options,
        cwd: "/tmp/project-sample",
      }),
    ).toBe("/tmp/project-sample");
  });

  it("resolves a relative positional `./child` against the provided cwd", () => {
    expect(
      parseFolderFromArgv([electronBinary, "./child"], {
        ...options,
        cwd: "/tmp/project-parent",
      }),
    ).toBe("/tmp/project-parent/child");
  });

  it("resolves --t3-project-path= with a relative value against the provided cwd", () => {
    const knownWithTmpSample = new Set([...knownDirectories, "/tmp/sample"]);
    expect(
      parseFolderFromArgv([electronBinary, "--t3-project-path=./sample"], {
        realpath: (input: string) => input,
        isDirectory: (candidate: string) => knownWithTmpSample.has(candidate),
        cwd: "/tmp",
      }),
    ).toBe("/tmp/sample");
  });

  it("leaves absolute positional paths unchanged when cwd is set", () => {
    expect(
      parseFolderFromArgv([electronBinary, "/tmp/project-sample"], {
        ...options,
        cwd: "/some/other/cwd",
      }),
    ).toBe("/tmp/project-sample");
  });
});
