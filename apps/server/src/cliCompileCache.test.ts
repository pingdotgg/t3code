// @effect-diagnostics nodeBuiltinImport:off -- Resolves the real CLI entrypoint for subprocess tests.
import * as NodeURL from "node:url";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

it.live("enables CLI caching while respecting overrides and unavailable storage", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cli-cache-test-" });
    const report = `import { getCompileCacheDir, registerHooks } from 'node:module'; registerHooks({ resolve(specifier, context, nextResolve) { if (specifier === './binCli.ts') console.error('CACHE=' + (getCompileCacheDir() ?? 'disabled')); return nextResolve(specifier, context); } });`;
    const run = Effect.fn("cliCompileCache.test.run")(function* (env: Record<string, string>) {
      const child = yield* spawner.spawn(
        ChildProcess.make(
          process.execPath,
          [
            "--experimental-strip-types",
            "--import",
            `data:text/javascript,${encodeURIComponent(report)}`,
            NodeURL.fileURLToPath(new URL("./bin.ts", import.meta.url)),
            "--help",
          ],
          {
            env: {
              XDG_CACHE_HOME: `${root}/cache`,
              T3CODE_HOME: `${root}/home`,
              NODE_COMPILE_CACHE: undefined,
              NODE_DISABLE_COMPILE_CACHE: undefined,
              APPIMAGE: "",
              ...env,
            },
          },
        ),
      );
      return yield* Effect.all(
        {
          stdout: child.stdout.pipe(Stream.decodeText(), Stream.mkString),
          stderr: child.stderr.pipe(Stream.decodeText(), Stream.mkString),
          exitCode: child.exitCode.pipe(Effect.map(Number)),
        },
        { concurrency: "unbounded" },
      );
    }, Effect.scoped);
    const normal = yield* run({});
    expect(normal.exitCode).toBe(0);
    expect(normal.stderr.replaceAll("\\", "/")).toContain(
      `CACHE=${root}/cache/t3code/compile-cache`.replaceAll("\\", "/"),
    );
    const appImage = yield* run({ APPIMAGE: `${root}/T3Code.AppImage` });
    expect(appImage.exitCode).toBe(0);
    expect(appImage.stderr).toContain("CACHE=disabled");
    const existing = yield* run({ NODE_COMPILE_CACHE: `${root}/explicit` });
    expect(existing.exitCode).toBe(0);
    expect(existing.stderr.replaceAll("\\", "/")).toContain(
      `${root}/explicit`.replaceAll("\\", "/"),
    );
    const disabled = yield* run({ NODE_DISABLE_COMPILE_CACHE: "1" });
    expect(disabled.exitCode).toBe(0);
    expect(disabled.stderr).toContain("CACHE=disabled");
    yield* fs.writeFileString(`${root}/blocked`, "not a directory");
    const unavailable = yield* run({ XDG_CACHE_HOME: `${root}/blocked` });
    expect(unavailable.exitCode).toBe(0);
    expect(unavailable.stderr).toContain("CACHE=disabled");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
