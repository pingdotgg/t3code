import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { writeCredentialFile } from "./credential-file.ts";

describe("writeCredentialFile", () => {
  it.effect("creates an owner-only file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { join } = yield* Path.Path;
      const path = join(yield* fs.makeTempDirectoryScoped(), "credential.json");

      yield* writeCredentialFile(path, "token-bytes");

      expect(yield* fs.readFileString(path)).toBe("token-bytes");
      expect((yield* fs.stat(path)).mode & 0o077).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses an existing file or symlink without writing to it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { join } = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped();
      const existing = join(directory, "existing.json");
      const link = join(directory, "link.json");
      yield* fs.writeFileString(existing, "previous", { mode: 0o644 });
      yield* fs.symlink(existing, link);

      for (const path of [existing, link]) {
        const result = yield* Effect.exit(writeCredentialFile(path, "token-bytes"));
        expect(result._tag).toBe("Failure");
      }
      expect(yield* fs.readFileString(existing)).toBe("previous");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
