import { spawn } from "node:child_process";
import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as Stream from "effect/Stream";
import { PlatformServices } from "@/Util/PlatformServices.ts";
import { nodePath, nodeSupportsDevMode } from "../nodeProbe.ts";

// Use the published bin layout but replace the entry with a real progress
// render, so startup is exercised without credentials or cloud resources.
const runPublishedLauncher = (nodeEnv: string | undefined, jsx?: string, runtime = "bun") =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const packageDir = yield* path.fromFileUrl(new URL("../../", import.meta.url));
    const project = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-launcher-" });
    const installed = path.join(project, "node_modules", "alchemy");
    const bin = path.join(installed, "bin");
    yield* fs.makeDirectory(bin, { recursive: true });
    yield* fs.copyFile(path.join(packageDir, "bin", "cli.js"), path.join(bin, "cli.js"));
    yield* fs.writeFileString(
      path.join(installed, "package.json"),
      JSON.stringify({ type: "module", bin: { alchemy: "./bin/cli.js" } }),
    );
    yield* fs.symlink(path.join(packageDir, "node_modules"), path.join(installed, "node_modules"));
    yield* fs.makeDirectory(path.join(project, "node_modules", ".bin"));
    yield* fs.symlink(
      path.join(bin, "cli.js"),
      path.join(project, "node_modules", ".bin", "alchemy"),
    );
    yield* fs.chmod(path.join(bin, "cli.js"), 0o755);
    const fixture = new URL("./fixtures/launcher-production.tsx", import.meta.url).href;
    yield* fs.writeFileString(
      path.join(bin, "alchemy.js"),
      `await import(${JSON.stringify(fixture)});\n`,
    );
    if (jsx !== undefined) {
      yield* fs.writeFileString(
        path.join(project, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: { jsx, ...(jsx === "preserve" ? { jsxImportSource: "solid-js" } : {}) },
        }),
      );
    }
    const args = ["deploy", "stack.run.ts", "--stage", "test", "--yes"];
    const handle = yield* ChildProcess.make(
      runtime,
      [...(runtime === "bun" ? ["--bun", "alchemy"] : [path.join(bin, "cli.js")]), ...args],
      {
        cwd: project,
        env: {
          NODE_ENV: nodeEnv,
          CI: "true",
          // Mirror `bun run`, which starts node-shebang bins under Node but
          // points npm_execpath at bun.
          npm_execpath: process.execPath,
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
    expect({ exitCode, stderr, failure: exitCode === 0 ? "" : stdout }).toEqual({
      exitCode: 0,
      stderr: "",
      failure: "",
    });
    expect(stdout).toContain("Starting deployment");
    expect(stdout).toContain("Deployment complete");
    expect(stdout).toContain(JSON.stringify({ cwd: yield* fs.realPath(project), args }));
  }).pipe(Effect.scoped, Effect.provide(PlatformServices));

// Run the published launcher under Node with a launcher's environment and
// report which runtime it picked. The entry and loader are stubs, and a fake
// `bun` first on PATH reports the handoff instead of running the CLI.
const launcherRuntime = (
  env: { npm_execpath: string; npm_config_user_agent: string },
  nodeArgs: ReadonlyArray<string> = [],
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const packageDir = yield* path.fromFileUrl(new URL("../../", import.meta.url));
    const project = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-launcher-runtime-" });
    const bin = path.join(project, "node_modules", "alchemy", "bin");
    yield* fs.makeDirectory(bin, { recursive: true });
    yield* fs.copyFile(path.join(packageDir, "bin", "cli.js"), path.join(bin, "cli.js"));
    yield* fs.symlink(
      path.join(packageDir, "node_modules"),
      path.join(project, "node_modules", "alchemy", "node_modules"),
    );
    yield* fs.writeFileString(
      path.join(project, "node_modules", "alchemy", "package.json"),
      JSON.stringify({ type: "module" }),
    );
    yield* fs.writeFileString(path.join(bin, "register-oxc.js"), "");
    yield* fs.writeFileString(path.join(bin, "alchemy.js"), `console.log("node");\n`);
    const fakeBin = path.join(project, "fake-bin");
    yield* fs.makeDirectory(fakeBin);
    const fakeBun = path.join(fakeBin, "bun");
    yield* fs.writeFileString(fakeBun, `#!/bin/sh\necho bun\n`);
    yield* fs.chmod(fakeBun, 0o755);
    const handle = yield* ChildProcess.make(nodePath!, [...nodeArgs, path.join(bin, "cli.js")], {
      cwd: project,
      env: {
        ...env,
        npm_execpath: env.npm_execpath.replace("<fake-bun>", fakeBun),
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      },
      extendEnv: true,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      forceKillAfter: "1 second",
    });
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        handle.stdout.pipe(Stream.decodeText, Stream.mkString),
        handle.stderr.pipe(Stream.decodeText, Stream.mkString),
        handle.exitCode,
      ],
      { concurrency: 3 },
    );
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
    return stdout.trim();
  }).pipe(Effect.scoped, Effect.provide(PlatformServices));

