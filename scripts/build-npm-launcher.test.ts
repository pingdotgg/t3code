// @effect-diagnostics nodeBuiltinImport:off - Serves a fake GitHub Release over real HTTP to the published launcher.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@lathe/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeEvents from "node:events";
import * as NodeHttp from "node:http";

import { FORK_IDENTITY } from "@lathe/shared/forkIdentity";
import { npmReleaseDatabaseMigration } from "@lathe/shared/cliRelease";

import { buildNpmLauncher } from "./build-npm-launcher.ts";

const VERSION = "1.2.3";
const decodeManifest = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

const collect = <E>(stream: Stream.Stream<Uint8Array, E>) =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (acc, chunk) => acc + chunk,
    ),
  );

const run = Effect.fn("test.run")(function* (
  command: string,
  args: ReadonlyArray<string>,
  options: { readonly cwd: string; readonly env: Record<string, string | undefined> },
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(
    ChildProcess.make(command, args, { cwd: options.cwd, env: options.env, extendEnv: false }),
  );
  const [stdout, stderr, exitCode] = yield* Effect.all(
    [collect(child.stdout), collect(child.stderr), child.exitCode.pipe(Effect.map(Number))],
    { concurrency: "unbounded" },
  );
  return { stdout, stderr, exitCode };
}, Effect.scoped);

const STUB_EXECUTABLE = `#!/bin/sh
if [ -n "$LATHE_TEST_CALLS" ]; then echo "$*|$LATHE_NPM_LAUNCHER_PATH" >> "$LATHE_TEST_CALLS"; fi
if [ "$1" = "--version" ]; then echo "${VERSION}"; exit 0; fi
echo "stub $* launcher=$LATHE_NPM_LAUNCHER_PATH"
exit 7
`;

// Fork: a release after the Lathe rename lists `lathe-*` archives holding
// `lathe`; one from before it lists `t3-*` holding `t3`.
const serveFakeRelease = Effect.fn("test.serveFakeRelease")(function* (
  root: string,
  release: {
    readonly prefix: string;
    readonly files: Readonly<Record<string, string>>;
  } = { prefix: "lathe", files: { lathe: STUB_EXECUTABLE } },
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const key = `${yield* HostProcess.Platform}-${yield* HostProcess.Architecture}`;
  const stem = `t3-${VERSION}-${key}`;
  const archiveName = `${release.prefix}-${VERSION}-${key}.tar.gz`;
  yield* fs.makeDirectory(path.join(root, "release", stem, "node_modules/native"), {
    recursive: true,
  });
  for (const [name, content] of Object.entries(release.files)) {
    yield* fs.writeFileString(path.join(root, "release", stem, name), content);
    yield* fs.chmod(path.join(root, "release", stem, name), 0o755);
  }
  const tar = yield* run("tar", ["-czf", archiveName, stem], {
    cwd: path.join(root, "release"),
    env: { PATH: (yield* HostProcess.Environment).PATH },
  });
  assert.equal(tar.exitCode, 0, tar.stderr);
  const archive = yield* fs.readFile(path.join(root, "release", archiveName));
  let checksum = NodeCrypto.createHash("sha256").update(archive).digest("hex");
  const requests: Array<string> = [];
  const failures: Array<number> = [];
  const server = NodeHttp.createServer((request, response) => {
    requests.push(request.url ?? "");
    const failure = failures.shift();
    if (failure !== undefined) {
      response.writeHead(failure).end("upstream timed out");
    } else if (request.url === `/v${VERSION}/SHA256SUMS`) {
      response.end(`${checksum}  ${archiveName}\n`);
    } else if (request.url === `/v${VERSION}/${archiveName}`) {
      response.writeHead(200, { "Content-Length": archive.length }).end(archive);
    } else {
      response.writeHead(404).end();
    }
  });
  yield* Effect.acquireRelease(
    Effect.callback<void>((resume) => {
      server.listen(0, "127.0.0.1", () => resume(Effect.void));
    }),
    () =>
      Effect.callback<void>((resume) => {
        server.close(() => resume(Effect.void));
      }),
  );
  const address = server.address();
  if (address === null || typeof address === "string") return yield* Effect.die("no TCP address");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    corruptChecksum: () => {
      checksum = "0".repeat(64);
    },
    failNextRequests: (...statuses: Array<number>) => {
      failures.push(...statuses);
    },
  };
});

