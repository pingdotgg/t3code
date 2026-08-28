import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopWslServerTree from "./DesktopWslServerTree.ts";

// The service reads packaged Windows roots through the (asar-aware, in
// Electron) fs, so a plain directory named server.asar exercises the full
// extraction path under plain Node.

const environmentLayer = (input: {
  readonly baseDir: string;
  readonly resourcesPath: string;
  readonly appVersion?: string;
  readonly isPackaged?: boolean;
}) =>
  DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/src",
    homeDirectory: input.baseDir,
    platform: "win32",
    processArch: "x64",
    appVersion: input.appVersion ?? "1.2.3",
    appPath: "/repo",
    isPackaged: input.isPackaged ?? true,
    resourcesPath: input.resourcesPath,
    runningUnderArm64Translation: false,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        DesktopConfig.layerTest({
          T3CODE_HOME: input.baseDir,
          T3CODE_MODE: "desktop",
        }),
      ),
    ),
  );

const withTempDir = <A, E, R>(
  run: (tempDir: string) => Effect.Effect<A, E, R>,
): Effect.Effect<
  A,
  E | PlatformError.PlatformError,
  FileSystem.FileSystem | Exclude<R, Scope.Scope>
> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const tempDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-wsl-server-tree-test-",
    });
    return yield* run(tempDir);
  }).pipe(Effect.scoped);

const ensureWith = (input: {
  readonly baseDir: string;
  readonly resourcesPath: string;
  readonly appVersion?: string;
  readonly isPackaged?: boolean;
}) =>
  Effect.gen(function* () {
    const tree = yield* DesktopWslServerTree.DesktopWslServerTree;
    return yield* tree.ensure;
  }).pipe(
    Effect.provide(DesktopWslServerTree.layer.pipe(Layer.provideMerge(environmentLayer(input)))),
  );

