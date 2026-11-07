// @effect-diagnostics nodeBuiltinImport:off -- Resolves the real CLI entrypoint for subprocess tests.
import * as NodeURL from "node:url";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import packageJson from "../package.json" with { type: "json" };

it.live("only exact top-level --version bypasses the CLI graph", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cli-version-test-" });
    const guard = `import { registerHooks } from 'node:module'; registerHooks({ resolve(specifier, context, nextResolve) { if (specifier === './binCli.ts') throw new Error('CLI_GRAPH_LOADED'); return nextResolve(specifier, context); } });`;
    const run = Effect.fn("cliVersion.test.run")(function* (
      args: ReadonlyArray<string>,
      { tty = false, noColor = "" } = {},
    ) {
      const child = yield* spawner.spawn(
        ChildProcess.make(
          process.execPath,
          [
            "--experimental-strip-types",
            "--import",
            `data:text/javascript,${encodeURIComponent(`${tty ? "Object.defineProperty(process.stdout, 'isTTY', { value: true });" : ""}${guard}`)}`,
            NodeURL.fileURLToPath(new URL("./bin.ts", import.meta.url)),
            ...args,
          ],
          {
            env: {
              T3CODE_HOME: `${root}/home`,
              NODE_DISABLE_COMPILE_CACHE: "1",
              NO_COLOR: noColor,
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

    expect(yield* run(["--version"])).toEqual({
      stdout: `t3 v${packageJson.version}\n`,
      stderr: "",
      exitCode: 0,
    });
    expect(yield* run(["--version"], { tty: true })).toEqual({
      stdout: `\x1b[1mt3\x1b[0m \x1b[2mv\x1b[0m\x1b[1m${packageJson.version}\x1b[0m\n`,
      stderr: "",
      exitCode: 0,
    });
    expect(yield* run(["--version"], { tty: true, noColor: "1" })).toEqual({
      stdout: `t3 v${packageJson.version}\n`,
      stderr: "",
      exitCode: 0,
    });
    for (const args of [
      [],
      ["--help"],
      ["--version", "--help"],
      ["--version", "extra"],
      ["serve", "--version"],
    ]) {
      const result = yield* run(args);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("CLI_GRAPH_LOADED");
      expect(result.stdout).toBe("");
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("loads the CLI with its cache settings only when the command needs it", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cli-cache-test-" });
    const report = `
      import { getCompileCacheDir, registerHooks } from 'node:module';
      registerHooks({ resolve(specifier, context, nextResolve) {
        if (specifier === './binMain.ts') console.error('LOADED_CLI_MAIN');
        if (specifier === './binCli.ts') console.error('CACHE=' + (getCompileCacheDir() ?? 'disabled'));
        return nextResolve(specifier, context);
      } });
    `;
    const run = Effect.fn("cliCompileCache.test.run")(function* (
      env: Record<string, string>,
      args: ReadonlyArray<string> = ["--help"],
    ) {
      const child = yield* spawner.spawn(
        ChildProcess.make(
          process.execPath,
          [
            "--experimental-strip-types",
            "--import",
            `data:text/javascript,${encodeURIComponent(report)}`,
            NodeURL.fileURLToPath(new URL("./bin.ts", import.meta.url)),
            ...args,
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
    expect(normal.stderr).toContain("LOADED_CLI_MAIN");
    expect(normal.stderr.replaceAll("\\", "/")).toContain(
      `CACHE=${root}/cache/t3code/compile-cache`.replaceAll("\\", "/"),
    );
    const launcher = yield* run({ T3CODE_HOME: "" }, ["__service-launcher"]);
    expect(launcher.exitCode).toBe(1);
    expect(launcher.stderr).toContain("[service-launcher] T3CODE_HOME is required");
    expect(launcher.stderr).not.toMatch(/LOADED_CLI_MAIN|CACHE=/);
    const launcherHelp = yield* run({ T3CODE_HOME: "" }, ["__service-launcher", "--help"]);
    expect(launcherHelp.exitCode).toBe(0);
    expect(launcherHelp.stderr).toContain("LOADED_CLI_MAIN");
    expect(launcherHelp.stdout).toContain("t3 __service-launcher [flags]");
    const launcherFlags = yield* run({ T3CODE_HOME: "" }, [
      "__service-launcher",
      "--log-level",
      "debug",
    ]);
    expect(launcherFlags.exitCode).toBe(1);
    expect(launcherFlags.stderr).toContain("LOADED_CLI_MAIN");
    expect(launcherFlags.stderr).toContain("[service-launcher] T3CODE_HOME is required");
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