// Environments captured from each launcher in #2000. The user agent names the
// package manager, so only npm_execpath may select bun.
const launchers = [
  {
    name: "nub exec in a bun project",
    npm_execpath: "",
    npm_config_user_agent: "bun/1.4.2 nub/0.9.6 node/v25.6.1 darwin arm64",
    runtime: "node",
  },
  {
    name: "nub run in a bun project",
    npm_execpath: "/opt/homebrew/bin/nub",
    npm_config_user_agent: "bun/1.4.2 nub/0.9.6 node/v25.6.1 darwin arm64",
    runtime: "node",
  },
  {
    name: "npx",
    npm_execpath: "/usr/lib/node_modules/npm/bin/npm-cli.js",
    npm_config_user_agent: "npm/11.9.0 node/v25.6.1 darwin arm64 workspaces/false",
    runtime: "node",
  },
  {
    // A directory named like bun (`/home/ubuntu/`) must not select bun.
    name: "pnpm under /home/ubuntu",
    npm_execpath: "/home/ubuntu/.local/share/pnpm/pnpm.cjs",
    npm_config_user_agent: "pnpm/11.25.0 npm/? node/v24.0.0 linux x64",
    runtime: "node",
  },
  {
    name: "bun run / bunx",
    npm_execpath: "<fake-bun>",
    npm_config_user_agent: "bun/1.4.2 npm/? node/v26.3.0 darwin arm64",
    runtime: "bun",
  },
] as const;

describe.sequential("launcher runtime selection", { tags: ["unit", "local"] }, () => {
  for (const { name, runtime, ...env } of launchers) {
    it.live.skipIf(!nodeSupportsDevMode)(`${name} runs the CLI under ${runtime}`, () =>
      Effect.gen(function* () {
        expect(yield* launcherRuntime(env)).toBe(runtime);
      }),
    );
  }

  it.live.skipIf(!nodeSupportsDevMode)(
    "bun run hands off through a child when this Node has no execve",
    () =>
      Effect.gen(function* () {
        const { runtime: _runtime, name: _name, ...env } = launchers[4];
        const withoutExecve = "data:text/javascript,delete process.execve;";
        expect(yield* launcherRuntime(env, ["--import", withoutExecve])).toBe("bun");
      }),
  );

  it.live.skipIf(!nodeSupportsDevMode)(
    "bun run keeps a parent's IPC channel across the handoff",
    () => launcherRelaysIpc(),
  );
});

// The launcher, forked with an IPC channel the way a supervisor would, must
// still deliver the CLI's messages both ways: `execve` would sever the channel,
// so this path keeps a child and relays. Node's IPC has no Effect surface, so
// the process is driven with `node:child_process` directly.
const launcherRelaysIpc = () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const packageDir = yield* path.fromFileUrl(new URL("../../", import.meta.url));
    const project = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-launcher-ipc-" });
    const bin = path.join(project, "node_modules", "alchemy", "bin");
    yield* fs.makeDirectory(bin, { recursive: true });
    yield* fs.copyFile(path.join(packageDir, "bin", "cli.js"), path.join(bin, "cli.js"));
    yield* fs.symlink(
      path.join(packageDir, "node_modules"),
      path.join(project, "node_modules", "alchemy", "node_modules"),
    );
    yield* fs.writeFileString(
      path.join(project, "node_modules", "alchemy", "package.json"),
      JSON.stringify({ type: "module" }),
    );
    // The CLI entry, as bun would run it: announce readiness over IPC, then
    // echo the one message the parent sends and exit.
    yield* fs.writeFileString(
      path.join(bin, "alchemy.js"),
      [
        "process.send({ ready: true, args: process.argv.slice(2) });",
        'process.once("message", (message) => {',
        "  process.send({ echo: message });",
        "  process.exit(7);",
        "});",
      ].join("\n"),
    );
    const fakeBun = path.join(project, "bun");
    yield* fs.writeFileString(fakeBun, `#!/bin/sh\nexec ${JSON.stringify(nodePath!)} "$@"\n`);
    yield* fs.chmod(fakeBun, 0o755);

    const result = yield* Effect.promise(
      () =>
        new Promise<{ messages: Array<unknown>; exitCode: number | null }>((resolve, reject) => {
          const child = spawn(nodePath!, [path.join(bin, "cli.js"), "deploy", "--yes"], {
            cwd: project,
            env: { ...process.env, npm_execpath: fakeBun, npm_config_user_agent: "bun/1.4.2" },
            stdio: ["ignore", "ignore", "inherit", "ipc"],
          });
          const messages: Array<unknown> = [];
          child.on("message", (message) => {
            messages.push(message);
            if (messages.length === 1) child.send({ hello: "cli" });
          });
          child.on("error", reject);
          child.on("close", (exitCode) => resolve({ messages, exitCode }));
        }),
    );
    expect(result).toEqual({
      messages: [{ ready: true, args: ["deploy", "--yes"] }, { echo: { hello: "cli" } }],
      exitCode: 7,
    });
  }).pipe(Effect.scoped, Effect.provide(PlatformServices));

describe.sequential("published Bun launcher", { tags: ["unit", "local"] }, () => {
  it.live.skipIf(!nodeSupportsDevMode)(
    "renders production progress through the Node shebang handoff",
    () => runPublishedLauncher("development", "preserve", nodePath!),
  );
  for (const nodeEnv of [undefined, "development", "production"]) {
    for (const jsx of [undefined, "react-jsx", "react-jsxdev", "preserve"]) {
      it.live(`renders production progress with NODE_ENV=${nodeEnv} and jsx=${jsx}`, () =>
        runPublishedLauncher(nodeEnv, jsx),
      );
    }
  }
});
