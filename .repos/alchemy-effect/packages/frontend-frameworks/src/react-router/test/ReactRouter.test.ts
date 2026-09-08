import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as Scope from "effect/Scope";
import { describe, expect, it } from "vitest";
import {
  generateLambdaEntry,
  LAMBDA_ADAPTER_FILE_NAME,
  LAMBDA_ENTRY_FILE_NAME,
  makeAwsTarget,
  SERVER_ENTRY_FILE_NAME,
} from "../aws.ts";
import { fromHarnessOptions } from "../index.ts";
import {
  DEFAULT_BUILD_DIRECTORY,
  DEFAULT_SERVER_BUILD_FILE,
  DEFAULT_TARGET_SPECIFIER,
  inlineClientBuildConfig,
  inlineServerBuildConfig,
  make,
  REACT_ROUTER_SERVER_BUILD_ID,
  readReactRouterOutput,
  selectServerEntryName,
  SERVER_ENTRY_ID,
  serverEntryPlugin,
  serverEntrySource,
  type ReactRouterTarget,
} from "../ReactRouter.ts";

const runWithNode = <A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Scope.Scope>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(effect).pipe(
      Effect.provide(NodeServices.layer),
    ) as Effect.Effect<A, E>,
  );

describe("readReactRouterOutput", () => {
  it("maps a build tree onto the BuildOutput contract, entry first", async () => {
    const output = await runWithNode(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({
          prefix: "react-router-output-",
        });
        const serverDir = path.join(dir, "server");
        const clientDir = path.join(dir, "client");
        yield* fs.makeDirectory(path.join(serverDir, "assets"), {
          recursive: true,
        });
        yield* fs.makeDirectory(clientDir, { recursive: true });
        // alphabetically before index.js, to prove entry-first sorting
        yield* fs.writeFileString(
          path.join(serverDir, "assets", "chunk-abc.js"),
          "export const a = 1;",
        );
        yield* fs.writeFileString(
          path.join(serverDir, DEFAULT_SERVER_BUILD_FILE),
          "export const entry = {};",
        );
        yield* fs.writeFileString(
          path.join(clientDir, "robots.txt"),
          "User-agent: *\n",
        );
        return yield* readReactRouterOutput({ dir, serverDir, clientDir });
      }),
    );
    expect(output.serverModules?.map((module) => module.name)).toEqual([
      "server/index.js",
      "server/assets/chunk-abc.js",
    ]);
    expect(output.serverModules?.[0]?.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(output.clientDirectory?.endsWith("client")).toBe(true);
    expect(output.distDirectory).toBeDefined();
    expect(output.externalWorkspaces.size).toBe(0);
  });

  it("honors a serverBuildFile override", async () => {
    const output = await runWithNode(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({
          prefix: "react-router-output-",
        });
        const serverDir = path.join(dir, "server");
        yield* fs.makeDirectory(serverDir, { recursive: true });
        yield* fs.writeFileString(
          path.join(serverDir, "app.js"),
          "export const entry = {};",
        );
        yield* fs.writeFileString(
          path.join(serverDir, "index.js"),
          "export const other = {};",
        );
        return yield* readReactRouterOutput({
          dir,
          serverDir,
          clientDir: path.join(dir, "client"),
          serverEntryFileName: "app.js",
        });
      }),
    );
    expect(output.serverModules?.[0]?.name).toBe("server/app.js");
  });

  it("falls back to the single top-level module when the entry is renamed", async () => {
    const output = await runWithNode(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({
          prefix: "react-router-output-",
        });
        const serverDir = path.join(dir, "server");
        yield* fs.makeDirectory(path.join(serverDir, "assets"), {
          recursive: true,
        });
        yield* fs.writeFileString(
          path.join(serverDir, "assets", "chunk-abc.js"),
          "export const a = 1;",
        );
        yield* fs.writeFileString(
          path.join(serverDir, "server.js"),
          "export const entry = {};",
        );
        return yield* readReactRouterOutput({
          dir,
          serverDir,
          clientDir: path.join(dir, "client"),
        });
      }),
    );
    expect(output.serverModules?.[0]?.name).toBe("server/server.js");
  });

  it("names RSC / multi-environment builds as the unsupported case", async () => {
    const error = await runWithNode(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({
          prefix: "react-router-output-",
        });
        const serverDir = path.join(dir, "server");
        yield* fs.makeDirectory(serverDir, { recursive: true });
        yield* fs.writeFileString(
          path.join(serverDir, "rsc.js"),
          "export const a = 1;",
        );
        yield* fs.writeFileString(
          path.join(serverDir, "ssr.js"),
          "export const b = 1;",
        );
        return yield* readReactRouterOutput({
          dir,
          serverDir,
          clientDir: path.join(dir, "client"),
        }).pipe(Effect.flip);
      }),
    );
    expect(error._tag).toBe("FrameworkError");
    expect(error.message).toContain('no "server/index.js" entry');
    expect(error.message).toContain("React Server Components");
  });

  it("fails when the build produced no server modules", async () => {
    const error = await runWithNode(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({
          prefix: "react-router-output-",
        });
        const serverDir = path.join(dir, "server");
        yield* fs.makeDirectory(serverDir, { recursive: true });
        return yield* readReactRouterOutput({
          dir,
          serverDir,
          clientDir: path.join(dir, "client"),
        }).pipe(Effect.flip);
      }),
    );
    expect(error.message).toContain("no server modules");
  });
});

