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
  DEFAULT_TARGET_SPECIFIER,
  inlineBuildConfig,
  make,
  readTanStackStartOutput,
  selectServerEntryName,
  type TanStackStartTarget,
} from "../TanStackStart.ts";

const runWithNode = <A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Scope.Scope>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(effect).pipe(
      Effect.provide(NodeServices.layer),
    ) as Effect.Effect<A, E>,
  );

describe("readTanStackStartOutput", () => {
  it("maps a dist tree onto the BuildOutput contract, entry first", async () => {
    const output = await runWithNode(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({
          prefix: "tanstack-start-output-",
        });
        const serverDir = path.join(dir, "server");
        const clientDir = path.join(dir, "client");
        yield* fs.makeDirectory(path.join(serverDir, "assets"), {
          recursive: true,
        });
        yield* fs.makeDirectory(clientDir, { recursive: true });
        // alphabetically before server.js, to prove entry-first sorting
        yield* fs.writeFileString(
          path.join(serverDir, "assets", "router-abc.js"),
          "export const a = 1;",
        );
        yield* fs.writeFileString(
          path.join(serverDir, "server.js"),
          "export default { fetch() {} };",
        );
        yield* fs.writeFileString(
          path.join(clientDir, "robots.txt"),
          "User-agent: *\n",
        );
        return yield* readTanStackStartOutput({ dir, serverDir, clientDir });
      }),
    );
    expect(output.serverModules?.map((module) => module.name)).toEqual([
      "server/server.js",
      "server/assets/router-abc.js",
    ]);
    expect(output.serverModules?.[0]?.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(output.clientDirectory?.endsWith("client")).toBe(true);
    expect(output.distDirectory).toBeDefined();
    expect(output.externalWorkspaces.size).toBe(0);
  });

  it("falls back to the single top-level module when the entry is renamed", async () => {
    const output = await runWithNode(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({
          prefix: "tanstack-start-output-",
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
          path.join(serverDir, "entry-server.js"),
          "export default { fetch() {} };",
        );
        return yield* readTanStackStartOutput({
          dir,
          serverDir,
          clientDir: path.join(dir, "client"),
        });
      }),
    );
    expect(output.serverModules?.[0]?.name).toBe("server/entry-server.js");
  });

  it("fails actionably when no server entry can be identified", async () => {
    const error = await runWithNode(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({
          prefix: "tanstack-start-output-",
        });
        const serverDir = path.join(dir, "server");
        yield* fs.makeDirectory(serverDir, { recursive: true });
        yield* fs.writeFileString(
          path.join(serverDir, "one.js"),
          "export const a = 1;",
        );
        yield* fs.writeFileString(
          path.join(serverDir, "two.js"),
          "export const b = 1;",
        );
        return yield* readTanStackStartOutput({
          dir,
          serverDir,
          clientDir: path.join(dir, "client"),
        }).pipe(Effect.flip);
      }),
    );
    expect(error._tag).toBe("FrameworkError");
    expect(error.message).toContain('no "server/server.js" entry');
  });

  it("fails when the build produced no server modules", async () => {
    const error = await runWithNode(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({
          prefix: "tanstack-start-output-",
        });
        const serverDir = path.join(dir, "server");
        yield* fs.makeDirectory(serverDir, { recursive: true });
        return yield* readTanStackStartOutput({
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
        ["server/server.js", "server/other.js"],
        "server/server.js",
      ),
    ).toBe("server/server.js");
  });

  it("ignores nested chunks when counting top-level modules", () => {
    expect(
      selectServerEntryName(
        ["server/assets/a.js", "server/assets/b.js", "server/entry.js"],
        "server/server.js",
      ),
    ).toBe("server/entry.js");
  });

  it("is undefined when the choice is ambiguous", () => {
    expect(
      selectServerEntryName(["server/a.js", "server/b.js"], "server/server.js"),
    ).toBeUndefined();
  });
});

describe("inlineBuildConfig", () => {
  it("forces a self-contained SSR bundle", () => {
    const config = inlineBuildConfig("/app", undefined) as {
      environments: { ssr: { resolve: { noExternal: boolean } } };
      build?: unknown;
      root: string;
    };
    // Vite externalizes node_modules from SSR bundles by default; a Lambda
    // ships the server directory alone, so it must be self-contained.
    expect(config.environments.ssr.resolve.noExternal).toBe(true);
    expect(config.root).toBe("/app");
    expect(config.build).toBeUndefined();
  });

  it("forwards an outDir override", () => {
    const config = inlineBuildConfig("/app", "build") as {
      build: { outDir: string };
    };
    expect(config.build.outDir).toBe("build");
  });
});

describe("generateLambdaEntry", () => {
  it("wraps the server entry's fetch handler for streaming by default", () => {
    const source = generateLambdaEntry({
      streaming: true,
      serverEntryFileName: SERVER_ENTRY_FILE_NAME,
    });
    expect(source).toContain(`import * as serverEntry from "./server.js"`);
    expect(source).toContain(
      `import { toLambdaHandler } from "./${LAMBDA_ADAPTER_FILE_NAME}"`,
    );
    expect(source).toContain("export const handler = toLambdaHandler(");
    // A custom server entry may default-export the bare fetch function.
    expect(source).toContain('typeof entry === "function"');
  });

  it("emits the buffered wrapper when streaming is disabled", () => {
    const source = generateLambdaEntry({
      streaming: false,
      serverEntryFileName: "entry-server.js",
    });
    expect(source).toContain("toBufferedLambdaHandler");
    expect(source).not.toContain("toLambdaHandler(fetchHandler)");
    expect(source).toContain(`from "./entry-server.js"`);
  });
});

describe("makeAwsTarget", () => {
  it("declares the Lambda packaging seams", () => {
    const target = makeAwsTarget();
    expect(target.platform).toBe("aws");
    expect(target.serverEntryFileName).toBe(SERVER_ENTRY_FILE_NAME);
    expect(target.bundle?.conditions).toEqual(["node", "import", "module"]);
    expect(target.bundle?.external).toEqual(["@aws-sdk/"]);
    expect(typeof target.finish).toBe("function");
    // The wholesale build hook runs the build in a disposable child process.
    expect(typeof target.build).toBe("function");
  });

  it("carries the outDir override on its config", () => {
    expect(makeAwsTarget({ outDir: "build" }).config.outDir).toBe("build");
  });
});

describe("finish", () => {
  it("emits the Lambda entry, the ESM marker, and the adapter copy", async () => {
    const output = await runWithNode(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({
          prefix: "tanstack-start-finish-",
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
            framework: "tanstack-start",
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
          { root: "/tmp", framework: "tanstack-start" },
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
      "@alchemy.run/frontend-frameworks/tanstack-start/aws",
    );
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
      expect(result.failure.framework).toBe("tanstack-start");
    }
  });

  it("exposes the framework contract (build + dev)", async () => {
    const framework = await runWithNode(make({ root: "/tmp/does-not-matter" }));
    expect(typeof framework.build).toBe("function");
    expect(typeof framework.dev).toBe("function");
  });
});

describe("fromHarnessOptions", () => {
  it("forwards the harness's outDir override", () => {
    expect(
      fromHarnessOptions({ tanstackStart: { outDir: "build" } }).outDir,
    ).toBe("build");
    expect(fromHarnessOptions({}).outDir).toBeUndefined();
  });
});

/** Drop the wholesale `build` hook so the in-process pipeline runs. */
const finishOnly = (target: TanStackStartTarget): TanStackStartTarget => {
  const { build: _build, ...rest } = target;
  return rest;
};
