import { PlatformServices } from "@/Util/PlatformServices.ts";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import { nodePath, nodeSupportsDevMode } from "../nodeProbe.ts";

// Use the published bin layout but replace the entry with a real progress
// render, so startup is exercised without credentials or cloud resources.
const runPublishedLauncher = (
  nodeEnv: string | undefined,
  jsx?: string,
  runtime = "bun",
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const packageDir = yield* path.fromFileUrl(
      new URL("../../", import.meta.url),
    );
    const project = yield* fs.makeTempDirectoryScoped({
      prefix: "alchemy-launcher-",
    });
    const installed = path.join(project, "node_modules", "alchemy");
    const bin = path.join(installed, "bin");
    yield* fs.makeDirectory(bin, { recursive: true });
    yield* fs.copyFile(
      path.join(packageDir, "bin", "cli.js"),
      path.join(bin, "cli.js"),
    );
    const config = path.join(packageDir, "bin", "tsconfig.json");
    yield* fs.copyFile(config, path.join(bin, "tsconfig.json"));
    yield* fs.writeFileString(
      path.join(installed, "package.json"),
      JSON.stringify({ type: "module", bin: { alchemy: "./bin/cli.js" } }),
    );
    yield* fs.symlink(
      path.join(packageDir, "node_modules"),
      path.join(installed, "node_modules"),
    );
    yield* fs.makeDirectory(path.join(project, "node_modules", ".bin"));
    yield* fs.symlink(
      path.join(bin, "cli.js"),
      path.join(project, "node_modules", ".bin", "alchemy"),
    );
    yield* fs.chmod(path.join(bin, "cli.js"), 0o755);
    const fixture = new URL(
      "./fixtures/launcher-production.tsx",
      import.meta.url,
    ).href;
    yield* fs.writeFileString(
      path.join(bin, "alchemy.js"),
      `await import(${JSON.stringify(fixture)});\n`,
    );
    if (jsx !== undefined) {
      yield* fs.writeFileString(
        path.join(project, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            jsx,
            ...(jsx === "preserve" ? { jsxImportSource: "solid-js" } : {}),
          },
        }),
      );
    }
    const args = ["deploy", "stack.run.ts", "--stage", "test", "--yes"];
    const handle = yield* ChildProcess.make(
      runtime,
      [
        ...(runtime === "bun"
          ? ["--bun", "alchemy"]
          : [path.join(bin, "cli.js")]),
        ...args,
      ],
      {
        cwd: project,
        env: {
          NODE_ENV: nodeEnv,
          CI: "true",
          npm_execpath: "",
          npm_config_user_agent: `bun/${process.versions.bun}`,
          BUN_OPTIONS: "",
          BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
        },
        extendEnv: true,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        forceKillAfter: "1 second",
      },
    );
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        handle.stdout.pipe(Stream.decodeText, Stream.mkString),
        handle.stderr.pipe(Stream.decodeText, Stream.mkString),
        handle.exitCode,
      ],
      { concurrency: 3 },
    );
    expect({ exitCode, stderr, failure: exitCode === 0 ? "" : stdout }).toEqual(
      {
        exitCode: 0,
        stderr: "",
        failure: "",
      },
    );
    expect(stdout).toContain("Starting deployment");
    expect(stdout).toContain("Deployment complete");
    expect(stdout).toContain(
      JSON.stringify({
        cwd: yield* fs.realPath(project),
        args,
      }),
    );
  }).pipe(Effect.scoped, Effect.provide(PlatformServices));

describe.sequential(
  "published Bun launcher",
  { tags: ["unit", "local"] },
  () => {
    it.live.skipIf(!nodeSupportsDevMode)(
      "renders production progress through the Node shebang handoff",
      () => runPublishedLauncher("development", "preserve", nodePath!),
    );
    for (const nodeEnv of [undefined, "development", "production"]) {
      for (const jsx of [undefined, "react-jsx", "react-jsxdev", "preserve"]) {
        it.live(
          `renders production progress with NODE_ENV=${nodeEnv} and jsx=${jsx}`,
          () => runPublishedLauncher(nodeEnv, jsx),
        );
      }
    }
  },
);