describe("selectServerEntryName", () => {
  it("prefers the expected name over a lone sibling", () => {
    expect(
      selectServerEntryName(
        ["server/index.js", "server/other.js"],
        "server/index.js",
      ),
    ).toBe("server/index.js");
  });

  it("ignores nested chunks when counting top-level modules", () => {
    expect(
      selectServerEntryName(
        ["server/assets/a.js", "server/assets/b.js", "server/app.js"],
        "server/index.js",
      ),
    ).toBe("server/app.js");
  });

  it("is undefined when the choice is ambiguous", () => {
    expect(
      selectServerEntryName(["server/a.js", "server/b.js"], "server/index.js"),
    ).toBeUndefined();
  });
});

describe("serverEntrySource", () => {
  it("turns the ServerBuild manifest into a fetch handler", () => {
    const source = serverEntrySource();
    // React Router's server build is a manifest with no default export;
    // `createRequestHandler` is what makes it callable.
    expect(source).toContain(
      `import * as build from "${REACT_ROUTER_SERVER_BUILD_ID}"`,
    );
    expect(source).toContain(
      'import { createRequestHandler } from "react-router"',
    );
    expect(source).toContain('createRequestHandler(build, "production")');
    expect(source).toContain("export default {");
  });

  it("forwards the build mode", () => {
    expect(serverEntrySource("development")).toContain(
      'createRequestHandler(build, "development")',
    );
  });
});

describe("serverEntryPlugin", () => {
  it("resolves and loads the virtual entry, and nothing else", () => {
    const plugin = serverEntryPlugin();
    expect(plugin.enforce).toBe("pre");
    const resolved = plugin.resolveId!(SERVER_ENTRY_ID);
    expect(resolved).toBe(`\0${SERVER_ENTRY_ID}`);
    expect(plugin.resolveId!("react-router")).toBeUndefined();
    expect(plugin.load!(resolved!)).toContain("createRequestHandler");
    expect(plugin.load!(SERVER_ENTRY_ID)).toBeUndefined();
  });
});

describe("inlineServerBuildConfig", () => {
  it("selects the server environment and replaces its rollup input", () => {
    const config = inlineServerBuildConfig("/app", []) as {
      build: { ssr: boolean; rollupOptions: { input: string } };
      ssr: { noExternal: boolean };
      environments: { ssr: { resolve: { noExternal: boolean } } };
      root: string;
    };
    // `build.ssr` is the flag React Router's plugin branches on; the input
    // swap is honored verbatim by its server-environment resolver.
    expect(config.build.ssr).toBe(true);
    expect(config.build.rollupOptions.input).toBe(SERVER_ENTRY_ID);
    // Vite externalizes node_modules from SSR bundles by default; a Lambda
    // ships the server directory alone, so it must be self-contained.
    expect(config.ssr.noExternal).toBe(true);
    expect(config.environments.ssr.resolve.noExternal).toBe(true);
    expect(config.root).toBe("/app");
  });
});

describe("inlineClientBuildConfig", () => {
  it("builds the client environment without SSR overrides", () => {
    const config = inlineClientBuildConfig("/app", []) as {
      root: string;
      build?: unknown;
      ssr?: unknown;
    };
    expect(config.root).toBe("/app");
    expect(config.build).toBeUndefined();
    expect(config.ssr).toBeUndefined();
  });
});

describe("generateLambdaEntry", () => {
  it("wraps the server entry's fetch handler for streaming by default", () => {
    const source = generateLambdaEntry({
      streaming: true,
      serverEntryFileName: SERVER_ENTRY_FILE_NAME,
    });
    expect(source).toContain(`import * as serverEntry from "./index.js"`);
    expect(source).toContain(
      `import { toLambdaHandler } from "./${LAMBDA_ADAPTER_FILE_NAME}"`,
    );
    expect(source).toContain("export const handler = toLambdaHandler(");
    // A project entry may default-export the bare fetch function.
    expect(source).toContain('typeof entry === "function"');
  });

  it("emits the buffered wrapper when streaming is disabled", () => {
    const source = generateLambdaEntry({
      streaming: false,
      serverEntryFileName: "app.js",
    });
    expect(source).toContain("toBufferedLambdaHandler");
    expect(source).not.toContain("toLambdaHandler(fetchHandler)");
    expect(source).toContain(`from "./app.js"`);
  });
});

