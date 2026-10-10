import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as Scope from "effect/Scope";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { describe, expect, it } from "vitest";
import { resolveConfigPath, runOpenNextBuild } from "../Runner.ts";
import source from "../source.ts";

const run = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    | FileSystem.FileSystem
    | Path.Path
    | Scope.Scope
    | ChildProcessSpawner.ChildProcessSpawner
  >,
) =>
  Effect.runPromise(
    Effect.scoped(effect).pipe(Effect.provide(NodeServices.layer)),
  );

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({
    directory: yield* path.fromFileUrl(new URL("../../../", import.meta.url)),
    prefix: ".nextjs-config-test-",
  });
  return { fs, path, root };
});

describe("optional OpenNext configuration", () => {
  it("generates defaults only when the native config is absent", () =>
    run(
      Effect.gen(function* () {
        const { fs, path, root } = yield* fixture;
        expect(yield* resolveConfigPath({ appDir: root })).toBeUndefined();
        expect(yield* fs.readDirectory(root)).toEqual([]);
        const configPath = path.join(root, "open-next.config.ts");
        yield* fs.writeFileString(
          configPath,
          "export default { default: {} };\n",
        );
        expect(yield* resolveConfigPath({ appDir: root })).toBe(configPath);
        expect(yield* fs.readFileString(configPath)).toBe(
          "export default { default: {} };\n",
        );
      }),
    ));

  it("prefers an explicit file and rejects a missing explicit path", () =>
    run(
      Effect.gen(function* () {
        const { fs, path, root } = yield* fixture;
        yield* fs.writeFileString(
          path.join(root, "open-next.config.ts"),
          "native",
        );
        yield* fs.writeFileString(path.join(root, "custom.mjs"), "custom");
        expect(
          yield* resolveConfigPath({ appDir: root, configPath: "custom.mjs" }),
        ).toBe(path.join(root, "custom.mjs"));
        const error = yield* resolveConfigPath({
          appDir: root,
          configPath: "missing.ts",
        }).pipe(Effect.flip);
        expect(error.message).toContain("OpenNext config file not found");
      }),
    ));

  it("rejects a directory instead of treating it as absent", () =>
    run(
      Effect.gen(function* () {
        const { fs, path, root } = yield* fixture;
        yield* fs.makeDirectory(path.join(root, "open-next.config.ts"));
        const error = yield* resolveConfigPath({ appDir: root }).pipe(
          Effect.flip,
        );
        expect(error.message).toContain("OpenNext config is not a file");
      }),
    ));

  it("hashes config creation, edits, and removal even outside a narrowed memo scope", () =>
    run(
      Effect.gen(function* () {
        const { fs, path, root } = yield* fixture;
        const provider = yield* source.make({
          root,
          memo: { include: ["app/**"] },
        });
        const context = {
          id: "Site",
          workerName: "site",
          compatibility: { date: "2026-08-31", flags: [] },
        };
        const hash = () => provider.hash(context, undefined);
        const absent = yield* hash();
        const configPath = path.join(root, "open-next.config.ts");
        yield* fs.writeFileString(
          configPath,
          "export default { default: {} };\n",
        );
        const created = yield* hash();
        expect(created.input).not.toBe(absent.input);
        expect((yield* hash()).input).toBe(created.input);
        const relocated = yield* fixture;
        yield* fs.writeFileString(
          relocated.path.join(relocated.root, "open-next.config.ts"),
          "export default { default: {} };\n",
        );
        const relocatedProvider = yield* source.make({
          root: relocated.root,
          memo: { include: ["app/**"] },
        });
        expect((yield* relocatedProvider.hash(context, undefined)).input).toBe(
          created.input,
        );
        yield* fs.writeFileString(
          configPath,
          "export default { default: { minify: true } };\n",
        );
        expect((yield* hash()).input).not.toBe(created.input);
        yield* fs.remove(configPath);
        expect((yield* hash()).input).toBe(absent.input);
      }),
    ));

  it("cleans parent-owned temporary configuration when the child fails", () =>
    run(
      Effect.gen(function* () {
        const { fs, root } = yield* fixture;
        const directories: string[] = [];
        const scratchFiles: string[] = [];
        const tracked = {
          ...fs,
          makeTempDirectoryScoped: (
            options?: Parameters<typeof fs.makeTempDirectoryScoped>[0],
          ) =>
            fs.makeTempDirectoryScoped(options).pipe(
              Effect.tap((directory) =>
                Effect.gen(function* () {
                  directories.push(directory);
                  yield* Effect.addFinalizer(() =>
                    fs.readDirectory(directory).pipe(
                      Effect.tap((files) =>
                        Effect.sync(() => {
                          scratchFiles.push(...files);
                        }),
                      ),
                      Effect.ignore,
                    ),
                  );
                }),
              ),
            ),
        };
        const error = yield* runOpenNextBuild({
          appDir: root,
          compatibilityDate: "2026-08-31",
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, tracked),
          Effect.flip,
        );
        expect(error._tag).toBe("RunnerError");
        expect(directories).toHaveLength(1);
        expect(scratchFiles).toContain("open-next.config.mjs");
        expect(
          scratchFiles.some((file) => file.startsWith("open-next-tmp")),
        ).toBe(true);
        for (const directory of directories)
          expect(yield* fs.exists(directory)).toBe(false);
      }),
    ));
});
