import {
  createComputeArchive,
  normalizeEntrypoint,
} from "@/Prisma/ComputeArchive";
import { closeDirectoryHandle } from "@/Prisma/Internal/ArchivePlatform";
import { PlatformServices } from "@/Util/PlatformServices";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { gunzipSync } from "node:zlib";

interface TarEntry {
  name: string;
  body: string;
  mode: number;
  type: string;
  linkname: string;
}

const readString = (buffer: Uint8Array, start: number, length: number) => {
  const bytes = buffer.slice(start, start + length);
  const end = bytes.indexOf(0);
  return new TextDecoder().decode(end >= 0 ? bytes.slice(0, end) : bytes);
};

const parseTar = (buffer: Uint8Array) => {
  const entries: TarEntry[] = [];
  let offset = 0;
  while (offset + 512 <= buffer.length) {
    const header = buffer.slice(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = readString(header, 0, 100);
    const prefix = readString(header, 345, 155);
    const sizeText = readString(header, 124, 12).trim();
    const size = Number.parseInt(sizeText || "0", 8);
    const bodyStart = offset + 512;
    const body = buffer.slice(bodyStart, bodyStart + size);
    entries.push({
      name: prefix ? `${prefix}/${name}` : name,
      body: new TextDecoder().decode(body),
      mode: Number.parseInt(readString(header, 100, 8).trim() || "0", 8),
      type: readString(header, 156, 1) || "0",
      linkname: readString(header, 157, 100),
    });
    offset = bodyStart + size + ((512 - (size % 512)) % 512);
  }
  return entries;
};

describe("createComputeArchive", () => {
  it("closes Node and Bun directory handles without masking traversal", async () => {
    await expect(
      closeDirectoryHandle({ close: () => undefined }),
    ).resolves.toBeUndefined();
    await expect(
      closeDirectoryHandle({ close: () => Promise.resolve() }),
    ).resolves.toBeUndefined();
    await expect(
      closeDirectoryHandle({
        close: () => Promise.reject(new Error("closed")),
      }),
    ).resolves.toBeUndefined();
    await expect(
      closeDirectoryHandle({
        close: () => {
          throw new Error("closed");
        },
      }),
    ).resolves.toBeUndefined();
  });

  it.effect("creates the tar.gz format expected by Prisma Compute", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({
        prefix: "alchemy-prisma-compute-",
      });
      yield* fs.makeDirectory(path.join(root, "src"));
      yield* fs.writeFileString(
        path.join(root, "src", "main.ts"),
        "console.log('hello');",
      );
      yield* fs.writeFileString(path.join(root, "package.json"), "{}");

      const archive = yield* createComputeArchive({
        directory: root,
        entrypoint: "src/main.ts",
      });
      const entries = parseTar(yield* Effect.sync(() => gunzipSync(archive)));
      const byName = new Map(entries.map((entry) => [entry.name, entry.body]));

      expect(byName.get("bundle/src/main.ts")).toBe("console.log('hello');");
      expect(byName.get("bundle/package.json")).toBe("{}");
      expect(JSON.parse(byName.get("compute.manifest.json")!)).toEqual({
        manifestVersion: "1",
        entrypoint: "bundle/src/main.ts",
      });
    }).pipe(Effect.provide(PlatformServices)),
  );

  it.effect("produces deterministic bytes for unchanged input", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({
        prefix: "alchemy-prisma-compute-deterministic-",
      });
      yield* fs.writeFileString(path.join(root, "z.ts"), "z");
      yield* fs.writeFileString(path.join(root, "server.ts"), "server");
      yield* fs.writeFileString(path.join(root, "a.ts"), "a");

      const first = yield* createComputeArchive({
        directory: root,
        entrypoint: "server.ts",
      });
      const second = yield* createComputeArchive({
        directory: root,
        entrypoint: "server.ts",
      });

      expect(second).toEqual(first);
    }).pipe(Effect.provide(PlatformServices)),
  );

  it.effect("rejects unsafe entrypoints", () =>
    Effect.gen(function* () {
      const parent = yield* Effect.exit(normalizeEntrypoint("../server.ts"));
      const absolute = yield* Effect.exit(normalizeEntrypoint("/server.ts"));

      expect(parent._tag).toBe("Failure");
      expect(absolute._tag).toBe("Failure");
    }),
  );

  it.effect("preserves executable file modes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({
        prefix: "alchemy-prisma-compute-",
      });
      const server = path.join(root, "server.sh");
      yield* fs.writeFileString(server, "#!/bin/sh\n");
      yield* fs.chmod(server, 0o755);

      const archive = yield* createComputeArchive({
        directory: root,
        entrypoint: "server.sh",
      });
      const entries = parseTar(yield* Effect.sync(() => gunzipSync(archive)));
      const byName = new Map(entries.map((entry) => [entry.name, entry]));

      expect(byName.get("bundle/server.sh")?.mode).toBe(0o755);
    }).pipe(Effect.provide(PlatformServices)),
  );

  it.effect("rejects missing entrypoints before uploading", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectory({
        prefix: "alchemy-prisma-compute-",
      });
      const result = yield* Effect.exit(
        createComputeArchive({
          directory: root,
          entrypoint: "server.ts",
        }),
      );

      expect(result._tag).toBe("Failure");
    }).pipe(Effect.provide(PlatformServices)),
  );

  it.effect("preserves symlinks that stay inside the artifact root", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({
        prefix: "alchemy-prisma-compute-",
      });
      yield* fs.writeFileString(path.join(root, "server.ts"), "export {};");
      yield* fs.writeFileString(path.join(root, "real.ts"), "real file");
      yield* fs.symlink(path.join(root, "real.ts"), path.join(root, "link.ts"));

      const archive = yield* createComputeArchive({
        directory: root,
        entrypoint: "server.ts",
      });
      const entries = parseTar(yield* Effect.sync(() => gunzipSync(archive)));
      const byName = new Map(entries.map((entry) => [entry.name, entry]));

      expect(byName.get("bundle/link.ts")).toMatchObject({
        type: "2",
        linkname: "real.ts",
      });
      expect(byName.get("bundle/real.ts")?.body).toBe("real file");
    }).pipe(Effect.provide(PlatformServices)),
  );

  it.effect(
    "preserves symlinked directories that stay inside the artifact root",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectory({
          prefix: "alchemy-prisma-compute-",
        });
        const realDir = path.join(root, "real");
        yield* fs.makeDirectory(realDir);
        yield* fs.writeFileString(path.join(root, "server.ts"), "export {};");
        yield* fs.writeFileString(path.join(realDir, "nested.ts"), "nested");
        yield* fs.symlink(realDir, path.join(root, "linked"));

        const archive = yield* createComputeArchive({
          directory: root,
          entrypoint: "server.ts",
        });
        const entries = parseTar(yield* Effect.sync(() => gunzipSync(archive)));
        const byName = new Map(entries.map((entry) => [entry.name, entry]));

        expect(byName.get("bundle/linked")).toMatchObject({
          type: "2",
          linkname: "real",
        });
        expect(byName.get("bundle/real/nested.ts")?.body).toBe("nested");
        expect(byName.has("bundle/linked/nested.ts")).toBe(false);
      }).pipe(Effect.provide(PlatformServices)),
  );

  it.effect("rejects symlinks that escape the artifact root", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({
        prefix: "alchemy-prisma-compute-",
      });
      const outside = yield* fs.makeTempDirectory({
        prefix: "alchemy-prisma-compute-outside-",
      });
      yield* fs.writeFileString(path.join(root, "server.ts"), "export {};");
      yield* fs.writeFileString(path.join(outside, "secret.ts"), "secret");
      yield* fs.symlink(
        path.join(outside, "secret.ts"),
        path.join(root, "secret.ts"),
      );

      const result = yield* Effect.exit(
        createComputeArchive({
          directory: root,
          entrypoint: "server.ts",
        }),
      );

      expect(result._tag).toBe("Failure");
    }).pipe(Effect.provide(PlatformServices)),
  );

  it.effect("rejects symlinked directories that escape the artifact root", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({
        prefix: "alchemy-prisma-compute-",
      });
      const outside = yield* fs.makeTempDirectory({
        prefix: "alchemy-prisma-compute-outside-",
      });
      yield* fs.writeFileString(path.join(root, "server.ts"), "export {};");
      yield* fs.writeFileString(path.join(outside, "secret.ts"), "secret");
      yield* fs.symlink(outside, path.join(root, "outside"));

      const result = yield* Effect.exit(
        createComputeArchive({
          directory: root,
          entrypoint: "server.ts",
        }),
      );

      expect(result._tag).toBe("Failure");
    }).pipe(Effect.provide(PlatformServices)),
  );

  it.effect("excludes sensitive files at every workspace depth", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({
        prefix: "alchemy-prisma-compute-sensitive-",
      });
      yield* fs.makeDirectory(path.join(root, "apps", "api", ".git"), {
        recursive: true,
      });
      yield* fs.makeDirectory(path.join(root, "apps", "api", ".alchemy"), {
        recursive: true,
      });
      yield* fs.writeFileString(path.join(root, "server.ts"), "safe");
      yield* fs.writeFileString(path.join(root, ".env"), "ROOT_SECRET=x");
      yield* fs.writeFileString(
        path.join(root, "apps", "api", ".env.production"),
        "NESTED_SECRET=x",
      );
      yield* fs.writeFileString(
        path.join(root, "apps", "api", ".git", "config"),
        "credential=x",
      );
      yield* fs.writeFileString(
        path.join(root, "apps", "api", ".alchemy", "state"),
        "secret=x",
      );
      yield* fs.writeFileString(path.join(root, "debug.log"), "ignored");

      const archive = yield* createComputeArchive({
        directory: root,
        entrypoint: "server.ts",
        ignore: ["*.log"],
      });
      const names = parseTar(yield* Effect.sync(() => gunzipSync(archive))).map(
        (entry) => entry.name,
      );

      expect(names).toContain("bundle/server.ts");
      expect(names.some((name) => name.includes(".env"))).toBe(false);
      expect(names.some((name) => name.includes(".git"))).toBe(false);
      expect(names.some((name) => name.includes(".alchemy"))).toBe(false);
      expect(names).not.toContain("bundle/debug.log");
    }).pipe(Effect.provide(PlatformServices)),
  );

  it.effect("rejects an entrypoint excluded by the safety policy", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({
        prefix: "alchemy-prisma-compute-ignored-entry-",
      });
      yield* fs.writeFileString(path.join(root, ".env"), "secret");

      const result = yield* Effect.exit(
        createComputeArchive({ directory: root, entrypoint: ".env" }),
      );

      expect(result._tag).toBe("Failure");
    }).pipe(Effect.provide(PlatformServices)),
  );

  it.effect(
    "allows dots in ignore names but rejects parent-segment patterns",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectory({
          prefix: "alchemy-prisma-compute-ignore-validation-",
        });
        yield* fs.writeFileString(path.join(root, "server.ts"), "safe");
        yield* fs.writeFileString(path.join(root, "foo..bar"), "ignored");

        const archive = yield* createComputeArchive({
          directory: root,
          entrypoint: "server.ts",
          ignore: ["foo..bar"],
        });
        const names = parseTar(
          yield* Effect.sync(() => gunzipSync(archive)),
        ).map((entry) => entry.name);
        const unsafe = yield* Effect.exit(
          createComputeArchive({
            directory: root,
            entrypoint: "server.ts",
            ignore: ["../outside"],
          }),
        );

        expect(names).not.toContain("bundle/foo..bar");
        expect(unsafe._tag).toBe("Failure");
      }).pipe(Effect.provide(PlatformServices)),
  );

  it.effect("reports invalid archive limits as typed errors", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({
        prefix: "alchemy-prisma-compute-invalid-limit-",
      });
      yield* fs.writeFileString(path.join(root, "server.ts"), "safe");

      const error = yield* createComputeArchive({
        directory: root,
        entrypoint: "server.ts",
        maxEntries: 0,
      }).pipe(Effect.flip);

      expect(error).toBeInstanceOf(Error);
      expect(error.message).toContain("maxEntries");
    }).pipe(Effect.provide(PlatformServices)),
  );

  it.effect("does not allow callers to raise production safety ceilings", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({
        prefix: "alchemy-prisma-compute-hard-limit-",
      });
      yield* fs.writeFileString(path.join(root, "server.ts"), "safe");

      const entriesError = yield* createComputeArchive({
        directory: root,
        entrypoint: "server.ts",
        maxEntries: 50_001,
      }).pipe(Effect.flip);
      const fileError = yield* createComputeArchive({
        directory: root,
        entrypoint: "server.ts",
        maxFileBytes: 128 * 1024 * 1024 + 1,
      }).pipe(Effect.flip);
      const totalError = yield* createComputeArchive({
        directory: root,
        entrypoint: "server.ts",
        maxUncompressedBytes: 256 * 1024 * 1024 + 1,
      }).pipe(Effect.flip);

      expect(entriesError.message).toContain("hard limit");
      expect(fileError.message).toContain("hard limit");
      expect(totalError.message).toContain("hard limit");
    }).pipe(Effect.provide(PlatformServices)),
  );

  it.effect(
    "creates a verified file-backed archive with explicit cleanup",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectory({
          prefix: "alchemy-prisma-compute-file-archive-",
        });
        yield* fs.writeFileString(path.join(root, "server.ts"), "safe");

        const archive = yield* createComputeArchive({
          directory: root,
          entrypoint: "server.ts",
          output: "file",
        });
        const bytes = yield* fs.readFile(archive.path);
        const names = parseTar(yield* Effect.sync(() => gunzipSync(bytes))).map(
          (entry) => entry.name,
        );

        expect(archive.size).toBe(bytes.byteLength);
        expect(archive.sha256).toMatch(/^[a-f0-9]{64}$/);
        expect(names).toContain("bundle/server.ts");
        expect(yield* fs.exists(archive.path)).toBe(true);
        yield* archive.cleanup;
        expect(yield* fs.exists(archive.path)).toBe(false);
      }).pipe(Effect.provide(PlatformServices)),
  );

  it.effect("fails explicitly for oversized files and archives", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({
        prefix: "alchemy-prisma-compute-limit-",
      });
      yield* fs.writeFileString(path.join(root, "server.ts"), "12345");
      yield* fs.writeFileString(path.join(root, "other.ts"), "67890");

      const fileResult = yield* Effect.exit(
        createComputeArchive({
          directory: root,
          entrypoint: "server.ts",
          maxFileBytes: 4,
        }),
      );
      const totalResult = yield* Effect.exit(
        createComputeArchive({
          directory: root,
          entrypoint: "server.ts",
          maxFileBytes: 10,
          maxUncompressedBytes: 9,
        }),
      );

      expect(fileResult._tag).toBe("Failure");
      expect(totalResult._tag).toBe("Failure");
    }).pipe(Effect.provide(PlatformServices)),
  );

  it.effect("rejects symlink targets that cannot fit the tar format", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({
        prefix: "alchemy-prisma-compute-long-link-",
      });
      const segments = Array.from(
        { length: 12 },
        (_, index) => `segment-${index.toString().padStart(2, "0")}`,
      );
      const target = path.join(...segments, "target.ts");
      yield* fs.makeDirectory(path.join(root, ...segments), {
        recursive: true,
      });
      yield* fs.writeFileString(path.join(root, "server.ts"), "safe");
      yield* fs.writeFileString(path.join(root, target), "target");
      yield* fs.symlink(target, path.join(root, "long-link.ts"));

      const error = yield* createComputeArchive({
        directory: root,
        entrypoint: "server.ts",
      }).pipe(Effect.flip);

      expect(error).toBeInstanceOf(Error);
      expect(error.message).toContain("symlink target is too long");
    }).pipe(Effect.provide(PlatformServices)),
  );
});
