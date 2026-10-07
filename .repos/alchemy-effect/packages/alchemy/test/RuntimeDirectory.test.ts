import { watchBundleDirectory } from "@/Cloudflare/Workers/Sources/shared";
import * as Stream from "effect/Stream";
import { isPathWithin } from "@/Util/isPathWithin";
import { hashDirectory } from "@/Command/Memo";
import nextjsSource from "@alchemy.run/frontend-frameworks/nextjs/source";
import { readPythonWorkerBundle } from "@/Cloudflare/Workers/Sources/Python";
import { sha256 } from "@/Util/sha256";
import { AlchemyContext, dotAlchemyDirectory } from "@/AlchemyContext";
import { createTempBundleDir, getStableContextDir } from "@/Bundle/TempRoot";
import { WorkerBundle } from "@/Cloudflare/Workers/Sources/Rolldown";
import { createComputeArchive } from "@/Prisma/ComputeArchive";
import { Stack } from "@/Stack";
import { Stage } from "@/Stage";
import { localState } from "@/State/LocalState";
import { State } from "@/State/State";
import { copyTree, hashExtraFiles } from "@/Util/extraFiles";
import { PlatformServices } from "@/Util/PlatformServices";
import { expect, layer } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { gunzipSync } from "node:zlib";

layer(PlatformServices)("runtime directory", (it) => {
  it.effect(
    "compares paths against the supplied base without using the process cwd",
    () =>
      Effect.sync(() => {
        expect(
          isPathWithin(
            ".alchemy",
            "/workspace/app/.alchemy/bundles/worker.js",
            "/workspace/app",
          ),
        ).toBe(true);
        expect(
          isPathWithin(
            ".alchemy",
            "/workspace/app/.alchemy/bundles/worker.js",
            "/workspace/other",
          ),
        ).toBe(false);
        expect(isPathWithin(".alchemy", ".alchemy", "/workspace/app")).toBe(
          true,
        );
        expect(
          isPathWithin(
            ".alchemy",
            ".alchemy-backup/worker.js",
            "/workspace/app",
          ),
        ).toBe(false);
        expect(
          isPathWithin(".alchemy", ".alchemy/../source.js", "/workspace/app"),
        ).toBe(false);
        expect(
          isPathWithin("/runtime", "/runtime/worker.js", "/workspace/app"),
        ).toBe(true);
      }),
    { tags: ["unit", "local"] },
  );

  it.effect(
    "preserves the relative fallback and configured roots",
    () =>
      Effect.gen(function* () {
        expect(yield* dotAlchemyDirectory).toBe(".alchemy");
        expect(
          yield* dotAlchemyDirectory.pipe(
            Effect.provideService(AlchemyContext, {
              dotAlchemy: "node_modules/.cache/runtime",
              dev: false,
              adopt: false,
            }),
          ),
        ).toBe("node_modules/.cache/runtime");
        expect(
          isPathWithin(
            "/tmp/runtime",
            "/tmp/runtime-sibling/file",
            process.cwd(),
          ),
        ).toBe(false);
        expect(
          isPathWithin("/tmp/runtime", "/tmp/runtime/file", process.cwd()),
        ).toBe(true);
      }),
    { tags: ["unit", "local"] },
  );

  it.effect(
    "ignores runtime watch events using the caller base rather than the watched directory",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped();
        const runtime = path.join(root, "runtime");
        const main = path.join(root, "worker.py");
        yield* fs.writeFileString(main, "class Default: pass");
        for (const [eventPath, expected] of [
          ["runtime/state.json", ["Success"]],
          ["worker.py", ["Success", "Start", "Success"]],
        ] as const) {
          const events = yield* watchBundleDirectory({
            main,
            read: Effect.succeed({
              files: [
                {
                  path: "worker.py",
                  content: "class Default: pass",
                  hash: "test",
                },
              ],
              hash: "test",
            }),
          }).pipe(
            Stream.runCollect,
            Effect.provideService(FileSystem.FileSystem, {
              ...fs,
              watch: () =>
                Stream.make({ _tag: "Update" as const, path: eventPath }),
            }),
            Effect.provideService(AlchemyContext, {
              dotAlchemy: path.relative(process.cwd(), runtime),
              dev: false,
              adopt: false,
            }),
          );
          expect(events.map((event) => event._tag)).toEqual(expected);
        }
      }),
    {
      tags: [
        "unit",
        "provider:cloudflare",
        "provider:cloudflare:worker",
        "local",
      ],
    },
  );

  it.effect(
    "writes Worker bundles under the context and honors an explicit output directory",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped();
        const runtime = path.join(root, "node_modules/.cache/runtime");
        const main = path.join(root, "worker.mjs");
        yield* fs.writeFileString(path.join(root, "package.json"), "{}");
        yield* fs.writeFileString(
          main,
          'export default { fetch: () => new Response("ok") };',
        );
        const bundler = yield* WorkerBundle.pipe(
          Effect.provideService(AlchemyContext, {
            dotAlchemy: runtime,
            dev: false,
            adopt: false,
          }),
        );
        for (const override of [undefined, path.join(root, "explicit")]) {
          const bundle = yield* bundler.build({
            id: "test",
            main,
            compatibility: { date: "2026-03-17", flags: [] },
            entry: { kind: "external" },
            stack: { name: "test", stage: "test" },
            extraOptions: override ? { output: { dir: override } } : undefined,
          });
          const directory = override ?? path.join(runtime, "bundles/test");
          expect(bundle.files.length).toBeGreaterThan(0);
          expect((yield* fs.readDirectory(directory)).length).toBeGreaterThan(
            0,
          );
        }
        expect(yield* fs.exists(path.join(root, ".alchemy"))).toBe(false);
      }),
    {
      tags: [
        "unit",
        "provider:cloudflare",
        "provider:cloudflare:worker",
        "local",
      ],
    },
  );

  it.effect(
    "keeps standalone and configured relative Worker output paths relative to the bundle cwd",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped();
        const main = path.join(root, "worker.mjs");
        yield* fs.writeFileString(path.join(root, "package.json"), "{}");
        yield* fs.writeFileString(
          main,
          'export default { fetch: () => new Response("ok") };',
        );
        for (const configured of [undefined, "custom/runtime"]) {
          const bundler = yield* configured === undefined
            ? WorkerBundle
            : WorkerBundle.pipe(
                Effect.provideService(AlchemyContext, {
                  dotAlchemy: configured,
                  dev: false,
                  adopt: false,
                }),
              );
          yield* bundler.build({
            id: "relative",
            main,
            compatibility: { date: "2026-03-17", flags: [] },
            entry: { kind: "external" },
            stack: { name: "test", stage: "test" },
            extraOptions: undefined,
          });
          expect(
            (yield* fs.readDirectory(
              path.join(root, configured ?? ".alchemy", "bundles/relative"),
            )).length,
          ).toBeGreaterThan(0);
        }
      }),
    {
      tags: [
        "unit",
        "provider:cloudflare",
        "provider:cloudflare:worker",
        "local",
      ],
    },
  );

  it.effect(
    "keeps temporary and stable container contexts under the full configured path",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped();
        const runtime = path.join(root, "node_modules/.cache/runtime");
        yield* Effect.gen(function* () {
          const stable = yield* getStableContextDir(
            path.join(root, "entry.ts"),
            runtime,
            "image",
          );
          const temporary = yield* createTempBundleDir(
            path.join(root, "entry.ts"),
            runtime,
            "image",
          );
          expect(stable).toBe(path.join(runtime, "tmp/test-dev-image"));
          const relative = path.relative(process.cwd(), runtime);
          expect(
            yield* getStableContextDir(
              path.join(root, "entry.ts"),
              relative,
              "image",
            ),
          ).toBe(path.join(relative, "tmp/test-dev-image"));
          expect(isPathWithin(runtime, temporary, process.cwd())).toBe(true);
          expect(yield* fs.exists(temporary)).toBe(true);
        }).pipe(
          Effect.provideService(Stack, {
            name: "test",
            stage: "dev",
            resources: {},
            bindings: {},
            actions: {},
          }),
          Effect.provideService(Stage, "dev"),
        );
      }),
    { tags: ["unit", "local"] },
  );

  it.effect(
    "captures the configured root for a lazily initialized local state store",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped();
        const getStore = yield* State.pipe(
          Effect.provide(localState()),
          Effect.provideService(AlchemyContext, {
            dotAlchemy: root,
            dev: false,
            adopt: false,
          }),
        );
        const store = yield* getStore;
        yield* store.setOutput({
          stack: "runtime-directory",
          stage: "test",
          value: { value: 42 },
        });
        expect(
          yield* store.getOutput({ stack: "runtime-directory", stage: "test" }),
        ).toEqual({ value: 42 });
        expect(yield* fs.exists(path.join(root, "state"))).toBe(true);
      }),
    { tags: ["unit", "local"] },
  );

  it.effect(
    "excludes relocated runtime data from copies, hashes, and compute archives",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped();
        const runtime = path.join(root, "cache[private]");
        yield* fs.makeDirectory(runtime);
        yield* fs.writeFileString(
          path.join(root, "index.js"),
          "export default 42;",
        );
        yield* fs.writeFileString(
          path.join(runtime, "secret.txt"),
          "PRIVATE_RUNTIME_DATA",
        );
        yield* Effect.gen(function* () {
          const artifactBefore = yield* hashDirectory({
            cwd: runtime,
            memo: { exclude: [], lockfile: false },
          });
          const before = yield* hashExtraFiles([{ source: root, dest: "." }]);
          yield* fs.writeFileString(
            path.join(runtime, "secret.txt"),
            "CHANGED_PRIVATE_RUNTIME_DATA",
          );
          expect(
            yield* hashDirectory({
              cwd: runtime,
              memo: { exclude: [], lockfile: false },
            }),
          ).not.toBe(artifactBefore);
          expect(yield* hashExtraFiles([{ source: root, dest: "." }])).toEqual(
            before,
          );
          const target = yield* fs.makeTempDirectoryScoped();
          yield* copyTree(root, target);
          expect(yield* fs.exists(path.join(target, "cache[private]"))).toBe(
            false,
          );
          expect(yield* fs.exists(path.join(target, "index.js"))).toBe(true);
          const archive = yield* createComputeArchive({
            directory: root,
            entrypoint: "index.js",
          });
          expect(gunzipSync(archive).toString()).not.toContain(
            "PRIVATE_RUNTIME_DATA",
          );
        }).pipe(
          Effect.provideService(AlchemyContext, {
            dotAlchemy: path.relative(process.cwd(), runtime),
            dev: false,
            adopt: false,
          }),
        );
      }),
    { tags: ["unit", "provider:prisma", "provider:prisma:compute", "local"] },
  );
  it.effect(
    "reads Python dependency caches from the configured root without including them as source",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped();
        const runtime = path.join(root, "runtime");
        const staging = path.join(runtime, "python/test");
        yield* fs.makeDirectory(path.join(staging, "python_modules"), {
          recursive: true,
        });
        yield* fs.writeFileString(
          path.join(root, "worker.py"),
          "class Default: pass",
        );
        yield* fs.writeFileString(
          path.join(staging, "python_modules/cached.py"),
          "CACHED_DEPENDENCY = True",
        );
        yield* fs.writeFileString(
          path.join(runtime, "private.py"),
          "PRIVATE_RUNTIME_DATA = True",
        );
        yield* fs.writeFileString(
          path.join(staging, ".synced"),
          yield* sha256("3.13\0https://index.pyodide.org/0.28.3\0"),
        );
        const bundle = yield* readPythonWorkerBundle({
          id: "test",
          fqn: "test",
          main: path.join(root, "worker.py"),
          compatibility: { date: "2026-03-17", flags: ["python_workers"] },
        }).pipe(
          Effect.provideService(AlchemyContext, {
            dotAlchemy: runtime,
            dev: false,
            adopt: false,
          }),
        );
        expect(
          bundle.files.some((file) => file.path.includes("cached.py")),
        ).toBe(true);
        expect(
          bundle.files.some((file) => file.path.includes("private.py")),
        ).toBe(false);
        expect(yield* fs.exists(path.join(root, ".alchemy"))).toBe(false);
      }),
    {
      tags: [
        "unit",
        "provider:cloudflare",
        "provider:cloudflare:worker",
        "local",
      ],
    },
  );

  it.effect(
    "excludes the supplied runtime directory from Next.js source hashes",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped();
        const runtime = path.join(root, "runtime");
        yield* fs.makeDirectory(runtime);
        yield* fs.writeFileString(
          path.join(root, "app.js"),
          "export default 42;",
        );
        const provider = yield* nextjsSource.make({ root });
        const context = {
          id: "test",
          workerName: "test",
          compatibility: { date: "2026-03-17", flags: [] },
          dotAlchemy: runtime,
        };
        const before = yield* provider.hash(context, undefined);
        yield* fs.writeFileString(path.join(runtime, "state.json"), "{}");
        expect(yield* provider.hash(context, undefined)).toEqual(before);
        yield* fs.writeFileString(
          path.join(root, "app.js"),
          "export default 43;",
        );
        expect(yield* provider.hash(context, undefined)).not.toEqual(before);
      }),
    { tags: ["unit", "local"] },
  );
});
