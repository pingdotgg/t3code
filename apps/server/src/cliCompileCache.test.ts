// @effect-diagnostics nodeBuiltinImport:off -- Resolves the real CLI entrypoint for subprocess tests.
import * as NodeURL from "node:url";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

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
    const check = yield* run({}, ["update", "--check", "--json"]);
    expect(check.exitCode).toBe(0);
    expect(check.stderr).toContain("CACHE=disabled");
    expect(JSON.parse(check.stdout)).toMatchObject({
      schema: "t3.update-check.v1",
      owner: "standalone",
      coordinated: false,
    });
    expect(yield* fs.exists(`${root}/home`)).toBe(false);
    const globalFlags = yield* run({}, ["--log-level", "debug", "update", "--check", "--json"]);
    expect(globalFlags.exitCode).toBe(0);
    expect(globalFlags.stderr).toContain("CACHE=disabled");
    expect(yield* fs.exists(`${root}/home`)).toBe(false);
    const nested = yield* run({}, ["service", "update", "--check"]);
    expect(nested.stderr.replaceAll("\\", "/")).toContain(
      `CACHE=${root}/cache/t3code/compile-cache`.replaceAll("\\", "/"),
    );
    const pathArgument = yield* run({}, ["--base-dir", "update", "--check"]);
    expect(pathArgument.stderr.replaceAll("\\", "/")).toContain(
      `CACHE=${root}/cache/t3code/compile-cache`.replaceAll("\\", "/"),
    );
    const equalsFlag = yield* run({}, [
      "--log-level=debug",
      "update",
      "--base-dir",
      `${root}/other`,
      "--check",
      "--json",
    ]);
    expect(equalsFlag.stderr).toContain("CACHE=disabled");
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