describe("makeAwsTarget", () => {
  it("declares the Lambda packaging seams", () => {
    const target = makeAwsTarget();
    expect(target.platform).toBe("aws");
    expect(target.serverEntryFileName).toBe(DEFAULT_SERVER_BUILD_FILE);
    expect(target.bundle?.conditions).toEqual(["node", "import", "module"]);
    expect(target.bundle?.external).toEqual(["@aws-sdk/"]);
    expect(typeof target.finish).toBe("function");
    // The wholesale build hook runs the build in a disposable child process.
    expect(typeof target.build).toBe("function");
  });

  it("carries the buildDirectory and streaming overrides on its config", () => {
    const config = makeAwsTarget({
      buildDirectory: "dist",
      streaming: false,
    }).config;
    expect(config.buildDirectory).toBe("dist");
    expect(config.streaming).toBe(false);
  });
});

describe("finish", () => {
  it("emits the Lambda entry, the ESM marker, and the adapter copy", async () => {
    const output = await runWithNode(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({
          prefix: "react-router-finish-",
        });
        const serverDir = path.join(dir, "server");
        yield* fs.makeDirectory(serverDir, { recursive: true });
        yield* fs.writeFileString(
          path.join(serverDir, SERVER_ENTRY_FILE_NAME),
          "export default { fetch() {} };",
        );
        const target = makeAwsTarget();
        return yield* target.finish!(
          {
            distDirectory: dir,
            clientDirectory: path.join(dir, "client"),
            serverModules: [],
            externalWorkspaces: new Set<string>(),
          },
          {
            root: dir,
            framework: "react-router",
            entry: path.join(serverDir, SERVER_ENTRY_FILE_NAME),
          },
        );
      }),
    );
    const names = output.serverModules?.map((module) => module.name) ?? [];
    // The Lambda entry sorts first — it becomes the deployed handler module.
    expect(names[0]).toBe(`server/${LAMBDA_ENTRY_FILE_NAME}`);
    expect(names).toContain("server/package.json");
    expect(names).toContain(`server/${LAMBDA_ADAPTER_FILE_NAME}`);
    // `lambda.mjs`, not `index.mjs`: the server build already owns index.js.
    expect(names).toContain(`server/${SERVER_ENTRY_FILE_NAME}`);
    const manifest = output.serverModules?.find(
      (module) => module.name === "server/package.json",
    );
    expect(String(manifest?.content)).toContain('"type":"module"');
  });

  it("fails when the framework produced no on-disk entry", async () => {
    const error = await runWithNode(
      Effect.gen(function* () {
        const target = makeAwsTarget();
        return yield* target.finish!(
          {
            distDirectory: "/tmp",
            clientDirectory: undefined,
            serverModules: [],
            externalWorkspaces: new Set<string>(),
          },
          { root: "/tmp", framework: "react-router" },
        ).pipe(Effect.flip);
      }),
    );
    expect(error._tag).toBe("DeployTargetError");
    expect(error.message).toContain("no on-disk server entry");
  });
});

describe("make", () => {
  it("defaults to this package's AWS deploy target", () => {
    expect(DEFAULT_TARGET_SPECIFIER).toBe(
      "@alchemy.run/frontend-frameworks/react-router/aws",
    );
    expect(DEFAULT_BUILD_DIRECTORY).toBe("build");
  });

  it("build fails with a descriptive FrameworkError outside a Vite project", async () => {
    // /tmp has no vite install: loading the project's Vite is the first step
    // after the target resolves and must surface a FrameworkError.
    const result = await runWithNode(
      Effect.gen(function* () {
        const framework = yield* make({
          root: "/tmp/does-not-matter",
          target: finishOnly(makeAwsTarget()),
        });
        return yield* Effect.result(
          framework.build({ root: "/tmp/does-not-matter" }),
        );
      }),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure._tag).toBe("FrameworkError");
      expect(result.failure.framework).toBe("react-router");
    }
  });

  it("exposes the framework contract (build + dev)", async () => {
    const framework = await runWithNode(make({ root: "/tmp/does-not-matter" }));
    expect(typeof framework.build).toBe("function");
    expect(typeof framework.dev).toBe("function");
  });
});

describe("fromHarnessOptions", () => {
  it("forwards the harness's buildDirectory override", () => {
    expect(
      fromHarnessOptions({ reactRouter: { buildDirectory: "dist" } })
        .buildDirectory,
    ).toBe("dist");
    expect(fromHarnessOptions({}).buildDirectory).toBeUndefined();
  });
});

/** Drop the wholesale `build` hook so the in-process pipeline runs. */
const finishOnly = (target: ReactRouterTarget): ReactRouterTarget => {
  const { build: _build, ...rest } = target;
  return rest;
};
