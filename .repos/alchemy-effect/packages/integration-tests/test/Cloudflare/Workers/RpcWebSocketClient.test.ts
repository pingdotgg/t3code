import { expect, layer } from "@alchemy.run/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

const sourceEntry = "src/Workers/RpcWebSocketClient.ts";
const compiledEntry = "lib/Workers/RpcWebSocketClient.js";
const declarationEntry = "lib/Workers/RpcWebSocketClient.d.ts";
const fixtureDirectory = new URL("./fixtures/rpc-websocket-client/", import.meta.url);

interface Manifest {
  readonly name: string;
  readonly version: string;
  readonly type: string;
  readonly sideEffects: boolean;
  readonly files: ReadonlyArray<string>;
  readonly exports: Record<string, unknown>;
  readonly publishConfig: { readonly exports: Record<string, unknown> };
}

const packageInfo = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* path.fromFileUrl(new URL("../../../../cloudflare/", import.meta.url));
  const json = yield* fs.readFileString(path.join(root, "package.json"));
  const manifest = yield* Effect.try(() => JSON.parse(json) as Manifest);
  return { root, manifest };
});

const bundleBrowser = Effect.fn(function* (
  root: string,
  entry: string,
  conditions: string[] = ["browser", "import", "default"],
) {
  const { rolldown } = yield* Effect.promise(() => import("rolldown"));
  const modules = new Set<string>();
  return yield* Effect.acquireUseRelease(
    Effect.promise(() =>
      rolldown({
        cwd: root,
        input: entry,
        platform: "browser",
        resolve: { conditionNames: conditions },
        treeshake: false,
        plugins: [
          {
            name: "browser-dependency-graph",
            moduleParsed(info) {
              modules.add(info.id);
              for (const id of [...info.importedIds, ...info.dynamicallyImportedIds]) {
                modules.add(id);
              }
            },
          },
        ],
      }),
    ),
    (bundle) =>
      Effect.gen(function* () {
        const { output } = yield* Effect.promise(() => bundle.generate({ format: "esm" }));
        const chunks = output.filter((item) => item.type === "chunk");
        const entryChunk = chunks.find((chunk) => chunk.isEntry)!;
        expect(entryChunk.exports).toEqual(
          expect.arrayContaining(["BrowserClient", "clientLayer", "echo"]),
        );
        expect(entryChunk.code.length).toBeGreaterThan(0);
        const emitted = new Set(chunks.map((chunk) => chunk.fileName));
        expect(
          chunks.flatMap((chunk) =>
            [...chunk.imports, ...chunk.dynamicImports].filter((id) => !emitted.has(id)),
          ),
        ).toEqual([]);
        return [...modules].map((id) => id.replaceAll("\\", "/"));
      }),
    (bundle) => Effect.promise(() => bundle.close()),
  );
});

const assertBrowserGraph = Effect.fn(function* (
  root: string,
  modules: string[],
  expectedEntry: string,
) {
  const path = yield* Path.Path;
  const sourceRoot = `${path.join(root, "src").replaceAll("\\", "/")}/`;
  const libRoot = `${path.join(root, "lib").replaceAll("\\", "/")}/`;
  const alchemyModules = modules.filter(
    (id) => id.startsWith(sourceRoot) || id.startsWith(libRoot),
  );
  expect(alchemyModules).toEqual([path.join(root, expectedEntry).replaceAll("\\", "/")]);
  expect(modules.some((id) => id.includes("/effect/"))).toBe(true);
  expect(
    modules.filter(
      (id) =>
        /^(?:node|cloudflare|bun):/.test(id) ||
        id.includes("/submodules/distilled/") ||
        id.includes("/packages/cloudflare-runtime/") ||
        /\/node_modules\/(?:@distilled\.cloud\/|@cloudflare\/|@alchemy\.run\/cloudflare-runtime\/|@effect\/platform-node(?:-shared)?\/|(?:cloudflare|workerd|wrangler|unenv)\/)/.test(
          id,
        ),
    ),
  ).toEqual([]);
});

