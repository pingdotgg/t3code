import { hashDockerBuildInputs, selectDockerBuildContext } from "@alchemy.run/docker/BuildHash";
import { expect, layer } from "@alchemy.run/test";
import { BunServices } from "@effect/platform-bun";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Result from "effect/Result";

const sourceFor = (root: string) => ({
  context: root,
  dockerfile: "Dockerfile",
  platform: "linux/amd64",
  buildArgs: { Z: "last", A: "first" },
});

const makeContext = Effect.fn(function* (ignore = "") {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({
    prefix: "alchemy-build-hash-",
  });
  yield* fs.makeDirectory(path.join(root, "src"), { recursive: true });
  yield* fs.writeFileString(path.join(root, "Dockerfile"), "FROM scratch\nCOPY src /src\n");
  yield* fs.writeFileString(path.join(root, ".dockerignore"), ignore);
  return { root, fs, path };
});

const guardedReadDirectories = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  root: string,
  forbidden: ReadonlyArray<string>,
) => {
  const reads: string[] = [];
  const guarded: FileSystem.FileSystem = {
    ...fs,
    readDirectory: (directory, options) => {
      const relative = path.relative(root, directory) || ".";
      reads.push(relative);
      if (forbidden.some((entry) => relative === entry || relative.startsWith(`${entry}/`))) {
        return Effect.die(new Error(`pruned directory was descended into: ${relative}`));
      }
      return fs.readDirectory(directory, options);
    },
  };
  return { guarded, reads };
};

const hashWithGuard = (
  root: string,
  fs: FileSystem.FileSystem,
  path: Path.Path,
  forbidden: ReadonlyArray<string>,
  mode: "all" | "effective" = "effective",
  source: ReturnType<typeof sourceFor> = sourceFor(root),
) => {
  const { guarded, reads } = guardedReadDirectories(fs, path, root, forbidden);
  return {
    reads,
    hash: hashDockerBuildInputs(source, mode).pipe(
      Effect.provideService(FileSystem.FileSystem, guarded),
    ),
  };
};

