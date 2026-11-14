// @effect-diagnostics-next-line nodeBuiltinImport:off -- Mocks the synchronous Windows resolver's filesystem boundary.
import * as NodeFS from "node:fs";

import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import { vi } from "vite-plus/test";

import { ClaudeExecutableFileCheck, resolveClaudeSdkExecutablePath } from "./ClaudeExecutable.ts";

vi.mock("node:fs", { spy: true });

const NPM_DIR = "C:\\Users\\dev\\AppData\\Roaming\\npm";
const NPM_SHIM = `${NPM_DIR}\\claude.cmd`;
const NPM_PACKAGE_EXE = `${NPM_DIR}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`;
const NPM_PACKAGE_CLI = `${NPM_DIR}\\node_modules\\@anthropic-ai\\claude-code\\cli.js`;
const LOCAL_APP_DATA = "C:\\Users\\Developer Name\\AppData\\Local";
const WINGET_SHIM = `${LOCAL_APP_DATA}\\Microsoft\\WinGet\\Links\\claude.cmd`;
const WINGET_PACKAGE = "Anthropic.ClaudeCode_Microsoft.Winget.Source_8wekyb3d8bbwe";
const WINGET_EXE = `${LOCAL_APP_DATA}\\Microsoft\\WinGet\\Packages\\${WINGET_PACKAGE}\\claude.exe`;
const WINGET_LAUNCHER = `@echo off\r\n"%LOCALAPPDATA%\\Microsoft\\WinGet\\Packages\\${WINGET_PACKAGE}\\claude.exe" %*\r\n`;

function withWindowsResolution(input: {
  readonly resolvedCommand: string | undefined;
  readonly existingFiles?: ReadonlyArray<string>;
}) {
  const existing = new Set(input.existingFiles ?? []);
  return <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(HostProcess.Platform, "win32"),
      Effect.provideService(SpawnExecutableResolution, () => input.resolvedCommand),
      Effect.provideService(ClaudeExecutableFileCheck, (filePath) => existing.has(filePath)),
    );
}

