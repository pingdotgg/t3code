import { PlatformServices } from "@/Util/PlatformServices.ts";
import { describe, expect, it } from "alchemy-test";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";

const tarball = process.env.ALCHEMY_CLI_PACKAGE;
const tarballDirectory = process.env.ALCHEMY_CLI_PACKAGES;
const enabled = !!(tarball || tarballDirectory);
const selectedManager = process.env.ALCHEMY_CLI_PACKAGE_MANAGER;
const managers = ["npm", "pnpm", "bun"] as const;
type Manager = (typeof managers)[number];

interface Invocation {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly runtime: "bun" | "node";
}

const invocations = (manager: Manager): ReadonlyArray<Invocation> => [
  {
    command: "node",
    args: ["node_modules/alchemy/bin/cli.js"],
    runtime: "node",
  },
  { command: "bun", args: ["node_modules/alchemy/bin/cli.js"], runtime: "bun" },
  { command: "bun", args: ["--bun", "alchemy"], runtime: "bun" },
  {
    command: "bun",
    args: ["x", "--bun", "--no-install", "alchemy"],
    runtime: "bun",
  },
  ...packageCommands[manager],
];

const packageCommands: Record<Manager, ReadonlyArray<Invocation>> = {
  npm: [
    { command: "npm", args: ["run", "cli", "--"], runtime: "node" },
    {
      command: "npm",
      args: ["exec", "--offline", "--", "alchemy"],
      runtime: "node",
    },
    { command: "npx", args: ["--no-install", "alchemy"], runtime: "node" },
  ],
  pnpm: [
    { command: "pnpm", args: ["run", "cli"], runtime: "node" },
    { command: "pnpm", args: ["exec", "alchemy"], runtime: "node" },
    { command: "pnpm", args: ["alchemy"], runtime: "node" },
  ],
  bun: [
    { command: "bun", args: ["run", "cli"], runtime: "bun" },
    { command: "bun", args: ["run", "--bun", "cli"], runtime: "bun" },
    { command: "bun", args: ["alchemy"], runtime: "bun" },
  ],
};

const Probe = Schema.fromJsonString(
  Schema.Struct({
    runtime: Schema.String,
    nodeEnv: Schema.String,
    home: Schema.String,
    credentialVariables: Schema.Array(Schema.String),
    cwd: Schema.String,
    entry: Schema.String,
    alchemy: Schema.String,
    args: Schema.Array(Schema.String),
  }),
);