const stagePublishedPackage = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { root, manifest } = yield* packageInfo;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-rpc-websocket-client-" });
  const packageDirectory = path.join(directory, "node_modules/@alchemy.run/cloudflare");
  yield* fs.makeDirectory(packageDirectory, { recursive: true });
  yield* fs.writeFileString(
    path.join(packageDirectory, "package.json"),
    JSON.stringify({
      name: manifest.name,
      version: manifest.version,
      type: manifest.type,
      sideEffects: manifest.sideEffects,
      exports: manifest.publishConfig.exports,
    }),
  );
  for (const entry of ["src", "lib"]) {
    yield* fs.symlink(path.join(root, entry), path.join(packageDirectory, entry));
  }
  yield* fs.symlink(
    path.join(root, "node_modules/effect"),
    path.join(directory, "node_modules/effect"),
  );
  for (const file of ["browser.ts", "rpcs.ts"]) {
    yield* fs.copyFile(
      path.join(yield* path.fromFileUrl(fixtureDirectory), file),
      path.join(directory, file),
    );
  }
  return { root, directory, entry: path.join(directory, "browser.ts") };
});

layer(NodeServices.layer)("@alchemy.run/cloudflare/Workers/RpcWebSocketClient", (it) => {
  it.effect(
    "maps the public source and published browser entry points",
    () =>
      Effect.gen(function* () {
        const { manifest } = yield* packageInfo;
        // `./Workers/RpcWebSocketClient` resolves through the `./*` file pattern.
        const at = (pattern: string) => pattern.replaceAll("*", "Workers/RpcWebSocketClient");
        expect(at(manifest.exports["./*"] as string)).toBe(`./${sourceEntry}`);
        const published = manifest.publishConfig.exports["./*"] as Record<string, string>;
        expect(Object.fromEntries(Object.entries(published).map(([k, v]) => [k, at(v)]))).toEqual({
          types: `./${declarationEntry}`,
          bun: `./${sourceEntry}`,
          worker: `./${sourceEntry}`,
          default: `./${compiledEntry}`,
        });
        expect(manifest.files).toEqual(expect.arrayContaining(["src", "lib"]));
      }),
    { tags: ["unit", "provider:cloudflare", "provider:cloudflare:worker", "local"] },
  );

  it.effect(
    "bundles the actual public subpath for a browser without server modules",
    () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const { root } = yield* packageInfo;
        const modules = yield* bundleBrowser(
          root,
          path.join(yield* path.fromFileUrl(fixtureDirectory), "browser.ts"),
        );
        yield* assertBrowserGraph(root, modules, sourceEntry);
      }),
    { tags: ["unit", "provider:cloudflare", "provider:cloudflare:worker", "local"] },
  );

  it.effect(
    "resolves the published source condition through the public subpath",
    () =>
      Effect.gen(function* () {
        const { root, directory, entry } = yield* stagePublishedPackage;
        const modules = yield* bundleBrowser(directory, entry, [
          "bun",
          "browser",
          "import",
          "default",
        ]);
        yield* assertBrowserGraph(root, modules, sourceEntry);
      }),
    { tags: ["unit", "provider:cloudflare", "provider:cloudflare:worker", "local"] },
  );

  // Compiled packaging checks require a prior workspace build.
  it.effect.skipIf(!process.env.ALCHEMY_TEST_RPC_CLIENT_LIB)(
    "bundles the fresh published JavaScript entry for browsers",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { root, directory, entry } = yield* stagePublishedPackage;
        const source = yield* fs.stat(path.join(root, sourceEntry));
        for (const file of [compiledEntry, declarationEntry]) {
          const info = yield* fs.stat(path.join(root, file));
          expect(Option.getOrThrow(info.mtime).getTime()).toBeGreaterThanOrEqual(
            Option.getOrThrow(source.mtime).getTime(),
          );
        }
        const modules = yield* bundleBrowser(directory, entry);
        yield* assertBrowserGraph(root, modules, compiledEntry);
      }),
    { tags: ["unit", "provider:cloudflare", "provider:cloudflare:worker", "local"] },
  );
});
