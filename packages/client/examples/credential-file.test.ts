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

      let paired = false;
      yield* writeCredentialFile(
        path,
        Effect.gen(function* () {
          // Pairing only starts after the destination exists with owner-only permissions.
          expect((yield* fs.stat(path)).mode & 0o077).toBe(0);
          paired = true;
          return "token-bytes";
        }),
      );
      expect(paired).toBe(true);

      expect(yield* fs.readFileString(path)).toBe("token-bytes");
      expect((yield* fs.stat(path)).mode & 0o077).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects unusable destinations before pairing without overwriting existing files", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { join } = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped();
      const existing = join(directory, "existing.json");
      const link = join(directory, "link.json");
      yield* fs.writeFileString(existing, "previous", { mode: 0o644 });
      yield* fs.symlink(existing, link);

      let paired = false;
      const credential = Effect.sync(() => {
        paired = true;
        return "token-bytes";
      });
      for (const path of [existing, link, join(directory, "missing", "credential.json")]) {
        const result = yield* Effect.exit(writeCredentialFile(path, credential));
        expect(result._tag).toBe("Failure");
        expect(paired).toBe(false);
      }
      expect(yield* fs.readFileString(existing)).toBe("previous");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("releases the reserved path when credential creation fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { join } = yield* Path.Path;
      const path = join(yield* fs.makeTempDirectoryScoped(), "credential.json");
      const result = yield* Effect.exit(writeCredentialFile(path, Effect.fail("pairing failed")));
      expect(result._tag).toBe("Failure");
      expect(yield* fs.exists(path)).toBe(false);
      yield* writeCredentialFile(path, Effect.succeed("retried-token-bytes"));
      expect(yield* fs.readFileString(path)).toBe("retried-token-bytes");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