const canary = (manager: Manager) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const packageDir = yield* path.fromFileUrl(
      new URL("../../", import.meta.url),
    );
    const checkout = yield* fs.realPath(path.resolve(packageDir, "../.."));
    const project = yield* fs.makeTempDirectoryScoped({
      prefix: `alchemy-package-${manager}-`,
    });
    const projectRoot = yield* fs.realPath(project);
    expect(projectRoot.startsWith(`${checkout}${path.sep}`)).toBe(false);

    const dependencies: Record<string, string> = {};
    for (const name of [
      "effect",
      "@effect/platform-bun",
      "@effect/platform-node",
    ]) {
      const manifest = yield* fs.readFileString(
        path.join(packageDir, "node_modules", name, "package.json"),
      );
      const { version } = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(Schema.Struct({ version: Schema.String })),
      )(manifest);
      dependencies[name] = version;
    }
    yield* fs.copyFile(
      path.join(packageDir, "test/Cli/fixtures/package-stack.ts"),
      path.join(project, "stack.run.ts"),
    );
    const inherited = yield* Effect.sync(() => process.env);
    const home = path.join(projectRoot, "home");
    yield* fs.makeDirectory(home);
    for (const config of [".npmrc", "global.npmrc"]) {
      yield* fs.writeFileString(path.join(home, config), "");
    }
    // Pass only runtime paths and temporary directories, never the caller's
    // credentials, module hooks, registry configuration, or user profiles.
    const env = {
      CI: "true",
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: path.join(home, ".config"),
      npm_config_userconfig: path.join(home, ".npmrc"),
      npm_config_globalconfig: path.join(home, "global.npmrc"),
      TMPDIR: inherited.TMPDIR,
      TMP: inherited.TMP,
      TEMP: inherited.TEMP,
      SystemRoot: inherited.SystemRoot,
      COMSPEC: inherited.COMSPEC,
      PATHEXT: inherited.PATHEXT,
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
      ALCHEMY_HOME: path.join(home, ".alchemy"),
      PATH: inherited.PATH?.split(process.platform === "win32" ? ";" : ":")
        .filter((part) => !part.startsWith(checkout))
        .join(process.platform === "win32" ? ";" : ":"),
    };
    const run = (
      command: string,
      args: ReadonlyArray<string>,
      nodeEnv?: string,
      installing = false,
    ) =>
      Effect.gen(function* () {
        yield* Console.log(
          `${manager}: ${command} ${args.join(" ")} (NODE_ENV=${nodeEnv ?? "unset"})`,
        );
        const handle = yield* ChildProcess.make(command, args, {
          cwd: project,
          env: { ...env, NODE_ENV: nodeEnv },
          extendEnv: false,
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
        return { stdout, stderr, exitCode };
      }).pipe(
        Effect.scoped,
        Effect.timeout(installing ? "90 seconds" : "20 seconds"),
      );

    const packedFiles = tarballDirectory
      ? (yield* fs.readDirectory(path.resolve(tarballDirectory)))
          .filter((name) => name.endsWith(".tgz"))
          .map((name) => path.resolve(tarballDirectory, name))
      : [path.resolve(tarball!)];
    const overrides: Record<string, string> = {};
    for (const packed of packedFiles) {
      expect((yield* fs.stat(packed)).type).toBe("File");
      const manifest = yield* run("tar", [
        "-xOf",
        packed,
        "package/package.json",
      ]);
      expect(manifest.exitCode).toBe(0);
      const { name } = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(Schema.Struct({ name: Schema.String })),
      )(manifest.stdout);
      dependencies[name] = `file:${packed}`;
      if (name !== "alchemy") overrides[name] = dependencies[name];
    }
    expect(dependencies.alchemy).toBeDefined();
    yield* fs.writeFileString(
      path.join(project, "package.json"),
      JSON.stringify({
        name: "alchemy-cli-package-canary",
        private: true,
        type: "module",
        scripts: { cli: "alchemy" },
        dependencies,
        overrides:
          manager === "npm"
            ? Object.fromEntries(
                Object.keys(overrides).map((name) => [name, `$${name}`]),
              )
            : overrides,
      }),
    );
    if (manager === "pnpm") {
      yield* fs.writeFileString(
        path.join(project, "pnpm-workspace.yaml"),
        JSON.stringify({
          allowBuilds: { esbuild: true, workerd: true },
          overrides,
        }),
      );
    }
    const installed = yield* run(
      manager,
      manager === "npm"
        ? ["install", "--no-audit", "--no-fund"]
        : manager === "bun"
          ? ["install", "--minimum-release-age=0"]
          : ["install"],
      undefined,
      true,
    );
    if (installed.exitCode !== 0) {
      yield* Console.error(installed.stdout + installed.stderr);
    }
    expect({
      code: installed.exitCode,
      output:
        installed.exitCode === 0 ? "" : installed.stdout + installed.stderr,
    }).toEqual({ code: 0, output: "" });
    for (const name of Object.keys(dependencies)) {
      const resolved = yield* fs.realPath(
        path.join(project, "node_modules", name),
      );
      expect(resolved.startsWith(`${projectRoot}${path.sep}`)).toBe(true);
    }
    for (const scenario of [
      { nodeEnv: undefined, jsx: undefined },
      { nodeEnv: "development", jsx: "react-jsxdev" },
      { nodeEnv: "production", jsx: "preserve" },
    ]) {
      if (scenario.jsx !== undefined) {
        yield* fs.writeFileString(
          path.join(project, "tsconfig.json"),
          JSON.stringify({
            compilerOptions: {
              jsx: scenario.jsx,
              ...(scenario.jsx === "preserve"
                ? { jsxImportSource: "solid-js" }
                : {}),
            },
          }),
        );
      }
      for (const invocation of invocations(manager)) {
        const args = ["deploy", "stack.run.ts", "--stage", "canary", "--yes"];
        const result = yield* run(
          invocation.command,
          [...invocation.args, ...args],
          scenario.nodeEnv,
        );
        expect({
          code: result.exitCode,
          output: result.exitCode === 0 ? "" : result.stdout + result.stderr,
        }).toEqual({ code: 0, output: "" });
        expect(result.stdout).toContain("Packed CLI progress");
        expect(result.stdout).toContain("Packed CLI deployment complete");
        const line = result.stdout
          .split("\n")
          .find((line) => line.startsWith("CLI_PACKAGE_PROBE="));
        expect(line).toBeDefined();
        const probe = yield* Schema.decodeUnknownEffect(Probe)(
          line!.slice("CLI_PACKAGE_PROBE=".length),
        );
        expect(probe.runtime).toBe(invocation.runtime);
        expect(probe.nodeEnv).toBe("production");
        expect(probe.home).toBe(home);
        expect(probe.credentialVariables).toEqual([]);
        expect(probe.cwd).toBe(projectRoot);
        expect(probe.args).toEqual(args);
        const entry = yield* fs.realPath(probe.entry);
        const imported = yield* fs.realPath(
          yield* path.fromFileUrl(new URL(probe.alchemy)),
        );
        expect(
          entry.startsWith(`${projectRoot}${path.sep}node_modules${path.sep}`),
        ).toBe(true);
        expect(
          imported.startsWith(
            `${projectRoot}${path.sep}node_modules${path.sep}`,
          ),
        ).toBe(true);
      }
    }
    for (const invocation of invocations(manager)) {
      const result = yield* run(
        invocation.command,
        [...invocation.args, "profile"],
        "development",
      );
      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).not.toContain("jsxDEV");
    }
    const destroyed = yield* run("bun", [
      "--bun",
      "alchemy",
      "destroy",
      "stack.run.ts",
      "--stage",
      "canary",
      "--yes",
    ]);
    expect({
      code: destroyed.exitCode,
      output:
        destroyed.exitCode === 0 ? "" : destroyed.stdout + destroyed.stderr,
    }).toEqual({ code: 0, output: "" });
  }).pipe(Effect.scoped, Effect.provide(PlatformServices));

describe.sequential(
  "packed CLI outside the checkout",
  { tags: ["live"] },
  () => {
    if (
      enabled &&
      selectedManager !== undefined &&
      !managers.some((manager) => manager === selectedManager)
    ) {
      throw new Error(
        `Unknown ALCHEMY_CLI_PACKAGE_MANAGER: ${selectedManager}`,
      );
    }
    for (const manager of managers) {
      it.live.skipIf(
        !enabled ||
          (selectedManager !== undefined && selectedManager !== manager),
      )(
        `installs with ${manager} and runs production CLI across runtimes and entrypoints`,
        () => canary(manager),
        { timeout: 120_000 },
      );
    }
  },
);
