import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { acpReadTextFile, acpWriteTextFile } from "./AcpClientFs.ts";

const withTempDir = <A, E>(
  use: (input: {
    readonly fileSystem: FileSystem.FileSystem;
    readonly path: Path.Path;
    readonly directory: string;
  }) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "acp-client-fs-" });
    return yield* use({ fileSystem, path, directory });
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

describe("AcpClientFs", () => {
  it.effect("reads whole files and 1-based line windows", () =>
    withTempDir(({ fileSystem, path, directory }) =>
      Effect.gen(function* () {
        const filePath = path.join(directory, "notes.txt");
        yield* fileSystem.writeFileString(filePath, "one\ntwo\nthree\nfour");

        const whole = yield* acpReadTextFile(fileSystem, {
          sessionId: "session",
          path: filePath,
        });
        expect(whole.content).toBe("one\ntwo\nthree\nfour");

        const windowed = yield* acpReadTextFile(fileSystem, {
          sessionId: "session",
          path: filePath,
          line: 2,
          limit: 2,
        });
        expect(windowed.content).toBe("two\nthree");
      }),
    ),
  );

  it.effect("rejects relative paths and missing files with typed request errors", () =>
    withTempDir(({ fileSystem, path, directory }) =>
      Effect.gen(function* () {
        const relative = yield* Effect.flip(
          acpReadTextFile(fileSystem, { sessionId: "session", path: "notes.txt" }),
        );
        expect(relative.message).toContain("absolute path");

        const missing = yield* Effect.flip(
          acpReadTextFile(fileSystem, {
            sessionId: "session",
            path: path.join(directory, "missing.txt"),
          }),
        );
        expect(missing.message).toContain("Could not read text file");
      }),
    ),
  );

  it.effect("writes files, creating parent directories", () =>
    withTempDir(({ fileSystem, path, directory }) =>
      Effect.gen(function* () {
        const filePath = path.join(directory, "nested", "deep", "config.json");
        yield* acpWriteTextFile(fileSystem, {
          sessionId: "session",
          path: filePath,
          content: '{"ok":true}',
        });
        expect(yield* fileSystem.readFileString(filePath)).toBe('{"ok":true}');
      }),
    ),
  );
});
