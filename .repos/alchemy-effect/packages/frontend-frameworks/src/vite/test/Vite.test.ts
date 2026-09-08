import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as Scope from "effect/Scope";
import * as NodeFs from "node:fs";
import { describe, expect, it } from "vitest";
import { makeDeployTarget } from "../../core/index.ts";
import { makeAwsTarget } from "../aws.ts";
import { make, readViteOutput } from "../Vite.ts";

const runWithNode = <A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Scope.Scope>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(effect).pipe(
      Effect.provide(NodeServices.layer),
    ) as Effect.Effect<A, E>,
  );

/** A minimal html-entry Vite project written into a scoped temp directory. */
const writeFixtureProject = Effect.fn(function* (marker: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "vite-app-" });
  yield* fs.writeFileString(
    path.join(root, "package.json"),
    JSON.stringify({ name: "vite-fixture", private: true, type: "module" }),
  );
  yield* fs.writeFileString(
    path.join(root, "index.html"),
    `<!doctype html><html><head><title>fixture</title></head><body><div id="app">${marker}</div><script type="module" src="/src/main.ts"></script></body></html>`,
  );
  yield* fs.makeDirectory(path.join(root, "src"), { recursive: true });
  yield* fs.writeFileString(
    path.join(root, "src", "main.ts"),
    `document.querySelector("#app")!.setAttribute("data-ready", "true");\n`,
  );
  return root;
});

/**
 * Fully canonical form of an existing path. Effect's `fs.realPath` delegates
 * to node's `fs.realpath`, which resolves symlinks (macOS `/var` ->
 * `/private/var`) but NOT Windows 8.3 short names (`RUNNER~1` vs
 * `runneradmin`); only `realpath.native` does both.
 */
const canonicalPath = (p: string) =>
  Effect.sync(() => NodeFs.realpathSync.native(p));

/** An adapter-less in-process target (no build child) for direct testing. */
const inProcessTarget = makeDeployTarget({
  platform: "aws",
  config: {},
});

describe("readViteOutput", () => {
  it("maps an assets directory onto the assets-only BuildOutput contract", async () => {
    const output = await runWithNode(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({
          prefix: "vite-output-",
        });
        yield* fs.writeFileString(
          path.join(dir, "index.html"),
          "<!doctype html>",
        );
        return yield* readViteOutput({ outDir: dir }).pipe(
          Effect.map((output) => ({
            distDirectory: output.distDirectory,
            clientDirectory: output.clientDirectory,
            serverModules: output.serverModules,
            externalWorkspaces: [...output.externalWorkspaces],
            dir,
          })),
        );
      }),
    );
    expect(output.distDirectory).toBe(output.dir);
    expect(output.clientDirectory).toBe(output.dir);
    expect(output.serverModules).toBeUndefined();
    expect(output.externalWorkspaces).toEqual([]);
  });

  it("fails actionably when the output directory is missing", async () => {
    const error = await runWithNode(
      Effect.flip(readViteOutput({ outDir: "/nonexistent/vite-dist" })),
    );
    expect(error._tag).toBe("FrameworkError");
    expect(error.message).toContain("no output directory");
  });
});

describe("make().build", () => {
  it("drives the project's vite build and returns an assets-only output", async () => {
    const result = await runWithNode(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* writeFixtureProject("VITE_BUILD_MARKER");
        const framework = yield* make({ root, target: inProcessTarget });
        const output = yield* framework.build({ root });
        const indexHtml = yield* fs.readFileString(
          path.join(output.clientDirectory!, "index.html"),
        );
        // vite's resolveConfig canonicalizes the root, so compare fully
        // canonical paths on both sides.
        return {
          clientDirectory: yield* canonicalPath(output.clientDirectory!),
          distDirectory: yield* canonicalPath(output.distDirectory!),
          serverModules: output.serverModules,
          indexHtml,
          expectedOutDir: yield* canonicalPath(path.join(root, "dist")),
        };
      }),
    );
    expect(result.clientDirectory).toBe(result.expectedOutDir);
    expect(result.distDirectory).toBe(result.expectedOutDir);
    expect(result.serverModules).toBeUndefined();
    expect(result.indexHtml).toContain("VITE_BUILD_MARKER");
  }, 120_000);

  it("honors an explicit outDir override", async () => {
    const result = await runWithNode(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* writeFixtureProject("VITE_OUTDIR_MARKER");
        const framework = yield* make({
          root,
          target: inProcessTarget,
          vite: { outDir: "build-output" },
        });
        const output = yield* framework.build({ root });
        return {
          clientDirectory: output.clientDirectory,
          expected: path.join(root, "build-output"),
          exists: yield* fs.exists(
            path.join(root, "build-output", "index.html"),
          ),
        };
      }),
    );
    expect(result.clientDirectory).toBe(result.expected);
    expect(result.exists).toBe(true);
  }, 120_000);
});

describe("make().dev", () => {
  it("serves the project through vite's own dev server, scoped", async () => {
    const body = await runWithNode(
      Effect.gen(function* () {
        const root = yield* writeFixtureProject("VITE_DEV_MARKER");
        const framework = yield* make({ root, target: inProcessTarget });
        const { url } = yield* framework.dev({ root });
        expect(url).toMatch(/^http:\/\/(localhost|127\.0\.0\.1)/);
        return yield* Effect.tryPromise(async () => {
          const response = await fetch(url);
          return await response.text();
        });
      }),
    );
    expect(body).toContain("VITE_DEV_MARKER");
  }, 120_000);
});

describe("makeAwsTarget", () => {
  it("is an assets-only target whose only seam is the wholesale child build", () => {
    const target = makeAwsTarget({ vite: { outDir: "dist" } });
    expect(target.platform).toBe("aws");
    expect(target.build).toBeTypeOf("function");
    expect(target.finish).toBeUndefined();
    expect(target.entry).toBeUndefined();
    expect(target.config).toEqual({ vite: { outDir: "dist" } });
  });
});
