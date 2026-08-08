import { describe, expect, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";

import {
  ClaudeExecutableFileCheck,
  ClaudeExecutableShimReader,
  resolveClaudeSdkExecutablePath,
} from "./ClaudeExecutable.ts";

const NPM_DIR = "C:\\Users\\dev\\AppData\\Roaming\\npm";
const NPM_SHIM = `${NPM_DIR}\\claude.cmd`;
const NPM_PACKAGE_EXE = `${NPM_DIR}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`;
const NPM_PACKAGE_CLI = `${NPM_DIR}\\node_modules\\@anthropic-ai\\claude-code\\cli.js`;

// Real content captured from an npm-generated `claude.cmd` shim (Node's
// documented cmd-shim convention: resolve own directory via %~dp0/%dp0%,
// invoke the real entry relative to it).
const npmCmdShimContent = (relativeTarget: string) => `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0
"%dp0%\\${relativeTarget}"   %*
`;

// Real content captured from a pnpm global `.cmd` shim: the real entry lives
// in a version-pinned pnpm store path, not under a fixed node_modules layout.
const pnpmCmdShimContent = (relativeTarget: string) => `@SETLOCAL
@IF EXIST "%~dp0\\node.exe" (
  "%~dp0\\node.exe"  "%~dp0\\${relativeTarget}" %*
) ELSE (
  node  "%~dp0\\${relativeTarget}" %*
)
`;

// Real content captured from a pnpm global `.ps1` shim.
const pnpmPs1ShimContent = (relativeTarget: string) => `#!/usr/bin/env pwsh
$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent
$exe=""
if ($PSVersionTable.PSVersion -lt "6.0" -or $IsWindows) {
  $exe=".exe"
}
if (Test-Path "$basedir/node$exe") {
  & "$basedir/node$exe"  "$basedir/${relativeTarget.replace(/\\/g, "/")}" $args
} else {
  & "node$exe"  "$basedir/${relativeTarget.replace(/\\/g, "/")}" $args
}
`;

function withWindowsResolution(input: {
  readonly resolvedCommand: string | undefined;
  readonly existingFiles?: ReadonlyArray<string>;
  readonly shimContents?: Readonly<Record<string, string>>;
}) {
  const existing = new Set(input.existingFiles ?? []);
  const shimContents = input.shimContents ?? {};
  return <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(HostProcessPlatform, "win32"),
      Effect.provideService(SpawnExecutableResolution, () => input.resolvedCommand),
      Effect.provideService(ClaudeExecutableFileCheck, (filePath) => existing.has(filePath)),
      Effect.provideService(ClaudeExecutableShimReader, (filePath) => shimContents[filePath]),
    );
}

