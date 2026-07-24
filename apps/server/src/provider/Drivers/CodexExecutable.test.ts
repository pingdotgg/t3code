import { describe, expect, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";

import {
  CodexDesktopBinaryDiscovery,
  type CodexDesktopFileSystem,
  findCodexDesktopBinary,
  resolveCodexExecutablePath,
} from "./CodexExecutable.ts";

const LOCAL_APP_DATA = "C:\\Users\\dev\\AppData\\Local";
const DESKTOP_BINARY = "C:\\Users\\dev\\AppData\\Local\\OpenAI\\Codex\\bin\\new-runtime\\codex.exe";

function withWindowsResolution(input: {
  readonly resolvedCommand?: string;
  readonly desktopBinary?: string;
}) {
  return <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(HostProcessPlatform, "win32"),
      Effect.provideService(SpawnExecutableResolution, () => input.resolvedCommand),
      Effect.provideService(CodexDesktopBinaryDiscovery, () => input.desktopBinary),
    );
}

describe("findCodexDesktopBinary", () => {
  it("selects the newest executable from versioned runtime directories", () => {
    const root = `${LOCAL_APP_DATA}\\OpenAI\\Codex\\bin`;
    const files = new Map([
      [`${root}\\old-runtime\\codex.exe`, { isFile: true, modifiedAt: 100 }],
      [`${root}\\new-runtime\\codex.exe`, { isFile: true, modifiedAt: 200 }],
    ]);
    const fileSystem: CodexDesktopFileSystem = {
      readDirectory: () => [
        { name: "old-runtime", isDirectory: true },
        { name: "ignored-file", isDirectory: false },
        { name: "new-runtime", isDirectory: true },
        { name: "empty-runtime", isDirectory: true },
      ],
      statFile: (filePath) => files.get(filePath),
    };

    expect(findCodexDesktopBinary(LOCAL_APP_DATA, fileSystem)).toBe(DESKTOP_BINARY);
  });

  it("returns undefined when no runtime contains codex.exe", () => {
    const fileSystem: CodexDesktopFileSystem = {
      readDirectory: () => [{ name: "empty-runtime", isDirectory: true }],
      statFile: () => undefined,
    };

    expect(findCodexDesktopBinary(LOCAL_APP_DATA, fileSystem)).toBeUndefined();
  });
});

describe("resolveCodexExecutablePath", () => {
  it.effect("returns the configured path unchanged on non-Windows platforms", () =>
    Effect.gen(function* () {
      expect(
        yield* resolveCodexExecutablePath("codex", {}).pipe(
          Effect.provideService(HostProcessPlatform, "darwin"),
          Effect.provideService(SpawnExecutableResolution, () => {
            throw new Error("must not resolve on non-Windows platforms");
          }),
          Effect.provideService(CodexDesktopBinaryDiscovery, () => {
            throw new Error("must not inspect Codex Desktop on non-Windows platforms");
          }),
        ),
      ).toBe("codex");
    }),
  );

  it.effect("prefers a normal PATH installation", () =>
    Effect.gen(function* () {
      const installedBinary = "C:\\Users\\dev\\AppData\\Roaming\\npm\\codex.cmd";
      expect(
        yield* resolveCodexExecutablePath("codex", {
          LOCALAPPDATA: LOCAL_APP_DATA,
        }).pipe(
          withWindowsResolution({
            resolvedCommand: installedBinary,
            desktopBinary: DESKTOP_BINARY,
          }),
        ),
      ).toBe(installedBinary);
    }),
  );

  it.effect("falls back to Codex Desktop for the default Windows command", () =>
    Effect.gen(function* () {
      expect(
        yield* resolveCodexExecutablePath("codex", {
          LOCALAPPDATA: LOCAL_APP_DATA,
        }).pipe(withWindowsResolution({ desktopBinary: DESKTOP_BINARY })),
      ).toBe(DESKTOP_BINARY);
    }),
  );

  it.effect("respects an explicit binary path when it cannot be resolved", () =>
    Effect.gen(function* () {
      const explicitBinary = "C:\\custom\\codex.exe";
      expect(
        yield* resolveCodexExecutablePath(explicitBinary, {
          LOCALAPPDATA: LOCAL_APP_DATA,
        }).pipe(withWindowsResolution({ desktopBinary: DESKTOP_BINARY })),
      ).toBe(explicitBinary);
    }),
  );

  it.effect("keeps the default command when Codex Desktop is unavailable", () =>
    Effect.gen(function* () {
      expect(
        yield* resolveCodexExecutablePath("codex", {
          LOCALAPPDATA: LOCAL_APP_DATA,
        }).pipe(withWindowsResolution({})),
      ).toBe("codex");
    }),
  );
});