describe("resolveClaudeSdkExecutablePath", () => {
  it.effect("follows the WinGet launcher to its native executable", () =>
    Effect.gen(function* () {
      for (const [launcher, localAppData] of [
        [WINGET_LAUNCHER, LOCAL_APP_DATA],
        [WINGET_LAUNCHER.toLowerCase().replaceAll("\r\n", "\n"), LOCAL_APP_DATA],
        [WINGET_LAUNCHER, "C:\\Users\\literal $& %name%\\AppData\\Local"],
      ] as const) {
        using _read = vi.spyOn(NodeFS, "readFileSync").mockReturnValue(launcher);
        const shim = WINGET_SHIM.replace(LOCAL_APP_DATA, () => localAppData);
        const executable = WINGET_EXE.replace(LOCAL_APP_DATA, () => localAppData);
        for (const environment of [
          { LOCALAPPDATA: localAppData },
          { LocalAppData: localAppData },
        ]) {
          for (const resolvedCommand of [
            shim,
            "C:\\Users\\DEVELO~1\\AppData\\Local\\Microsoft\\WinGet\\Links\\claude.cmd",
            "C:\\winget-links\\claude.cmd",
          ]) {
            using _realpath = vi
              .spyOn(NodeFS.realpathSync, "native")
              .mockImplementation((filePath) => {
                if (filePath === shim || filePath === resolvedCommand) return shim;
                throw new Error("unknown launcher");
              });
            for (const binaryPath of ["claude", resolvedCommand]) {
              expect(
                yield* resolveClaudeSdkExecutablePath(binaryPath, environment).pipe(
                  withWindowsResolution({ resolvedCommand, existingFiles: [executable] }),
                ),
              ).toBe(executable);
            }
          }
        }
      }
    }),
  );

  it.effect("leaves unsupported or missing WinGet targets unresolved", () =>
    Effect.gen(function* () {
      for (const launcher of [
        WINGET_LAUNCHER.replace(WINGET_PACKAGE, "Other.Package"),
        WINGET_LAUNCHER.replace("%LOCALAPPDATA%", "%APPDATA%"),
        WINGET_LAUNCHER.replace("claude.exe", "..\\other.exe"),
        WINGET_LAUNCHER.replace(" %*", " --extra %*"),
        `${WINGET_LAUNCHER}echo side effect\r\n`,
        WINGET_LAUNCHER.replace(" %*", " %* & echo side effect"),
      ]) {
        using _read = vi.spyOn(NodeFS, "readFileSync").mockReturnValue(launcher);
        expect(
          yield* resolveClaudeSdkExecutablePath("claude", { LOCALAPPDATA: LOCAL_APP_DATA }).pipe(
            withWindowsResolution({ resolvedCommand: WINGET_SHIM, existingFiles: [WINGET_EXE] }),
          ),
        ).toBe("claude");
      }
      using _read = vi.spyOn(NodeFS, "readFileSync").mockReturnValue(WINGET_LAUNCHER);
      for (const environment of [{}, { LOCALAPPDATA: "relative" }]) {
        expect(
          yield* resolveClaudeSdkExecutablePath("claude", environment).pipe(
            withWindowsResolution({ resolvedCommand: WINGET_SHIM, existingFiles: [WINGET_EXE] }),
          ),
        ).toBe("claude");
      }
      expect(
        yield* resolveClaudeSdkExecutablePath("claude", { LOCALAPPDATA: LOCAL_APP_DATA }).pipe(
          withWindowsResolution({ resolvedCommand: WINGET_SHIM }),
        ),
      ).toBe("claude");
      using _realpath = vi
        .spyOn(NodeFS.realpathSync, "native")
        .mockImplementation((filePath) => String(filePath));
      for (const shim of [
        NPM_SHIM,
        WINGET_SHIM.replace(".cmd", ".ps1"),
        "C:\\different-winget-links\\claude.cmd",
      ]) {
        expect(
          yield* resolveClaudeSdkExecutablePath("claude", { LOCALAPPDATA: LOCAL_APP_DATA }).pipe(
            withWindowsResolution({
              resolvedCommand: shim,
              existingFiles: [WINGET_EXE],
            }),
          ),
        ).toBe("claude");
      }
    }),
  );

  it.effect("follows an npm launcher shim to the packaged native binary", () =>
    Effect.gen(function* () {
      expect(
        yield* resolveClaudeSdkExecutablePath("claude", {}).pipe(
          withWindowsResolution({
            resolvedCommand: NPM_SHIM,
            existingFiles: [NPM_PACKAGE_EXE, NPM_PACKAGE_CLI],
          }),
        ),
      ).toBe(NPM_PACKAGE_EXE);
    }),
  );

  it.effect("follows .bat and .ps1 launcher shims the same way", () =>
    Effect.gen(function* () {
      for (const shim of [`${NPM_DIR}\\claude.bat`, `${NPM_DIR}\\claude.ps1`]) {
        expect(
          yield* resolveClaudeSdkExecutablePath("claude", {}).pipe(
            withWindowsResolution({
              resolvedCommand: shim,
              existingFiles: [NPM_PACKAGE_EXE],
            }),
          ),
        ).toBe(NPM_PACKAGE_EXE);
      }
    }),
  );

  it.effect("normalizes mixed-case shim extensions before matching", () =>
    Effect.gen(function* () {
      expect(
        yield* resolveClaudeSdkExecutablePath("claude", {}).pipe(
          withWindowsResolution({
            resolvedCommand: `${NPM_DIR}\\claude.CMD`,
            existingFiles: [NPM_PACKAGE_EXE],
          }),
        ),
      ).toBe(NPM_PACKAGE_EXE);
    }),
  );

  it.effect("falls back to cli.js when the package ships no native binary", () =>
    Effect.gen(function* () {
      expect(
        yield* resolveClaudeSdkExecutablePath("claude", {}).pipe(
          withWindowsResolution({
            resolvedCommand: NPM_SHIM,
            existingFiles: [NPM_PACKAGE_CLI],
          }),
        ),
      ).toBe(NPM_PACKAGE_CLI);
    }),
  );

  it.effect("returns the configured path when a shim has no known package entry", () =>
    Effect.gen(function* () {
      expect(
        yield* resolveClaudeSdkExecutablePath("claude", {}).pipe(
          withWindowsResolution({ resolvedCommand: NPM_SHIM }),
        ),
      ).toBe("claude");
      using _read = vi.spyOn(NodeFS, "readFileSync").mockImplementation(() => {
        throw new Error("unreadable launcher");
      });
      expect(
        yield* resolveClaudeSdkExecutablePath(WINGET_SHIM, { LOCALAPPDATA: LOCAL_APP_DATA }).pipe(
          withWindowsResolution({ resolvedCommand: WINGET_SHIM, existingFiles: [WINGET_EXE] }),
        ),
      ).toBe(WINGET_SHIM);
      using _realpath = vi.spyOn(NodeFS.realpathSync, "native").mockImplementation(() => {
        throw new Error("unreadable path");
      });
      expect(
        yield* resolveClaudeSdkExecutablePath("claude", { LOCALAPPDATA: LOCAL_APP_DATA }).pipe(
          withWindowsResolution({
            resolvedCommand: "C:\\unreadable-winget-links\\claude.cmd",
            existingFiles: [WINGET_EXE],
          }),
        ),
      ).toBe("claude");
    }),
  );
});