describe("resolveClaudeSdkExecutablePath", () => {
  it.effect("returns the configured path unchanged on non-Windows platforms", () =>
    Effect.gen(function* () {
      expect(
        yield* resolveClaudeSdkExecutablePath("claude", {}).pipe(
          Effect.provideService(HostProcessPlatform, "darwin"),
          Effect.provideService(SpawnExecutableResolution, () => {
            throw new Error("must not resolve on non-Windows platforms");
          }),
        ),
      ).toBe("claude");
    }),
  );

  it.effect("returns the resolved absolute path for native Windows executables", () =>
    Effect.gen(function* () {
      const nativeBinary = "C:\\Users\\dev\\.local\\bin\\claude.exe";
      expect(
        yield* resolveClaudeSdkExecutablePath("claude", {}).pipe(
          withWindowsResolution({ resolvedCommand: nativeBinary }),
        ),
      ).toBe(nativeBinary);
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
    }),
  );

  it.effect("returns the configured path when command resolution finds nothing", () =>
    Effect.gen(function* () {
      expect(
        yield* resolveClaudeSdkExecutablePath("claude", {}).pipe(
          withWindowsResolution({ resolvedCommand: undefined }),
        ),
      ).toBe("claude");
    }),
  );

  it.effect("follows an npm .cmd shim via shim-content parsing, not just the fixed fallback", () =>
    Effect.gen(function* () {
      const relativeTarget = "node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe";
      expect(
        yield* resolveClaudeSdkExecutablePath("claude", {}).pipe(
          withWindowsResolution({
            resolvedCommand: NPM_SHIM,
            existingFiles: [NPM_PACKAGE_EXE],
            shimContents: { [NPM_SHIM]: npmCmdShimContent(relativeTarget) },
          }),
        ),
      ).toBe(NPM_PACKAGE_EXE);
    }),
  );

  describe("pnpm and other cmd-shim-convention global installs", () => {
    // pnpm keeps the real entry in a version-pinned store path
    // (global/5/.pnpm/<pkg>@<version>/node_modules/<pkg>/...), which the
    // fixed npm-layout candidate list cannot anticipate. The shim itself
    // still resolves its own directory and references the real entry
    // relative to it, so parsing the shim's source finds it.
    const PNPM_DIR = "C:\\Users\\dev\\AppData\\Local\\pnpm";
    const PNPM_SHIM_CMD = `${PNPM_DIR}\\claude.cmd`;
    const PNPM_SHIM_PS1 = `${PNPM_DIR}\\claude.ps1`;
    const PNPM_STORE_RELATIVE =
      "global\\5\\.pnpm\\@anthropic-ai+claude-code@2.1.224\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe";
    const PNPM_STORE_ABSOLUTE = `${PNPM_DIR}\\${PNPM_STORE_RELATIVE}`;

    it.effect("follows a pnpm .cmd global shim to its version-pinned store entry", () =>
      Effect.gen(function* () {
        expect(
          yield* resolveClaudeSdkExecutablePath("claude", {}).pipe(
            withWindowsResolution({
              resolvedCommand: PNPM_SHIM_CMD,
              existingFiles: [PNPM_STORE_ABSOLUTE],
              shimContents: { [PNPM_SHIM_CMD]: pnpmCmdShimContent(PNPM_STORE_RELATIVE) },
            }),
          ),
        ).toBe(PNPM_STORE_ABSOLUTE);
      }),
    );

    it.effect("skips the shim's own node.exe reference and finds the real target", () =>
      Effect.gen(function* () {
        // pnpmCmdShimContent references "%~dp0\node.exe" before the real
        // target; a naive first-match parse would return the Node runtime
        // itself instead of the package entry.
        expect(
          yield* resolveClaudeSdkExecutablePath("claude", {}).pipe(
            withWindowsResolution({
              resolvedCommand: PNPM_SHIM_CMD,
              existingFiles: [`${PNPM_DIR}\\node.exe`, PNPM_STORE_ABSOLUTE],
              shimContents: { [PNPM_SHIM_CMD]: pnpmCmdShimContent(PNPM_STORE_RELATIVE) },
            }),
          ),
        ).toBe(PNPM_STORE_ABSOLUTE);
      }),
    );

    it.effect("follows a pnpm .ps1 global shim via its $basedir reference", () =>
      Effect.gen(function* () {
        expect(
          yield* resolveClaudeSdkExecutablePath("claude", {}).pipe(
            withWindowsResolution({
              resolvedCommand: PNPM_SHIM_PS1,
              existingFiles: [PNPM_STORE_ABSOLUTE],
              shimContents: { [PNPM_SHIM_PS1]: pnpmPs1ShimContent(PNPM_STORE_RELATIVE) },
            }),
          ),
        ).toBe(PNPM_STORE_ABSOLUTE);
      }),
    );

    it.effect("falls back to the fixed npm layout when shim parsing finds nothing usable", () =>
      Effect.gen(function* () {
        expect(
          yield* resolveClaudeSdkExecutablePath("claude", {}).pipe(
            withWindowsResolution({
              resolvedCommand: NPM_SHIM,
              existingFiles: [NPM_PACKAGE_EXE],
              shimContents: { [NPM_SHIM]: "not a recognizable shim format" },
            }),
          ),
        ).toBe(NPM_PACKAGE_EXE);
      }),
    );
  });

  describe("install directories containing spaces", () => {
    const SPACED_DIR = "C:\\Users\\Jane Doe\\AppData\\Roaming\\npm";
    const SPACED_SHIM = `${SPACED_DIR}\\claude.cmd`;
    const SPACED_PACKAGE_EXE = `${SPACED_DIR}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`;

    it.effect("resolves an npm shim under a directory with spaces", () =>
      Effect.gen(function* () {
        expect(
          yield* resolveClaudeSdkExecutablePath("claude", {}).pipe(
            withWindowsResolution({
              resolvedCommand: SPACED_SHIM,
              existingFiles: [SPACED_PACKAGE_EXE],
            }),
          ),
        ).toBe(SPACED_PACKAGE_EXE);
      }),
    );

    it.effect("resolves a pnpm-style shim referencing a store path with spaces", () =>
      Effect.gen(function* () {
        const relativeTarget =
          "global\\5\\.pnpm\\@anthropic-ai+claude-code@2.1.224\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe";
        const absoluteTarget = `${SPACED_DIR}\\${relativeTarget}`;
        expect(
          yield* resolveClaudeSdkExecutablePath("claude", {}).pipe(
            withWindowsResolution({
              resolvedCommand: SPACED_SHIM,
              existingFiles: [absoluteTarget],
              shimContents: { [SPACED_SHIM]: pnpmCmdShimContent(relativeTarget) },
            }),
          ),
        ).toBe(absoluteTarget);
      }),
    );
  });
});
