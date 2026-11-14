import { expect, layer } from "@alchemy.run/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { AlchemyContext } from "@/AlchemyContext";
import * as Bundle from "@/Bundle/Bundle";
import { ResourceContext } from "@/ResourceContext";
import { StackContext } from "@/StackContext";

/**
 * Creates a temporary package whose entry logs `marker` and lazily imports
 * `lazy.ts`, so the bundle has a content-hashed chunk. The directory is
 * removed when the test's scope closes, including on failure.
 */
const makeProject = (marker: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-bundle-output-" });
    const entry = path.join(root, "entry.ts");
    yield* fs.writeFileString(
      entry,
      `console.log(${JSON.stringify(marker)});\nexport const lazy = () => import("./lazy.ts");\n`,
    );
    yield* fs.writeFileString(path.join(root, "lazy.ts"), `export const value = "v1";\n`);
    return { root, entry };
  });

/**
 * Runs `effect` the way the engine runs a provider lifecycle operation: with
 * the resource's FQN, its stack, and a `.alchemy` directory under `root`.
 */
const inLifecycle =
  (root: string, fqn: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      return yield* effect.pipe(
        Effect.provide([
          Layer.succeed(ResourceContext, {
            logicalId: fqn.split("/").at(-1)!,
            fqn,
            instanceId: "00000000000000000000000000000000",
            type: "Test.Bundle",
          }),
          Layer.succeed(StackContext, {
            name: "BundleStack",
            stage: "test",
            resources: {},
            bindings: {},
            actions: {},
          }),
          Layer.succeed(AlchemyContext, {
            dotAlchemy: path.join(root, ".alchemy"),
            dev: false,
            adopt: false,
          }),
        ]),
      );
    });

layer(NodeServices.layer)("Bundle output location", (it) => {
  it.effect(
    "build keeps the bundle in memory outside a resource lifecycle",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { root, entry } = yield* makeProject("IN_MEMORY_MARKER");

        const result = yield* Bundle.build({ input: entry, cwd: root });

        expect(result.files[0].content).toContain("IN_MEMORY_MARKER");
        // Rolldown's default `dir` would have been `<root>/dist`.
        expect((yield* fs.readDirectory(root)).sort()).toEqual(["entry.ts", "lazy.ts"]);
      }).pipe(Effect.scoped),
    { tags: ["unit", "local"] },
  );

  it.effect(
    "build writes a resource's bundle to its own directory in .alchemy and clears stale chunks",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { root, entry } = yield* makeProject("LIFECYCLE_MARKER");
        const dir = path.join(root, ".alchemy", "bundles", "BundleStack-test-Api__Handler");
        const chunks = fs
          .readDirectory(dir)
          .pipe(Effect.map((files) => files.filter((file) => file.startsWith("lazy-"))));

        const first = yield* Bundle.build({ input: entry, cwd: root }).pipe(
          inLifecycle(root, "Api/Handler"),
        );
        expect(yield* fs.readFileString(path.join(dir, first.files[0].path))).toContain(
          "LIFECYCLE_MARKER",
        );
        const [firstChunk] = yield* chunks;
        expect(firstChunk).toBeDefined();

        yield* fs.writeFileString(path.join(root, "lazy.ts"), `export const value = "v2";\n`);
        yield* Bundle.build({ input: entry, cwd: root }).pipe(inLifecycle(root, "Api/Handler"));

        const secondChunks = yield* chunks;
        expect(secondChunks).toHaveLength(1);
        expect(secondChunks[0]).not.toBe(firstChunk);
        expect(yield* fs.exists(path.join(root, "dist"))).toBe(false);
      }).pipe(Effect.scoped),
    { tags: ["unit", "local"] },
  );

  it.effect(
    "build writes to the given dir and never clears it",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { root, entry } = yield* makeProject("ON_DISK_MARKER");
        const dir = path.join(root, "out");
        yield* fs.makeDirectory(dir);
        yield* fs.writeFileString(path.join(dir, "keep.txt"), "mine");

        const result = yield* Bundle.build(
          { input: entry, cwd: root },
          { dir, entryFileNames: "index.mjs" },
        ).pipe(inLifecycle(root, "Handler"));

        expect(result.files[0].path).toBe("index.mjs");
        expect(yield* fs.readFileString(path.join(dir, "index.mjs"))).toContain("ON_DISK_MARKER");
        expect(yield* fs.readFileString(path.join(dir, "keep.txt"))).toBe("mine");
        expect(yield* fs.exists(path.join(root, ".alchemy"))).toBe(false);
      }).pipe(Effect.scoped),
    { tags: ["unit", "local"] },
  );

  it.effect(
    "watch keeps the bundle in memory outside a resource lifecycle",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { root, entry } = yield* makeProject("WATCH_MARKER");

        const event = yield* firstWatchResult(Bundle.watch({ input: entry, cwd: root }));

        expect(event.output.files[0].content).toContain("WATCH_MARKER");
        expect((yield* fs.readDirectory(root)).sort()).toEqual(["entry.ts", "lazy.ts"]);
      }).pipe(Effect.scoped),
    { tags: ["unit", "local"] },
  );

  it.effect(
    "watch writes a resource's bundle to its own directory in .alchemy",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { root, entry } = yield* makeProject("WATCH_LIFECYCLE_MARKER");
        const dir = path.join(root, ".alchemy", "bundles", "BundleStack-test-Handler");

        const event = yield* firstWatchResult(Bundle.watch({ input: entry, cwd: root })).pipe(
          inLifecycle(root, "Handler"),
        );

        expect(yield* fs.readFileString(path.join(dir, event.output.files[0].path))).toContain(
          "WATCH_LIFECYCLE_MARKER",
        );
      }).pipe(Effect.scoped),
    { tags: ["unit", "local"] },
  );
});

/** The first finished build of a watch stream; fails the test on a build error. */
const firstWatchResult = (stream: Stream.Stream<Bundle.BundleWatchEvent>) =>
  stream.pipe(
    Stream.filter((event) => event._tag !== "Start"),
    Stream.runHead,
    Effect.map((event) => {
      const result = Option.getOrThrow(event);
      if (result._tag !== "Success") throw new Error(`watch build failed: ${result.error.message}`);
      return result;
    }),
  );