it.layer(NodeServices.layer)("build-npm-launcher", (it) => {
  it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "publishes a launcher that downloads, verifies, caches, and runs the release executable",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "lathe-npm-launcher-test-" });
        const output = yield* buildNpmLauncher({
          version: VERSION,
          outputDir: path.join(root, "out"),
        });

        const manifest = yield* decodeManifest(
          yield* fs.readFileString(path.join(output.packageDir, "package.json")),
        );
        assert.equal(manifest.name, FORK_IDENTITY.npmPackageName);
        assert.equal(manifest.version, VERSION);
        assert.deepStrictEqual(manifest.bin, { lathe: "./bin/lathe.mjs" });
        assert.isUndefined(manifest.dependencies);
        assert.isUndefined(manifest.optionalDependencies);
        assert.isAbove(npmReleaseDatabaseMigration(manifest) ?? 0, 0);

        const installed = path.join(root, "installed");
        yield* fs.makeDirectory(installed);
        const unpack = yield* run("tar", ["-xzf", output.tarball, "-C", installed], {
          cwd: root,
          env: { PATH: (yield* HostProcess.Environment).PATH },
        });
        assert.equal(unpack.exitCode, 0, unpack.stderr);
        const packageDir = path.join(installed, "package");

        const release = yield* serveFakeRelease(root);
        // regression: #32897
        release.failNextRequests(504, 524);
        const home = path.join(root, "home");
        const env = {
          PATH: (yield* HostProcess.Environment).PATH,
          LATHE_HOME: home,
          LATHE_TEST_CALLS: path.join(root, "calls"),
          LATHE_RELEASE_BASE_URL: release.baseUrl,
        };
        const launcher = path.join(packageDir, "bin/lathe.mjs");
        const first = yield* run(process.execPath, [launcher, "serve", "a b"], {
          cwd: root,
          env,
        });
        assert.equal(first.stdout.trim(), `stub serve a b launcher=${launcher}`, first.stderr);
        assert.equal(first.exitCode, 7);
        assert.deepStrictEqual(
          (yield* fs.readFileString(env.LATHE_TEST_CALLS)).trim().split("\n"),
          ["--version|", `serve a b|${launcher}`],
        );
        const versionDir = path.join(home, "runtime/versions", VERSION);
        assert.equal(
          (yield* fs.readFileString(path.join(versionDir, ".install-complete"))).trim(),
          VERSION,
        );
        assert.isTrue(yield* fs.exists(path.join(versionDir, "node_modules/native")));
        assert.deepStrictEqual(
          (yield* fs.readDirectory(path.join(home, "runtime/versions"))).sort(),
          [VERSION],
        );

        const requestsAfterFirst = release.requests.length;
        const second = yield* run(process.execPath, [launcher, "--version"], { cwd: root, env });
        assert.equal(second.exitCode, 0);
        assert.equal(release.requests.length, requestsAfterFirst);
        assert.deepStrictEqual(
          (yield* fs.readFileString(env.LATHE_TEST_CALLS)).trim().split("\n"),
          ["--version|", `serve a b|${launcher}`, `--version|${launcher}`],
        );

        yield* fs.writeFileString(path.join(versionDir, "lathe"), "#!/lathe-test-missing-loader\n");
        for (const _attempt of [1, 2]) {
          const cached = yield* run(process.execPath, [launcher, "serve"], { cwd: root, env });
          assert.equal(cached.exitCode, 1, cached.stderr);
          assert.include(cached.stderr, "could not run");
          assert.equal(release.requests.length, requestsAfterFirst);
          assert.equal(
            yield* fs.readFileString(path.join(versionDir, ".install-complete")),
            `${VERSION}\n`,
          );
        }

        const ipcServer = path.join(home, "runtime/versions", VERSION, "lathe");
        yield* fs.writeFileString(
          ipcServer,
          `#!${process.execPath}\nprocess.on("SIGTERM", () => process.exit(23));\nprocess.on("message", (m) => process.send({ reply: m }));\nprocess.send({ args: process.argv.slice(2) });\n`,
        );
        const legacy = NodeChildProcess.fork(
          path.join(packageDir, "dist/bin.mjs"),
          ["__service-preflight", "a b"],
          { env, silent: true },
        );
        yield* Effect.promise(async () => {
          assert.deepStrictEqual((await NodeEvents.EventEmitter.once(legacy, "message"))[0], {
            args: ["__service-preflight", "a b"],
          });
          const reply = NodeEvents.EventEmitter.once(legacy, "message");
          legacy.send({ type: "trial-accepted" });
          assert.deepStrictEqual((await reply)[0], { reply: { type: "trial-accepted" } });
          const exit = NodeEvents.EventEmitter.once(legacy, "exit");
          legacy.kill("SIGTERM");
          assert.deepStrictEqual(await exit, [23, null]);
        });

        const raceHome = path.join(root, "race-home");
        const launch = run(process.execPath, [launcher, "--version"], {
          cwd: root,
          env: { ...env, LATHE_HOME: raceHome },
        });
        const [one, two] = yield* Effect.all([launch, launch], { concurrency: "unbounded" });
        assert.equal(one.exitCode, 0, one.stderr);
        assert.equal(two.exitCode, 0, two.stderr);
        assert.deepStrictEqual(yield* fs.readDirectory(path.join(raceHome, "runtime/versions")), [
          VERSION,
        ]);

        // A peer's executable and sidecar stay available after every later rename or removal,
        // even when it publishes after our missing-marker read.
        const staleHome = path.join(root, "stale-home");
        const staleDir = path.join(staleHome, "runtime/versions", VERSION);
        const peerDir = path.join(root, "peer-runtime");
        yield* fs.makeDirectory(staleDir, { recursive: true });
        yield* fs.writeFileString(path.join(staleDir, "t3"), "");
        yield* fs.makeDirectory(peerDir);
        yield* fs.writeFileString(path.join(peerDir, "t3"), '#!/bin/sh\necho "peer $*"\nexit 7\n');
        yield* fs.chmod(path.join(peerDir, "t3"), 0o755);
        yield* fs.writeFileString(path.join(peerDir, ".install-complete"), `${VERSION}\n`);
        yield* fs.writeFileString(path.join(peerDir, "sidecar"), "peer sidecar");
        const peerChecks = path.join(root, "peer-checks.txt");
        // The peer publishes after the launcher's rename fails and it reads the marker.
        const peerHook = path.join(root, "peer-publishes.mjs");
        yield* fs.writeFileString(
          peerHook,
          `import fs from "node:fs";
import { spawnSync } from "node:child_process";
const dir = ${JSON.stringify(staleDir)};
const { readFileSync, renameSync, rmSync } = fs;
let checking = false;
let published = false;
const checkPeer = () => {
  const child = spawnSync(dir + "/t3", ["--version"], { encoding: "utf8" });
  let sidecar;
  try {
    sidecar = readFileSync(dir + "/sidecar", "utf8");
  } catch (error) {
    sidecar = error.code;
  }
  fs.appendFileSync(${JSON.stringify(peerChecks)},
    [child.status, child.error?.code ?? child.stdout.trim(), sidecar].join("|") + "\\n");
};
fs.renameSync = (from, to) => {
  try {
    return renameSync(from, to);
  } catch (error) {
    checking ||= to === dir;
    throw error;
  } finally {
    if (published) checkPeer();
  }
};
fs.rmSync = (...args) => {
  try {
    return rmSync(...args);
  } finally {
    if (published) checkPeer();
  }
};
fs.readFileSync = (file, ...rest) => {
  try {
    return readFileSync(file, ...rest);
  } finally {
    if (checking && file === dir + "/.install-complete") {
      checking = false;
      rmSync(dir, { recursive: true });
      renameSync(${JSON.stringify(peerDir)}, dir);
      published = true;
      checkPeer();
    }
  }
};
`,
        );
        const recovered = yield* run(
          process.execPath,
          ["--import", peerHook, launcher, "--version"],
          { cwd: root, env: { ...env, LATHE_HOME: staleHome } },
        );
        const checks = (yield* fs.readFileString(peerChecks)).trim().split("\n");
        assert.isAtLeast(checks.length, 2);
        assert.deepStrictEqual([...new Set(checks)], ["7|peer --version|peer sidecar"]);
        assert.equal(recovered.stdout.trim(), "peer --version", recovered.stderr);
        assert.equal(recovered.exitCode, 7);
        assert.deepStrictEqual(yield* fs.readDirectory(path.join(staleHome, "runtime/versions")), [
          VERSION,
        ]);

        // While another launch holds the lock, a stale folder is left alone and the error says
        // how to clear a lock left by a crash.
        const staleOnlyHome = path.join(root, "stale-only-home");
        const staleOnlyDir = path.join(staleOnlyHome, "runtime/versions", VERSION);
        yield* fs.makeDirectory(staleOnlyDir, { recursive: true });
        yield* fs.writeFileString(path.join(staleOnlyDir, "t3"), "incomplete");
        yield* fs.makeDirectory(`${staleOnlyDir}.lock`);
        const locked = yield* run(process.execPath, [launcher, "--version"], {
          cwd: root,
          env: { ...env, LATHE_HOME: staleOnlyHome },
        });
        assert.equal(locked.exitCode, 1);
        assert.include(locked.stderr, `delete ${staleOnlyDir}.lock`);
        assert.equal(yield* fs.readFileString(path.join(staleOnlyDir, "t3")), "incomplete");

        // Without a peer, the stale folder is replaced by our own download.
        yield* fs.remove(`${staleOnlyDir}.lock`, { recursive: true });
        const replaced = yield* run(process.execPath, [launcher, "--version"], {
          cwd: root,
          env: { ...env, LATHE_HOME: staleOnlyHome },
        });
        assert.equal(replaced.stdout.trim(), VERSION, replaced.stderr);
        assert.equal(replaced.exitCode, 0);
        assert.deepStrictEqual(
          yield* fs.readDirectory(path.join(staleOnlyHome, "runtime/versions")),
          [VERSION],
        );

        release.corruptChecksum();
        const corrupt = yield* run(process.execPath, [launcher, "--version"], {
          cwd: root,
          env: { ...env, LATHE_HOME: path.join(root, "other-home") },
        });
        assert.equal(corrupt.exitCode, 1);
        assert.include(corrupt.stderr, "checksum mismatch");
        assert.deepStrictEqual(
          yield* fs.readDirectory(path.join(root, "other-home/runtime/versions")),
          [],
        );
      }),
  );
  it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "does not publish an unusable release",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        for (const executable of [
          "#!/lathe-test-missing-loader\n",
          '#!/bin/sh\necho "runtime loader failed" >&2\nexit 42\n',
          "#!/bin/sh\nkill -TERM $$\n",
          '#!/bin/sh\ntrap \'echo caught > "$LATHE_TEST_TERM"; exit 42\' TERM\necho ready > "$LATHE_TEST_READY"\nwhile :; do :; done\n',
        ]) {
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "lathe-npm-validation-test-" });
          const output = yield* buildNpmLauncher({
            version: VERSION,
            outputDir: path.join(root, "out"),
          });
          const release = yield* serveFakeRelease(root, {
            prefix: "lathe",
            files: { lathe: executable },
          });
          const home = path.join(root, "home");
          const dir = path.join(home, "runtime/versions", VERSION);
          const probeTimeoutHook = path.join(root, "probe-timeout.mjs");
          yield* fs.writeFileString(
            probeTimeoutHook,
            `import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
const { spawnSync } = childProcess;
childProcess.spawnSync = (command, args, options) => spawnSync(command, args,
  options?.timeout === undefined ? options : { ...options, timeout: 500 });
syncBuiltinESMExports();
`,
          );
          const env = {
            PATH: (yield* HostProcess.Environment).PATH,
            LATHE_HOME: home,
            LATHE_RELEASE_BASE_URL: release.baseUrl,
            LATHE_TEST_READY: path.join(root, "probe-ready"),
            LATHE_TEST_TERM: path.join(root, "probe-term"),
          };
          const launcher = path.join(output.packageDir, "bin/lathe.mjs");
          const failed = yield* run(
            process.execPath,
            ["--import", probeTimeoutHook, launcher, "serve"],
            { cwd: root, env },
          );
          assert.equal(failed.exitCode, 1, failed.stderr);
          assert.deepStrictEqual(yield* fs.readDirectory(path.dirname(dir)), [], failed.stderr);
          assert.include(failed.stderr, "could not run");
          if (executable.includes("runtime loader failed")) {
            assert.include(failed.stderr, "runtime loader failed");
          }
          if (executable.includes("trap")) {
            assert.isTrue(yield* fs.exists(env.LATHE_TEST_READY));
            assert.isFalse(yield* fs.exists(env.LATHE_TEST_TERM));
          }
          if ((yield* HostProcess.Platform) === "linux") {
            assert.include(failed.stderr, "glibc");
            assert.include(failed.stderr, "musl");
          }
        }
      }),
  );

  it.effect("carries the fork identity the published script cannot import", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const source = yield* fs.readFileString(
        path.join(
          yield* path.fromFileUrl(new URL("./npm-launcher/", import.meta.url)),
          "lathe.mjs",
        ),
      );
      assert.include(
        source,
        `"https://github.com/${FORK_IDENTITY.releaseRepository}/releases/download"`,
      );
      assert.include(source, `"${FORK_IDENTITY.baseDirName}"`);
      assert.include(source, `"${FORK_IDENTITY.legacyBaseDirName}"`);
      assert.include(source, `const CLI_NAMES = ["${FORK_IDENTITY.cliBin}", "t3"];`);
      assert.notInclude(source, "pingdotgg");
    }),
  );

  /** Builds the launcher and unpacks it the way npm installs it; returns its bin script. */
  const installLauncher = Effect.fn("test.installLauncher")(function* (root: string) {
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const output = yield* buildNpmLauncher({ version: VERSION, outputDir: path.join(root, "out") });
    const installed = path.join(root, "installed");
    yield* fs.makeDirectory(installed);
    const unpack = yield* run("tar", ["-xzf", output.tarball, "-C", installed], {
      cwd: root,
      env: { PATH: (yield* HostProcess.Environment).PATH },
    });
    assert.equal(unpack.exitCode, 0, unpack.stderr);
    return path.join(installed, "package/bin/lathe.mjs");
  });

  it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "installs and runs a release from before the Lathe rename",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "lathe-npm-launcher-test-" });
        const launcher = yield* installLauncher(root);
        const release = yield* serveFakeRelease(root, {
          prefix: "t3",
          files: { t3: STUB_EXECUTABLE },
        });
        const result = yield* run(process.execPath, [launcher, "serve"], {
          cwd: root,
          env: {
            PATH: (yield* HostProcess.Environment).PATH,
            LATHE_HOME: path.join(root, "home"),
            LATHE_RELEASE_BASE_URL: release.baseUrl,
          },
        });
        assert.equal(result.stdout.trim(), `stub serve launcher=${launcher}`, result.stderr);
        assert.equal(result.exitCode, 7);
      }),
  );

  it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "runs the bundle with the host Node when the executable cannot start",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "lathe-npm-launcher-test-" });
        const launcher = yield* installLauncher(root);
        // An interpreter that does not exist fails exec with ENOENT, as a
        // glibc executable does on NixOS.
        const release = yield* serveFakeRelease(root, {
          prefix: "lathe",
          files: {
            lathe: "#!/nonexistent/interpreter\n",
            "bin.mjs":
              'if (process.argv[2] === "--version") process.exit(0);\nconsole.log("bundle", process.argv.slice(2).join(" "));\nprocess.exit(9);\n',
          },
        });
        const result = yield* run(process.execPath, [launcher, "serve", "a b"], {
          cwd: root,
          env: {
            PATH: (yield* HostProcess.Environment).PATH,
            LATHE_HOME: path.join(root, "home"),
            LATHE_RELEASE_BASE_URL: release.baseUrl,
          },
        });
        assert.equal(result.stdout.trim(), "bundle serve a b", result.stderr);
        assert.equal(result.exitCode, 9);
      }),
  );

  it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "keeps a pre-rename .t3f home in use and otherwise installs into .lathe",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "lathe-npm-launcher-test-" });
        const launcher = yield* installLauncher(root);
        const release = yield* serveFakeRelease(root);
        const PATH = (yield* HostProcess.Environment).PATH;
        const launchWithHome = (home: string) =>
          run(process.execPath, [launcher, "--version"], {
            cwd: root,
            env: { PATH, HOME: home, LATHE_RELEASE_BASE_URL: release.baseUrl },
          });

        const fresh = path.join(root, "fresh");
        yield* fs.makeDirectory(fresh);
        assert.equal((yield* launchWithHome(fresh)).exitCode, 0);
        assert.isTrue(yield* fs.exists(path.join(fresh, ".lathe/runtime/versions", VERSION)));

        const legacy = path.join(root, "legacy");
        yield* fs.makeDirectory(path.join(legacy, ".t3f"), { recursive: true });
        assert.equal((yield* launchWithHome(legacy)).exitCode, 0);
        assert.isTrue(yield* fs.exists(path.join(legacy, ".t3f/runtime/versions", VERSION)));
        assert.isFalse(yield* fs.exists(path.join(legacy, ".lathe")));
      }),
  );

  it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "kills a runtime that ignores the forwarded SIGTERM, and its providers, so the launcher exits",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "lathe-npm-launcher-test-" });
        const output = yield* buildNpmLauncher({
          version: VERSION,
          outputDir: path.join(root, "out"),
        });
        const hostPath = (yield* HostProcess.Environment).PATH;
        const installed = path.join(root, "installed");
        yield* fs.makeDirectory(installed);
        const unpack = yield* run("tar", ["-xzf", output.tarball, "-C", installed], {
          cwd: root,
          env: { PATH: hostPath },
        });
        assert.equal(unpack.exitCode, 0, unpack.stderr);

        const home = path.join(root, "home");
        const versionDir = path.join(home, "runtime/versions", VERSION);
        yield* fs.makeDirectory(versionDir, { recursive: true });
        yield* fs.writeFileString(path.join(versionDir, ".install-complete"), `${VERSION}\n`);
        // Stands in for a runtime whose exit is stuck behind blocked filesystem calls, with a
        // provider it never gets to stop. Both give up on their own well inside the project
        // timeout so an unescalated stop fails descriptively.
        const stuck = "runtime ignored SIGTERM and was still running 30s later";
        const orphaned = "provider outlived the runtime by 30s";
        const provider = `process.on("SIGTERM", () => {}); setTimeout(() => { console.log(${JSON.stringify(orphaned)}); process.exit(0); }, 30_000);`;
        yield* fs.writeFileString(
          path.join(versionDir, "t3"),
          `#!${process.execPath}
const provider = require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(provider)}], { stdio: "inherit" });
process.on("SIGTERM", () => setTimeout(() => { console.log(${JSON.stringify(stuck)}); process.exit(0); }, 30_000));
setInterval(() => {}, 1 << 30);
console.log(process.pid, provider.pid);
`,
        );
        yield* fs.chmod(path.join(versionDir, "t3"), 0o755);

        const launcher = NodeChildProcess.spawn(
          process.execPath,
          [path.join(installed, "package/bin/lathe.mjs"), "serve"],
          { cwd: root, env: { PATH: hostPath, LATHE_HOME: home }, stdio: "pipe" },
        );
        let pids: Array<number> = [];
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            for (const pid of [...pids, launcher.pid]) {
              try {
                if (pid !== undefined) process.kill(pid, "SIGKILL");
              } catch {}
            }
          }),
        );
        let stdout = "";
        const started = Promise.withResolvers<void>();
        launcher.stdout.setEncoding("utf8");
        launcher.stdout.on("data", (chunk: string) => {
          stdout += chunk;
          if (stdout.includes("\n")) started.resolve();
        });
        // The runtime and provider inherit this pipe, so it closes only once all three are gone.
        const closed = NodeEvents.EventEmitter.once(launcher.stdout, "close");
        yield* Effect.promise(() => started.promise);
        pids = stdout.trim().split(" ").map(Number);
        assert.isTrue(pids.length === 2 && pids.every(Number.isInteger), stdout);

        launcher.kill("SIGTERM");
        yield* Effect.promise(() => closed);
        assert.notInclude(stdout, stuck, "the launcher waited on a runtime that ignored SIGTERM");
        assert.notInclude(stdout, orphaned, "the runtime's provider outlived the launcher");
      }),
  );
});
