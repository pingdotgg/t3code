import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import {
  ANTIGRAVITY_LEGACY_SYSTEM_TEMP_MIN_AGE_MS,
  cleanOrphanedAntigravitySystemTempDirs,
  resolveAntigravityLegacySystemTempDirectories,
} from "./AntigravitySessionFiles.ts";

const STALE_SECONDS = 1;
const NOW_MS = Date.UTC(2026, 8, 20);

it("dedupes TEMP and TMP and ignores empty host temp values", () => {
  expect(
    resolveAntigravityLegacySystemTempDirectories({
      TEMP: "C:\\Temp",
      TMP: "C:\\Temp",
    }),
  ).toEqual(["C:\\Temp"]);
  expect(
    resolveAntigravityLegacySystemTempDirectories({
      TEMP: "C:\\Temp",
      TMP: "C:\\Users\\user\\AppData\\Local\\Temp",
    }),
  ).toEqual(["C:\\Temp", "C:\\Users\\user\\AppData\\Local\\Temp"]);
  expect(resolveAntigravityLegacySystemTempDirectories({ TEMP: "", TMP: undefined })).toEqual([]);
});

it.layer(NodeServices.layer)("cleanOrphanedAntigravitySystemTempDirs", (it) => {
  const sweep = (systemTempDirectory: string) =>
    cleanOrphanedAntigravitySystemTempDirs({
      systemTempDirectory,
      nowMs: NOW_MS,
      minAgeMs: ANTIGRAVITY_LEGACY_SYSTEM_TEMP_MIN_AGE_MS,
    });

  const makeDir = Effect.fn("makeAntigravityMeiFixture")(function* (
    root: string,
    name: string,
    contents: ReadonlyArray<{ readonly relative: ReadonlyArray<string>; readonly body: string }>,
    stale: boolean,
  ) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = path.join(root, name);
    yield* fs.makeDirectory(directory, { recursive: true });
    for (const entry of contents) {
      const filePath = path.join(directory, ...entry.relative);
      yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
      yield* fs.writeFileString(filePath, entry.body);
    }
    if (stale) {
      yield* fs.utimes(directory, STALE_SECONDS, STALE_SECONDS);
    }
    return directory;
  });

  it.effect("removes stale Antigravity-marked _MEI directories and leaves everything else", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-antigravity-mei-sweep-" });
      const licenses = yield* makeDir(
        root,
        "_MEIlicenses",
        [{ relative: ["agy_acp_licenses.txt"], body: "agy" }],
        true,
      );
      const harness = yield* makeDir(
        root,
        "_MEIharness",
        [{ relative: ["localharness"], body: "harness" }],
        true,
      );
      const nested = yield* makeDir(
        root,
        "_MEInested",
        [{ relative: ["google3", "third_party", "jetski_prod", "localharness"], body: "jetski" }],
        true,
      );
      const young = yield* makeDir(
        root,
        "_MEIyoung",
        [{ relative: ["agy_acp_licenses.txt"], body: "agy" }],
        false,
      );
      const google3Only = yield* makeDir(
        root,
        "_MEIgoogle3",
        [{ relative: ["google3", "payload.bin"], body: "other" }],
        true,
      );
      const unmarked = yield* makeDir(
        root,
        "_MEIother",
        [{ relative: ["payload.bin"], body: "pyinstaller" }],
        true,
      );
      const notMei = yield* makeDir(
        root,
        "scratch",
        [{ relative: ["agy_acp_licenses.txt"], body: "agy" }],
        true,
      );

      yield* sweep(root);

      expect(yield* fs.exists(licenses)).toBe(false);
      expect(yield* fs.exists(harness)).toBe(false);
      expect(yield* fs.exists(nested)).toBe(false);
      expect(yield* fs.exists(young)).toBe(true);
      expect(yield* fs.exists(google3Only)).toBe(true);
      expect(yield* fs.exists(unmarked)).toBe(true);
      expect(yield* fs.exists(notMei)).toBe(true);
      expect(yield* fs.exists(path.join(notMei, "agy_acp_licenses.txt"))).toBe(true);
    }),
  );

  it.effect("preserves a marked _MEI directory at the exact minimum-age boundary", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "t3-antigravity-mei-boundary-",
      });
      const boundary = yield* makeDir(
        root,
        "_MEIboundary",
        [{ relative: ["agy_acp_licenses.txt"], body: "agy" }],
        false,
      );
      const older = yield* makeDir(
        root,
        "_MEIolder",
        [{ relative: ["agy_acp_licenses.txt"], body: "agy" }],
        false,
      );
      const cutoff = new Date(NOW_MS - ANTIGRAVITY_LEGACY_SYSTEM_TEMP_MIN_AGE_MS);
      const pastCutoff = new Date(NOW_MS - ANTIGRAVITY_LEGACY_SYSTEM_TEMP_MIN_AGE_MS - 1000);
      yield* fs.utimes(boundary, cutoff, cutoff);
      yield* fs.utimes(older, pastCutoff, pastCutoff);

      yield* sweep(root);

      expect(yield* fs.exists(boundary)).toBe(true);
      expect(yield* fs.exists(older)).toBe(false);
    }),
  );

  it.effect("leaves a marked directory alone when remove fails with EBUSY", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-antigravity-mei-busy-" });
      const busy = yield* makeDir(
        root,
        "_MEIbusy",
        [{ relative: ["agy_acp_licenses.txt"], body: "agy" }],
        true,
      );
      const locked = FileSystem.FileSystem.of({
        ...fs,
        remove: (target, options) =>
          target === busy
            ? Effect.fail(
                PlatformError.systemError({
                  _tag: "Busy",
                  module: "FileSystem",
                  method: "remove",
                  pathOrDescriptor: target,
                  description: "EBUSY",
                }),
              )
            : fs.remove(target, options),
      });

      yield* sweep(root).pipe(Effect.provideService(FileSystem.FileSystem, locked));
      expect(yield* fs.exists(path.join(busy, "agy_acp_licenses.txt"))).toBe(true);
    }),
  );

  it.effect("does not fail when the injected system temp directory is missing", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const root = yield* FileSystem.FileSystem.pipe(
        Effect.flatMap((fs) =>
          fs.makeTempDirectoryScoped({ prefix: "t3-antigravity-mei-missing-" }),
        ),
      );
      yield* sweep(path.join(root, "gone"));
    }),
  );
});
