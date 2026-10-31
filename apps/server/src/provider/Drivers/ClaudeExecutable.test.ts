import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";

import {
  ClaudeExecutableFileCheck,
  ClaudeExecutableFileRead,
  resolveClaudeSdkExecutablePath,
} from "./ClaudeExecutable.ts";

const NPM_DIR = "C:\\Users\\dev\\AppData\\Roaming\\npm";
const NPM_SHIM = `${NPM_DIR}\\claude.cmd`;
const NPM_PACKAGE_EXE = `${NPM_DIR}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`;
const NPM_PACKAGE_CLI = `${NPM_DIR}\\node_modules\\@anthropic-ai\\claude-code\\cli.js`;

const PNPM_HOME = "C:\\Users\\dev\\AppData\\Local\\pnpm";
const PNPM_SHIM = `${PNPM_HOME}\\bin\\claude.CMD`;
const PNPM_PACKAGES = "global\\v11\\7674-1a16f3bff9d-6efed413fb25d243\\node_modules";
const PNPM_PACKAGE_EXE = `${PNPM_HOME}\\${PNPM_PACKAGES}\\@anthropic-ai\\claude-code\\bin\\claude.exe`;
// Captured from `pnpm add -g @anthropic-ai/claude-code` with pnpm 11.
const pnpmShim = (target: string) =>
  `@SETLOCAL\r\n@"%~dp0\\..\\${PNPM_PACKAGES}\\${target}"   %*\r\n`;

function withWindowsResolution(input: {
  readonly resolvedCommand: string | undefined;
  readonly existingFiles?: ReadonlyArray<string>;
  readonly fileContents?: Readonly<Record<string, string>>;
}) {
  const existing = new Set(input.existingFiles ?? []);
  const contents = input.fileContents ?? {};
  return <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(HostProcess.Platform, "win32"),
      Effect.provideService(SpawnExecutableResolution, () => input.resolvedCommand),
      Effect.provideService(ClaudeExecutableFileCheck, (filePath) => existing.has(filePath)),
      Effect.provideService(ClaudeExecutableFileRead, (filePath) => contents[filePath]),
    );
}

describe("resolveClaudeSdkExecutablePath", () => {
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

  it.effect("follows a pnpm launcher shim into pnpm's global package directory", () =>
    Effect.gen(function* () {
      expect(
        yield* resolveClaudeSdkExecutablePath("claude", {}).pipe(
          withWindowsResolution({
            resolvedCommand: PNPM_SHIM,
            existingFiles: [PNPM_PACKAGE_EXE],
            fileContents: {
              [PNPM_SHIM]: pnpmShim("@anthropic-ai\\claude-code\\bin\\claude.exe"),
            },
          }),
        ),
      ).toBe(PNPM_PACKAGE_EXE);
    }),
  );

  it.effect("does not follow a pnpm launcher shim that runs another package", () =>
    Effect.gen(function* () {
      expect(
        yield* resolveClaudeSdkExecutablePath("claude", {}).pipe(
          withWindowsResolution({
            resolvedCommand: PNPM_SHIM,
            existingFiles: [`${PNPM_HOME}\\${PNPM_PACKAGES}\\other-cli\\bin\\claude.exe`],
            fileContents: { [PNPM_SHIM]: pnpmShim("other-cli\\bin\\claude.exe") },
          }),
        ),
      ).toBe("claude");
    }),
  );

  it.effect("keeps the fallback for missing targets and modified pnpm shims", () =>
    Effect.gen(function* () {
      const shim = pnpmShim("@anthropic-ai\\claude-code\\bin\\claude.exe");
      for (const input of [
        { fileContents: { [PNPM_SHIM]: shim } },
        { existingFiles: [PNPM_PACKAGE_EXE] },
        {
          existingFiles: [PNPM_PACKAGE_EXE],
          fileContents: { [PNPM_SHIM]: shim + "echo extra\r\n" },
        },
      ]) {
        expect(
          yield* resolveClaudeSdkExecutablePath("claude", {}).pipe(
            withWindowsResolution({ resolvedCommand: PNPM_SHIM, ...input }),
          ),
        ).toBe("claude");
      }
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
});