describe("DesktopWslServerTree", () => {
  it.effect("bounds entry work across an eight-way nested tree", () =>
    Effect.gen(function* () {
      const active = yield* Ref.make(0);
      const maxActive = yield* Ref.make(0);
      const visited = yield* Ref.make(0);

      yield* DesktopWslServerTree.forEachBoundedTree([{ depth: 0, id: "root" }], (node) =>
        Effect.acquireUseRelease(
          Effect.gen(function* () {
            const current = yield* Ref.updateAndGet(active, (count) => count + 1);
            yield* Ref.update(maxActive, (maximum) => Math.max(maximum, current));
            yield* Ref.update(visited, (count) => count + 1);
          }),
          () =>
            Effect.gen(function* () {
              // Give every task in the current batch a chance to overlap.
              yield* Effect.yieldNow;
              if (node.depth === 4) return [];
              return Array.from({ length: 8 }, (_, index) => ({
                depth: node.depth + 1,
                id: `${node.id}.${String(index)}`,
              }));
            }),
          () => Ref.update(active, (count) => count - 1),
        ),
      );

      assert.equal(yield* Ref.get(active), 0);
      assert.equal(yield* Ref.get(maxActive), 8);
      assert.equal(yield* Ref.get(visited), 4_681);
    }),
  );

  it.effect("returns the server root unchanged when it is a plain directory (dev)", () =>
    withTempDir((tempDir) =>
      Effect.gen(function* () {
        const result = yield* ensureWith({
          baseDir: tempDir,
          resourcesPath: tempDir,
          isPackaged: false,
        });
        assert.isTrue(result.ok);
        assert.isFalse(result.ok && result.root.endsWith(".asar"));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("extracts an archive root into a version-keyed state directory", () =>
    withTempDir((tempDir) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const serverRoot = path.join(tempDir, "resources", "server.asar");
        yield* fileSystem.makeDirectory(path.join(serverRoot, "apps/server/dist"), {
          recursive: true,
        });
        yield* fileSystem.writeFileString(
          path.join(serverRoot, "apps/server/dist/bin.mjs"),
          "server-entry",
        );
        yield* fileSystem.makeDirectory(path.join(serverRoot, "node_modules/effect"), {
          recursive: true,
        });
        yield* fileSystem.writeFileString(
          path.join(serverRoot, "node_modules/effect/package.json"),
          "{}",
        );

        const result = yield* ensureWith({
          baseDir: tempDir,
          resourcesPath: path.join(tempDir, "resources"),
        });

        assert.isTrue(result.ok);
        const root = result.ok ? result.root : "";
        assert.include(root, path.join("wsl-server-tree", "1.2.3"));
        const entry = yield* fileSystem.readFileString(path.join(root, "apps/server/dist/bin.mjs"));
        assert.equal(entry, "server-entry");
        const dep = yield* fileSystem.exists(path.join(root, "node_modules/effect/package.json"));
        assert.isTrue(dep);
        const marker = yield* fileSystem.readFileString(
          path.join(root, "t3code-wsl-server-tree.json"),
        );
        assert.include(marker, '"version":"1.2.3"');
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("serializes concurrent extraction callers and publishes one complete tree", () =>
    withTempDir((tempDir) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const resourcesPath = path.join(tempDir, "resources");
        const serverRoot = path.join(resourcesPath, "server.asar");
        yield* fileSystem.makeDirectory(path.join(serverRoot, "apps/server/dist"), {
          recursive: true,
        });
        yield* fileSystem.writeFileString(
          path.join(serverRoot, "apps/server/dist/bin.mjs"),
          "server-entry",
        );

        const results = yield* Effect.gen(function* () {
          const tree = yield* DesktopWslServerTree.DesktopWslServerTree;
          return yield* Effect.all([tree.ensure, tree.ensure], { concurrency: "unbounded" });
        }).pipe(
          Effect.provide(
            DesktopWslServerTree.layer.pipe(
              Layer.provideMerge(environmentLayer({ baseDir: tempDir, resourcesPath })),
            ),
          ),
        );

        assert.isTrue(results.every((result) => result.ok));
        const roots = results.flatMap((result) => (result.ok ? [result.root] : []));
        assert.lengthOf(new Set(roots), 1);
        assert.equal(
          yield* fileSystem.readFileString(path.join(roots[0] ?? "", "apps/server/dist/bin.mjs")),
          "server-entry",
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reuses a completed extraction instead of copying again", () =>
    withTempDir((tempDir) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const serverRoot = path.join(tempDir, "resources", "server.asar");
        yield* fileSystem.makeDirectory(path.join(serverRoot, "apps/server/dist"), {
          recursive: true,
        });
        yield* fileSystem.writeFileString(path.join(serverRoot, "apps/server/dist/bin.mjs"), "v1");

        const first = yield* ensureWith({
          baseDir: tempDir,
          resourcesPath: path.join(tempDir, "resources"),
        });
        assert.isTrue(first.ok);

        // Mutate the source; a reused tree must keep the first copy.
        yield* fileSystem.writeFileString(
          path.join(serverRoot, "apps/server/dist/bin.mjs"),
          "v2-should-not-appear",
        );
        const second = yield* ensureWith({
          baseDir: tempDir,
          resourcesPath: path.join(tempDir, "resources"),
        });
        assert.isTrue(second.ok);
        const root = second.ok ? second.root : "";
        const entry = yield* fileSystem.readFileString(path.join(root, "apps/server/dist/bin.mjs"));
        assert.equal(entry, "v1");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("sweeps stale version directories and leftover partials after extraction", () =>
    withTempDir((tempDir) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const serverRoot = path.join(tempDir, "resources", "server.asar");
        yield* fileSystem.makeDirectory(path.join(serverRoot, "apps/server/dist"), {
          recursive: true,
        });
        yield* fileSystem.writeFileString(path.join(serverRoot, "apps/server/dist/bin.mjs"), "x");

        // T3CODE_HOME is set to tempDir, so the desktop state dir resolves to
        // <tempDir>/userdata (no .t3 segment).
        const treeRoot = path.join(tempDir, "userdata", "wsl-server-tree");
        yield* fileSystem.makeDirectory(path.join(treeRoot, "1.0.0"), { recursive: true });
        yield* fileSystem.makeDirectory(path.join(treeRoot, "1.2.3.partial"), { recursive: true });

        const result = yield* ensureWith({
          baseDir: tempDir,
          resourcesPath: path.join(tempDir, "resources"),
        });
        assert.isTrue(result.ok);
        assert.isFalse(yield* fileSystem.exists(path.join(treeRoot, "1.0.0")));
        assert.isFalse(yield* fileSystem.exists(path.join(treeRoot, "1.2.3.partial")));
        assert.isTrue(yield* fileSystem.exists(path.join(treeRoot, "1.2.3")));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("re-extracts when the app version changes", () =>
    withTempDir((tempDir) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const serverRoot = path.join(tempDir, "resources", "server.asar");
        yield* fileSystem.makeDirectory(path.join(serverRoot, "apps/server/dist"), {
          recursive: true,
        });
        yield* fileSystem.writeFileString(path.join(serverRoot, "apps/server/dist/bin.mjs"), "old");

        const first = yield* ensureWith({
          baseDir: tempDir,
          resourcesPath: path.join(tempDir, "resources"),
          appVersion: "1.2.3",
        });
        assert.isTrue(first.ok);

        yield* fileSystem.writeFileString(path.join(serverRoot, "apps/server/dist/bin.mjs"), "new");
        const second = yield* ensureWith({
          baseDir: tempDir,
          resourcesPath: path.join(tempDir, "resources"),
          appVersion: "1.2.4",
        });
        assert.isTrue(second.ok);
        const root = second.ok ? second.root : "";
        assert.include(root, "1.2.4");
        const entry = yield* fileSystem.readFileString(path.join(root, "apps/server/dist/bin.mjs"));
        assert.equal(entry, "new");
        // The previous version's tree is gone.
        const treeRoot = path.dirname(root);
        assert.isFalse(yield* fileSystem.exists(path.join(treeRoot, "1.2.3")));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("removes the legacy Windows extraction tree without preparing a fallback", () =>
    withTempDir((tempDir) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const resourcesPath = path.join(tempDir, "resources");
        const treeRoot = path.join(tempDir, "userdata", "wsl-server-tree");
        yield* fileSystem.makeDirectory(path.join(treeRoot, "1.2.3"), { recursive: true });
        yield* fileSystem.writeFileString(path.join(treeRoot, "1.2.3", "legacy"), "old");

        yield* Effect.gen(function* () {
          const tree = yield* DesktopWslServerTree.DesktopWslServerTree;
          yield* tree.cleanupLegacy;
        }).pipe(
          Effect.provide(
            DesktopWslServerTree.layer.pipe(
              Layer.provideMerge(environmentLayer({ baseDir: tempDir, resourcesPath })),
            ),
          ),
        );

        assert.isFalse(yield* fileSystem.exists(treeRoot));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("re-extracts after legacy cleanup partially deletes the completed tree", () =>
    withTempDir((tempDir) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const resourcesPath = path.join(tempDir, "resources");
        const serverRoot = path.join(resourcesPath, "server.asar");
        const sourceEntryPath = path.join(serverRoot, "apps/server/dist/bin.mjs");
        yield* fileSystem.makeDirectory(path.dirname(sourceEntryPath), { recursive: true });
        yield* fileSystem.writeFileString(sourceEntryPath, "fresh-server-entry");

        const initial = yield* ensureWith({ baseDir: tempDir, resourcesPath });
        assert.isTrue(initial.ok);
        const versionDir = initial.ok ? initial.root : "";
        const treeRoot = path.dirname(versionDir);
        const extractedEntryPath = path.join(versionDir, "apps/server/dist/bin.mjs");
        let cleanupFailed = false;
        const partialCleanupFileSystem = Layer.effect(
          FileSystem.FileSystem,
          Effect.gen(function* () {
            const realFileSystem = yield* FileSystem.FileSystem;
            return {
              ...realFileSystem,
              remove: (target, options) =>
                String(target) === treeRoot && options?.recursive === true && !cleanupFailed
                  ? Effect.gen(function* () {
                      cleanupFailed = true;
                      yield* realFileSystem.remove(extractedEntryPath);
                      return yield* PlatformError.systemError({
                        _tag: "PermissionDenied",
                        module: "FileSystem",
                        method: "remove",
                        pathOrDescriptor: treeRoot,
                        description: "simulated partial legacy cleanup",
                      });
                    })
                  : realFileSystem.remove(target, options),
            } satisfies FileSystem.FileSystem;
          }),
        ).pipe(Layer.provide(NodeServices.layer));

        const result = yield* Effect.gen(function* () {
          const tree = yield* DesktopWslServerTree.DesktopWslServerTree;
          yield* tree.cleanupLegacy;
          return yield* tree.ensure;
        }).pipe(
          Effect.provide(
            DesktopWslServerTree.layer.pipe(
              Layer.provideMerge(environmentLayer({ baseDir: tempDir, resourcesPath })),
              Layer.provideMerge(partialCleanupFileSystem),
            ),
          ),
        );

        assert.isTrue(cleanupFailed);
        assert.isTrue(result.ok);
        assert.equal(yield* fileSystem.readFileString(extractedEntryPath), "fresh-server-entry");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reports a retryable failure when the archive cannot be read", () =>
    withTempDir((tempDir) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const result = yield* ensureWith({
          baseDir: tempDir,
          // resources dir exists but server.asar does not
          resourcesPath: path.join(tempDir, "resources"),
        });
        assert.isFalse(result.ok);
        if (!result.ok) {
          assert.include(result.reason, "could not be extracted");
          assert.isFalse(result.fatal);
        }
        const treeRoot = path.join(tempDir, "userdata", "wsl-server-tree");
        const leftovers = yield* fileSystem
          .readDirectory(treeRoot)
          .pipe(Effect.orElseSucceed(() => []));
        assert.deepStrictEqual(leftovers, []);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});