layer(BunServices.layer)("Docker build hash traversal", (test) => {
  // The user-visible failure: a folder Docker never sends (excluded by
  // `.dockerignore`) that the deploying user cannot read, e.g. a root-owned
  // database bind mount. Hashing used to walk into it and fail with EACCES.
  test.effect(
    "hashes a context whose ignored folder is unreadable",
    () =>
      Effect.gen(function* () {
        const { root, fs, path } = yield* makeContext("data/\n");
        const locked = path.join(root, "data", "postgres");
        yield* fs.makeDirectory(locked, { recursive: true });
        yield* fs.writeFileString(path.join(locked, "pg_hba.conf"), "local all all trust\n");
        yield* Effect.acquireRelease(fs.chmod(locked, 0o000), () =>
          fs.chmod(locked, 0o755).pipe(Effect.ignore),
        );

        const hash = yield* hashDockerBuildInputs(sourceFor(root), "effective");
        expect(hash).toMatch(/^[0-9a-f]+$/);
      }),
    { tags: ["unit", "provider:docker", "local"] },
  );

  test.effect(
    "does not descend into an ignored subtree",
    () =>
      Effect.gen(function* () {
        const { root, fs, path } = yield* makeContext("ignored/\n");
        yield* fs.makeDirectory(path.join(root, "ignored", "deep"), {
          recursive: true,
        });
        yield* fs.writeFileString(path.join(root, "ignored", "deep", "not-read"), "x");
        const { hash, reads } = hashWithGuard(root, fs, path, ["ignored"]);
        yield* hash;
        expect(reads).toContain(".");
        expect(reads).not.toContain("ignored");
      }),
    { tags: ["unit", "provider:docker", "local"] },
  );

  test.effect(
    "prunes Finn-style allowlists while traversing the required subtree",
    () =>
      Effect.gen(function* () {
        const { root, fs, path } = yield* makeContext("**\n!required/**\n**/node_modules\n");
        yield* fs.makeDirectory(path.join(root, "required", "source", "nested"), {
          recursive: true,
        });
        yield* fs.makeDirectory(path.join(root, "other", "nested"), {
          recursive: true,
        });
        yield* fs.makeDirectory(path.join(root, "required", "node_modules", "nested"), {
          recursive: true,
        });
        yield* fs.writeFileString(path.join(root, "required", "source", "nested", "kept"), "kept");
        yield* fs.writeFileString(path.join(root, "other", "nested", "not-read"), "ignored");
        yield* fs.writeFileString(
          path.join(root, "required", "node_modules", "nested", "not-read"),
          "ignored",
        );
        const { hash, reads } = hashWithGuard(root, fs, path, ["other", "required/node_modules"]);
        yield* hash;
        expect(reads).toContain("required");
        expect(reads).toContain("required/source");
        expect(reads).toContain("required/source/nested");
        expect(reads).not.toContain("other");
        expect(reads).not.toContain("required/node_modules");
        expect(
          reads.every((entry) =>
            [".", "required", "required/source", "required/source/nested"].includes(entry),
          ),
        ).toBe(true);
      }),
    { tags: ["unit", "provider:docker", "local"] },
  );

  test.effect(
    "walks a reincluded descendant, but not a negation shadowed by a later exclusion",
    () =>
      Effect.gen(function* () {
        const { root, fs, path } = yield* makeContext(
          "ignored/\n!ignored/keep/**\n!before/keep\nbefore/\n",
        );
        yield* fs.makeDirectory(path.join(root, "ignored", "keep", "deep"), {
          recursive: true,
        });
        yield* fs.makeDirectory(path.join(root, "ignored", "other"), {
          recursive: true,
        });
        yield* fs.makeDirectory(path.join(root, "before", "keep"), {
          recursive: true,
        });
        yield* fs.writeFileString(path.join(root, "ignored", "keep", "deep", "kept"), "kept");
        yield* fs.writeFileString(path.join(root, "ignored", "other", "not-read"), "ignored");
        yield* fs.writeFileString(path.join(root, "before", "keep", "not-read"), "shadowed");
        const { hash, reads } = hashWithGuard(root, fs, path, ["before", "ignored/other"]);
        yield* hash;
        expect(reads).toContain("ignored");
        expect(reads).toContain("ignored/keep");
        expect(reads).toContain("ignored/keep/deep");
        expect(reads).not.toContain("ignored/other");
        expect(reads).not.toContain("before");
      }),
    { tags: ["unit", "provider:docker", "local"] },
  );

  test.effect(
    "handles nested and basename patterns without pruning a possible match",
    () =>
      Effect.gen(function* () {
        const { root, fs, path } = yield* makeContext("**/cache\n*.secret\n");
        yield* fs.makeDirectory(path.join(root, "a", "cache", "deep"), {
          recursive: true,
        });
        yield* fs.makeDirectory(path.join(root, "b", "keep"), {
          recursive: true,
        });
        yield* fs.writeFileString(path.join(root, "a", "cache", "deep", "not-read"), "ignored");
        yield* fs.writeFileString(path.join(root, "b", "keep", "visible.txt"), "visible");
        yield* fs.writeFileString(path.join(root, "b", "keep", "hidden.secret"), "ignored");
        const { hash, reads } = hashWithGuard(root, fs, path, ["a/cache"]);
        yield* hash;
        expect(reads).not.toContain("a/cache");
        expect(reads).toContain("b");
        expect(reads).toContain("b/keep");
      }),
    { tags: ["unit", "provider:docker", "local"] },
  );

  test.effect(
    "forces a Dockerfile and its selected ignore file below a pruned directory",
    () =>
      Effect.gen(function* () {
        const { root, fs, path } = yield* makeContext("**\n");
        const nested = path.join(root, "pruned");
        yield* fs.makeDirectory(nested, { recursive: true });
        const dockerfile = path.join(nested, "Dockerfile");
        const selectedIgnore = path.join(nested, "Dockerfile.dockerignore");
        yield* fs.writeFileString(dockerfile, "FROM scratch\nCOPY . /app\n");
        yield* fs.writeFileString(selectedIgnore, "**\n");
        yield* fs.writeFileString(path.join(nested, "ignored.secret"), "ignored");
        const source = { ...sourceFor(root), dockerfile: "pruned/Dockerfile" };
        const selection = yield* selectDockerBuildContext(source);
        expect(selection.includes("pruned/Dockerfile")).toBe(true);
        expect(selection.includes("pruned/Dockerfile.dockerignore")).toBe(true);
        const { hash, reads } = hashWithGuard(root, fs, path, ["other"], "effective", source);
        const first = yield* hash;
        expect(reads).toContain("pruned");
        yield* fs.writeFileString(dockerfile, "FROM scratch\nCOPY pruned/ignored.secret /app\n");
        const second = yield* hashDockerBuildInputs(source, "effective");
        expect(second).not.toBe(first);
        yield* fs.writeFileString(selectedIgnore, "**\n# changed\n");
        const third = yield* hashDockerBuildInputs(source, "effective");
        expect(third).not.toBe(second);
      }),
    { tags: ["unit", "provider:docker", "local"] },
  );

  test.effect(
    "preserves symlink entries and empty directories",
    () =>
      Effect.gen(function* () {
        const { root, fs, path } = yield* makeContext();
        yield* fs.makeDirectory(path.join(root, "empty"), { recursive: true });
        yield* fs.writeFileString(path.join(root, "target-a"), "same");
        yield* fs.writeFileString(path.join(root, "target-b"), "same");
        yield* fs.symlink("target-a", path.join(root, "link"));
        const source = sourceFor(root);
        const before = yield* hashDockerBuildInputs(source, "effective");
        yield* fs.remove(path.join(root, "link"));
        yield* fs.symlink("target-b", path.join(root, "link"));
        const retargeted = yield* hashDockerBuildInputs(source, "effective");
        expect(retargeted).not.toBe(before);
        const link = yield* Effect.result(fs.readLink(path.join(root, "link")));
        expect(Result.isSuccess(link)).toBe(true);
        yield* fs.remove(path.join(root, "empty"), { recursive: true });
        const withoutEmptyDirectory = yield* hashDockerBuildInputs(source, "effective");
        expect(withoutEmptyDirectory).not.toBe(retargeted);
      }),
    { tags: ["unit", "provider:docker", "local"] },
  );

  test.effect(
    "does not duplicate a Dockerfile outside the context",
    () =>
      Effect.gen(function* () {
        const { root, fs, path } = yield* makeContext("Dockerfile\n**\n");
        const outside = yield* fs.makeTempDirectoryScoped({
          prefix: "alchemy-build-hash-dockerfile-",
        });
        const externalDockerfile = path.join(outside, "Dockerfile");
        yield* fs.writeFileString(path.join(root, "Dockerfile"), "context copy\n");
        yield* fs.writeFileString(externalDockerfile, "FROM scratch\n");
        const source = { ...sourceFor(root), dockerfile: externalDockerfile };
        const first = yield* hashDockerBuildInputs(source, "effective");
        yield* fs.writeFileString(path.join(root, "Dockerfile"), "different context copy\n");
        const second = yield* hashDockerBuildInputs(source, "effective");
        expect(second).toBe(first);
        yield* fs.writeFileString(externalDockerfile, "FROM alpine\n");
        const third = yield* hashDockerBuildInputs(source, "effective");
        expect(third).not.toBe(second);
      }),
    { tags: ["unit", "provider:docker", "local"] },
  );

  test.effect(
    "does not descend through a symlink to an external directory",
    () =>
      Effect.gen(function* () {
        const { root, fs, path } = yield* makeContext();
        const outside = yield* fs.makeTempDirectoryScoped({
          prefix: "alchemy-build-hash-external-",
        });
        yield* fs.writeFileString(path.join(outside, "not-read"), "external");
        yield* fs.symlink(outside, path.join(root, "external-link"));
        const { hash, reads } = hashWithGuard(root, fs, path, ["external-link"]);
        yield* hash;
        expect(reads).not.toContain("external-link");
      }),
    { tags: ["unit", "provider:docker", "local"] },
  );

  test.effect(
    "keeps raw mode and the pre-traversal hash golden stable",
    () =>
      Effect.gen(function* () {
        const { root, fs, path } = yield* makeContext("**\n!src\n!src/**\nnode_modules\n");
        yield* fs.makeDirectory(path.join(root, "empty"), { recursive: true });
        yield* fs.makeDirectory(path.join(root, "node_modules", "ignored", "deep"), {
          recursive: true,
        });
        yield* fs.writeFileString(path.join(root, "src", "main.txt"), "main\n");
        yield* fs.writeFileString(
          path.join(root, "node_modules", "ignored", "deep", "huge.txt"),
          "ignored\n",
        );
        const source = sourceFor(root);
        expect(yield* hashDockerBuildInputs(source, "all")).toBe(
          "d336bf3db2943311657f812d731ea71c",
        );
        expect(yield* hashDockerBuildInputs(source, "effective")).toBe(
          "91124478d665ef48e0af2670d271511b",
        );
      }),
    { tags: ["unit", "provider:docker", "local"] },
  );
});
